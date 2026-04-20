import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/app/lib/supabase';
import { GoogleGenAI } from '@google/genai';
import { requireAdmin } from '@/app/lib/auth';
import { serverError } from '@/app/lib/api-helpers';
import {
  resolveOntologyForTags,
  buildDomainPromptAddendum,
} from '@/app/lib/kg-ontologies';
import {
  scoreEntities,
  scoreRelations,
  addConfusion,
  toMetrics,
  type ConfusionCounts,
  type EvalEntity,
  type EvalRelation,
  type Metrics,
} from '@/app/lib/kg-eval';

// ============================================================
// POST /api/admin/kg-eval
// Прогоняет extraction по чанкам из kg_eval_gold, сравнивает с
// ожидаемыми сущностями/связями и сохраняет метрики в kg_eval_run.
// НЕ ПИШЕТ в kg_entities / kg_relations / kg_extraction_log — это
// чистый read-only прогон для измерения качества.
//
// Body:
//   limit?: number    — макс. чанков за прогон (default 50, max 200)
//   domain?: string   — фильтр по domain (опционально)
//   notes?: string    — заметка в kg_eval_run.notes
//
// GET /api/admin/kg-eval
//   ?limit=20  — последние N прогонов с метриками
// ============================================================

// Базовый промпт должен совпадать с extract-entities, чтобы eval
// отражал реальный pipeline. Дублируем, чтобы не экспортировать из
// route-файла (избегаем circular deps и Next.js build-issues).
const EXTRACTION_PROMPT = `Ты — эксперт по извлечению сущностей и связей из документов в области закупочной деятельности.

Извлеки из текста все именованные сущности и связи между ними.

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
- contract_party: сторона договора
- obligation: обязательство в договоре
- approval_level: уровень согласования

ТИПЫ СВЯЗЕЙ:
defines, references, requires, governs, part_of, belongs_to, supersedes,
amends, sets_threshold, restricts, delegates_to, requires_approval,
party_of, obliged_to, penalized_by, approves, escalates_to.

ПРАВИЛА:
1. Извлекай ТОЛЬКО сущности, явно упомянутые в тексте.
2. Не дублируй сущности.
3. Каждая связь должна соединять две извлечённые сущности.

Верни JSON:
{"entities":[{"name":"...","type":"...","description":"..."}],
 "relations":[{"source":"...","target":"...","type":"...","confidence":1.0}]}`;

interface GoldRow {
  id: number;
  chunk_id: number;
  domain: string;
  expected_entities: EvalEntity[];
  expected_relations: EvalRelation[];
  source?: string;
}

interface ChunkRow {
  id: number;
  content: string;
  tags: string[] | null;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit) || 50, 200);
    const domainFilter: string | null = body.domain || null;
    const notes: string = typeof body.notes === 'string' ? body.notes : '';

    const supabase = createServiceClient();
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

    // 1. Загрузить gold
    let goldQuery = supabase
      .from('kg_eval_gold')
      .select('id, chunk_id, domain, expected_entities, expected_relations, source')
      .order('id', { ascending: true })
      .limit(limit);
    if (domainFilter) goldQuery = goldQuery.eq('domain', domainFilter);

    const { data: goldRaw, error: goldErr } = await goldQuery;
    if (goldErr) throw goldErr;
    const gold = (goldRaw || []) as GoldRow[];

    if (gold.length === 0) {
      return NextResponse.json({
        message: 'kg_eval_gold пуст или фильтр не дал результата',
        totalChunks: 0,
      });
    }

    // 2. Загрузить чанки батчем
    const chunkIds = gold.map(g => g.chunk_id);
    const { data: chunksRaw, error: chErr } = await supabase
      .from('chunks')
      .select('id, content, tags')
      .in('id', chunkIds);
    if (chErr) throw chErr;
    const chunks = new Map<number, ChunkRow>();
    for (const c of (chunksRaw || []) as ChunkRow[]) chunks.set(c.id, c);

    // 3. Обход: для каждого gold row — запуск LLM (без записи в БД!),
    //    сравнение и аккумулирование метрик.
    let entConf: ConfusionCounts = { tp: 0, fp: 0, fn: 0 };
    let relConf: ConfusionCounts = { tp: 0, fp: 0, fn: 0 };
    const entTypeConf = new Map<string, ConfusionCounts>();
    const relTypeConf = new Map<string, ConfusionCounts>();
    const domainConf = new Map<string, {
      ent: ConfusionCounts;
      rel: ConfusionCounts;
      chunks: number;
    }>();

    const missingSamples: Array<{ chunkId: number; entity: EvalEntity }> = [];
    const spuriousSamples: Array<{ chunkId: number; entity: EvalEntity }> = [];

    for (const g of gold) {
      const chunk = chunks.get(g.chunk_id);
      if (!chunk) continue;

      const ont = resolveOntologyForTags(chunk.tags);
      const addendum = buildDomainPromptAddendum(ont);
      const prompt = `${EXTRACTION_PROMPT}${addendum}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${chunk.content.slice(0, 6000)}`;

      let predicted: { entities: EvalEntity[]; relations: EvalRelation[] } = {
        entities: [],
        relations: [],
      };

      try {
        const resp = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        });
        const parsed = JSON.parse(resp.text || '{}');
        predicted = {
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        };
      } catch (err) {
        console.error(`[kg-eval] extraction failed for chunk ${g.chunk_id}:`, err);
      }

      const eRes = scoreEntities(g.expected_entities, predicted.entities);
      const rRes = scoreRelations(g.expected_relations, predicted.relations);

      // Аккумулируем overall
      entConf = addConfusion(entConf, { tp: eRes.total.tp, fp: eRes.total.fp, fn: eRes.total.fn });
      relConf = addConfusion(relConf, { tp: rRes.total.tp, fp: rRes.total.fp, fn: rRes.total.fn });

      // По типам
      for (const [type, m] of Object.entries(eRes.byType)) {
        const cur = entTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
        entTypeConf.set(type, { tp: cur.tp + m.tp, fp: cur.fp + m.fp, fn: cur.fn + m.fn });
      }
      for (const [type, m] of Object.entries(rRes.byType)) {
        const cur = relTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
        relTypeConf.set(type, { tp: cur.tp + m.tp, fp: cur.fp + m.fp, fn: cur.fn + m.fn });
      }

      // По доменам
      const dcur = domainConf.get(g.domain) ?? {
        ent: { tp: 0, fp: 0, fn: 0 },
        rel: { tp: 0, fp: 0, fn: 0 },
        chunks: 0,
      };
      dcur.ent = addConfusion(dcur.ent, eRes.total);
      dcur.rel = addConfusion(dcur.rel, rRes.total);
      dcur.chunks += 1;
      domainConf.set(g.domain, dcur);

      // Примеры ошибок (первые 20)
      for (const m of eRes.missing.slice(0, 3)) {
        if (missingSamples.length < 20) missingSamples.push({ chunkId: g.chunk_id, entity: m });
      }
      for (const s of eRes.spurious.slice(0, 3)) {
        if (spuriousSamples.length < 20) spuriousSamples.push({ chunkId: g.chunk_id, entity: s });
      }

      // Rate-limit pause
      await new Promise(r => setTimeout(r, 200));
    }

    const entMetrics = toMetrics(entConf);
    const relMetrics = toMetrics(relConf);

    const entityTypes: Record<string, Metrics> = {};
    for (const [t, c] of entTypeConf) entityTypes[t] = toMetrics(c);
    const relationTypes: Record<string, Metrics> = {};
    for (const [t, c] of relTypeConf) relationTypes[t] = toMetrics(c);

    const domains: Record<string, { entities: Metrics; relations: Metrics; chunks: number }> = {};
    for (const [d, v] of domainConf) {
      domains[d] = {
        entities: toMetrics(v.ent),
        relations: toMetrics(v.rel),
        chunks: v.chunks,
      };
    }

    const metricsJson = {
      domains,
      entityTypes,
      relationTypes,
      missingSamples,
      spuriousSamples,
    };

    // Определяем источник эталона: если все строки из одного источника —
    // используем его; если смешаны — 'mixed'.
    const sourceSet = new Set(gold.map(g => g.source ?? 'manual'));
    const goldModel =
      sourceSet.size === 1 ? [...sourceSet][0] : 'mixed';

    // Сохраняем run
    const { data: run, error: runErr } = await supabase
      .from('kg_eval_run')
      .insert({
        total_chunks: gold.length,
        entity_precision: entMetrics.precision,
        entity_recall: entMetrics.recall,
        entity_f1: entMetrics.f1,
        relation_precision: relMetrics.precision,
        relation_recall: relMetrics.recall,
        relation_f1: relMetrics.f1,
        metrics: metricsJson,
        notes,
        gold_model: goldModel,
      })
      .select('id, run_at')
      .single();

    if (runErr) console.error('[kg-eval] failed to persist run:', runErr);

    return NextResponse.json({
      runId: run?.id ?? null,
      runAt: run?.run_at ?? null,
      totalChunks: gold.length,
      entities: entMetrics,
      relations: relMetrics,
      domains,
      entityTypes,
      relationTypes,
      missingSamples,
      spuriousSamples,
    });
  } catch (error: unknown) {
    console.error('kg-eval POST error:', error instanceof Error ? error.message : error);
    return serverError('Ошибка запуска eval');
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('kg_eval_run')
      .select('id, run_at, total_chunks, entity_precision, entity_recall, entity_f1, relation_precision, relation_recall, relation_f1, metrics, notes, model, gold_model')
      .order('run_at', { ascending: false })
      .limit(limit);
    if (error) {
      // PostgreSQL code 42P01 = undefined_table → миграция не применена.
      const code = (error as { code?: string }).code;
      if (code === '42P01' || /relation ".*" does not exist/i.test(error.message)) {
        return NextResponse.json(
          {
            error:
              'Таблица kg_eval_run не найдена. Примените миграцию supabase/migration_kg_eval.sql в Supabase SQL Editor.',
            migrationRequired: true,
          },
          { status: 503 },
        );
      }
      throw error;
    }

    // Также отдадим размер gold
    const { count: goldCount } = await supabase
      .from('kg_eval_gold')
      .select('*', { count: 'exact', head: true });

    return NextResponse.json({
      goldDatasetSize: goldCount ?? 0,
      runs: data ?? [],
    });
  } catch (error: unknown) {
    console.error('kg-eval GET error:', error instanceof Error ? error.message : error);
    return serverError('Ошибка загрузки eval-истории');
  }
}
