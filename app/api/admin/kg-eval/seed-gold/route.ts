import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/app/lib/supabase';
import { GoogleGenAI } from '@google/genai';
import { requireAdmin } from '@/app/lib/auth';
import { serverError } from '@/app/lib/api-helpers';
import {
  resolveOntologyForTags,
  buildDomainPromptAddendum,
  DOMAIN_ONTOLOGIES,
} from '@/app/lib/kg-ontologies';
import type { EvalEntity, EvalRelation } from '@/app/lib/kg-eval';

// ============================================================
// POST /api/admin/kg-eval/seed-gold
// Генерирует псевдо-эталон (gold) через сильную модель (Gemini 3 Pro
// по умолчанию) и записывает в kg_eval_gold. Эксперты при желании
// могут позднее править записи вручную — колонка `source` отличает
// auto-seed от ручной разметки.
//
// Body:
//   perDomain?:    number   — сколько чанков брать из каждого домена (default 10, max 50)
//   goldModel?:    string   — модель для генерации эталона (default gemini-3-pro-preview)
//   domains?:      string[] — ограничить список доменов (default — все)
//   overwrite?:    boolean  — перезаписывать существующие auto-seed записи (default false)
//   notes?:        string   — заметка, проставится всем новым строкам
// ============================================================

const DEFAULT_GOLD_MODEL = 'gemini-3-pro-preview';

const GOLD_PROMPT = `Ты — эксперт-разметчик для создания эталонного датасета извлечения сущностей и связей.

Извлеки из текста ВСЕ именованные сущности и ВСЕ связи между ними с максимальной точностью.
Это эталон для оценки качества других моделей — будь максимально полным и аккуратным.

ТИПЫ СУЩНОСТЕЙ:
- standard: стандарты (ГОСТ, СТО, РД, ОСТ, ТУ с номерами)
- branch: филиалы СГК
- mtr_type: виды МТР
- procedure: процедуры закупок
- system: информационные системы
- organization: организации, подразделения, контрагенты
- document: названия документов, регламентов, положений
- role: должности и роли
- threshold: пороговые значения
- concept: ключевые понятия
- regulation: нормативные акты
- section: пункты/разделы документов
- contract_party: сторона договора (Заказчик/Исполнитель/Поставщик)
- obligation: обязательство в договоре
- approval_level: уровень согласования

ТИПЫ СВЯЗЕЙ:
defines, references, requires, governs, part_of, belongs_to, supersedes,
amends, sets_threshold, restricts, delegates_to, requires_approval,
party_of, obliged_to, penalized_by, approves, escalates_to.

СТРОГИЕ ПРАВИЛА:
1. Извлекай ТОЛЬКО сущности, ЯВНО упомянутые в тексте — ни одной придуманной.
2. Не дублируй сущности (один объект = одна запись).
3. Каждая связь должна соединять ДВЕ извлечённые сущности (по точным именам).
4. Имя сущности — как оно написано в тексте, без искажений.
5. Если сомневаешься — не добавляй.

Верни строго JSON:
{"entities":[{"name":"...","type":"...","description":"..."}],
 "relations":[{"source":"...","target":"...","type":"..."}]}`;

interface CandidateChunk {
  id: number;
  content: string;
  tags: string[] | null;
}

interface SeedStats {
  domain: string;
  planned: number;
  extracted: number;
  skipped: number;
  failed: number;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => ({}));
    const perDomain = Math.min(Math.max(Number(body.perDomain) || 10, 1), 50);
    const goldModel: string =
      typeof body.goldModel === 'string' && body.goldModel.trim()
        ? body.goldModel.trim()
        : DEFAULT_GOLD_MODEL;
    const overwrite: boolean = Boolean(body.overwrite);
    const notes: string = typeof body.notes === 'string' ? body.notes : '';
    const requestedDomains: string[] | null =
      Array.isArray(body.domains) && body.domains.length
        ? body.domains.map((d: unknown) => String(d).toLowerCase())
        : null;

    const supabase = createServiceClient();
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

    // Берём все онтологии (или подмножество). Для каждой — случайная
    // выборка чанков с matching-тегом.
    const ontologies = DOMAIN_ONTOLOGIES.filter(
      o => !requestedDomains || requestedDomains.includes(o.name),
    );

    if (ontologies.length === 0) {
      return NextResponse.json(
        { message: 'Нет доменов для seed (проверь параметр domains)' },
        { status: 400 },
      );
    }

    const stats: SeedStats[] = [];
    let totalInserted = 0;

    for (const ont of ontologies) {
      const stat: SeedStats = {
        domain: ont.name,
        planned: 0,
        extracted: 0,
        skipped: 0,
        failed: 0,
      };

      // 1. Выбираем чанки с любым из тегов онтологии. Используем
      // overlap-оператор через .overlaps() для массива tags.
      const { data: chunksRaw, error: chErr } = await supabase
        .from('chunks')
        .select('id, content, tags')
        .overlaps('tags', ont.tags as unknown as string[])
        .not('content', 'is', null)
        .limit(perDomain * 4); // берём с запасом, отфильтруем коротыши

      if (chErr) {
        console.error(`[seed-gold] chunks query failed for ${ont.name}:`, chErr);
        stats.push(stat);
        continue;
      }

      const candidates = ((chunksRaw || []) as CandidateChunk[])
        .filter(c => c.content && c.content.trim().length >= 200)
        .sort(() => Math.random() - 0.5)
        .slice(0, perDomain);

      stat.planned = candidates.length;

      if (candidates.length === 0) {
        stats.push(stat);
        continue;
      }

      // 2. Для каждого чанка проверяем, нет ли уже записи в gold.
      const ids = candidates.map(c => c.id);
      const { data: existing } = await supabase
        .from('kg_eval_gold')
        .select('chunk_id, source')
        .in('chunk_id', ids);
      const existingMap = new Map<number, string>(
        (existing || []).map(r => [r.chunk_id as number, (r.source as string) ?? 'manual']),
      );

      for (const chunk of candidates) {
        const existingSource = existingMap.get(chunk.id);
        if (existingSource) {
          // Никогда не перезаписываем ручную разметку. Auto-seed —
          // только если пользователь явно попросил overwrite.
          if (existingSource === 'manual' || !overwrite) {
            stat.skipped += 1;
            continue;
          }
        }

        const chunkOnt = resolveOntologyForTags(chunk.tags) ?? ont;
        const addendum = buildDomainPromptAddendum(chunkOnt);
        const prompt = `${GOLD_PROMPT}${addendum}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${chunk.content.slice(0, 6000)}`;

        let parsed: { entities: EvalEntity[]; relations: EvalRelation[] } = {
          entities: [],
          relations: [],
        };

        try {
          const resp = await ai.models.generateContent({
            model: goldModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              temperature: 0.05,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          });
          const raw = JSON.parse(resp.text || '{}');
          parsed = {
            entities: Array.isArray(raw.entities) ? raw.entities : [],
            relations: Array.isArray(raw.relations) ? raw.relations : [],
          };
        } catch (err) {
          console.error(`[seed-gold] model call failed for chunk ${chunk.id}:`, err);
          stat.failed += 1;
          continue;
        }

        // 3. Валидируем и записываем через upsert по chunk_id.
        const entities = parsed.entities
          .filter(e => e && typeof e.name === 'string' && typeof e.type === 'string')
          .map(e => ({
            name: e.name.trim(),
            type: e.type.trim(),
            description:
              typeof e.description === 'string' ? e.description.trim() : undefined,
          }))
          .filter(e => e.name && e.type);

        const entityNames = new Set(entities.map(e => e.name.toLowerCase()));
        const relations = parsed.relations
          .filter(
            r =>
              r &&
              typeof r.source === 'string' &&
              typeof r.target === 'string' &&
              typeof r.type === 'string',
          )
          .map(r => ({
            source: r.source.trim(),
            target: r.target.trim(),
            type: r.type.trim(),
          }))
          .filter(
            r =>
              r.source &&
              r.target &&
              r.type &&
              // Отфильтровываем связи, упоминающие сущности, которых нет в entities.
              entityNames.has(r.source.toLowerCase()) &&
              entityNames.has(r.target.toLowerCase()),
          );

        const { error: upErr } = await supabase
          .from('kg_eval_gold')
          .upsert(
            {
              chunk_id: chunk.id,
              domain: chunkOnt.name,
              expected_entities: entities,
              expected_relations: relations,
              source: goldModel,
              notes,
            },
            { onConflict: 'chunk_id' },
          );

        if (upErr) {
          console.error(`[seed-gold] upsert failed for chunk ${chunk.id}:`, upErr);
          stat.failed += 1;
          continue;
        }

        stat.extracted += 1;
        totalInserted += 1;

        // Rate-limit: Pro-модель бьёт по квоте сильнее Flash.
        await new Promise(r => setTimeout(r, 400));
      }

      stats.push(stat);
    }

    const { count: goldCount } = await supabase
      .from('kg_eval_gold')
      .select('*', { count: 'exact', head: true });

    return NextResponse.json({
      goldModel,
      totalInserted,
      goldDatasetSize: goldCount ?? 0,
      stats,
    });
  } catch (error: unknown) {
    console.error(
      'kg-eval/seed-gold POST error:',
      error instanceof Error ? error.message : error,
    );
    return serverError('Ошибка генерации gold-датасета');
  }
}
