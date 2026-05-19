import { Router, Request, Response } from "express";
import { GoogleGenAI } from "@google/genai";
import { requireAdmin } from "../lib/auth.js";
import { createServiceClient } from "../lib/supabase.js";
import {
  resolveOntologyForTags,
  buildDomainPromptAddendum,
  DOMAIN_ONTOLOGIES,
} from "../lib/kg-ontologies.js";
import {
  scoreEntities,
  scoreRelations,
  addConfusion,
  toMetrics,
  type ConfusionCounts,
  type EvalEntity,
  type EvalRelation,
  type Metrics,
} from "../lib/kg-eval.js";

/* ══════════════════════════════════════════════════════════════
   RAG admin routes (ported from Next.js app/api/admin/kg-eval*).
   Moved to Express because seed-gold / kg-eval loop over tens of
   LLM calls (3-7 min), which exceeds Vercel's 300s function cap.
   Railway has no such limit.
   ══════════════════════════════════════════════════════════════ */

const router = Router();

// ── Константы ──────────────────────────────────────────────────
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

const DEFAULT_GOLD_MODEL = "gemini-3.1-pro-preview";

// ── Типы ───────────────────────────────────────────────────────
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

// Выявить 42P01 (undefined_table) → миграция не применена.
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const msg = (err as { message?: string }).message ?? "";
  return code === "42P01" || /relation ".*" does not exist/i.test(msg);
}

function migrationRequired(res: Response, which: string) {
  return res.status(503).json({
    error: `Таблица ${which} не найдена. Примените миграцию supabase/migration_kg_eval.sql в Supabase SQL Editor.`,
    migrationRequired: true,
  });
}

/**
 * Gemini иногда возвращает JSON, обёрнутый в ```json ... ``` fence, или
 * с префиксом в духе "Вот результат:". responseMimeType=application/json
 * обычно это предотвращает, но не всегда — защищаемся.
 */
function parseLLMJson(raw: string | null | undefined): unknown {
  const text = (raw ?? "").trim();
  if (!text) return {};
  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  // Берём подстроку от первой { до последней } — отрезаем префикс/суффикс LLM'а.
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  const body = first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
  return JSON.parse(body);
}

/* ══════════════════════════════════════════════════════════════
   GET /api/admin/kg-eval?limit=N
   История прогонов + размер золотого датасета.
   ══════════════════════════════════════════════════════════════ */
router.get("/api/admin/kg-eval", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("kg_eval_run")
      .select(
        "id, run_at, total_chunks, entity_precision, entity_recall, entity_f1, relation_precision, relation_recall, relation_f1, metrics, notes, model, gold_model"
      )
      .order("run_at", { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTableError(error)) return migrationRequired(res, "kg_eval_run");
      throw error;
    }

    const { count: goldCount } = await supabase
      .from("kg_eval_gold")
      .select("*", { count: "exact", head: true });

    return res.json({
      goldDatasetSize: goldCount ?? 0,
      runs: data ?? [],
    });
  } catch (err: unknown) {
    console.error("[kg-eval][GET] error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Ошибка загрузки eval-истории" });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/admin/kg-eval
   Прогон extraction против золотого датасета. Пишет kg_eval_run.
   Body: { limit?, domain?, notes? }
   ══════════════════════════════════════════════════════════════ */
router.post("/api/admin/kg-eval", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const body = (req.body ?? {}) as {
      limit?: number;
      domain?: string | null;
      notes?: string;
    };
    const limit = Math.min(Number(body.limit) || 50, 200);
    const domainFilter = typeof body.domain === "string" ? body.domain : null;
    const notes = typeof body.notes === "string" ? body.notes : "";

    const supabase = createServiceClient();
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

    // 1. Загрузить gold
    let goldQuery = supabase
      .from("kg_eval_gold")
      .select("id, chunk_id, domain, expected_entities, expected_relations, source")
      .order("id", { ascending: true })
      .limit(limit);
    if (domainFilter) goldQuery = goldQuery.eq("domain", domainFilter);

    const { data: goldRaw, error: goldErr } = await goldQuery;
    if (goldErr) {
      if (isMissingTableError(goldErr)) return migrationRequired(res, "kg_eval_gold");
      throw goldErr;
    }
    const gold = (goldRaw || []) as GoldRow[];

    if (gold.length === 0) {
      return res.json({
        message: "kg_eval_gold пуст или фильтр не дал результата",
        totalChunks: 0,
      });
    }

    // 2. Чанки
    const chunkIds = gold.map((g) => g.chunk_id);
    const { data: chunksRaw, error: chErr } = await supabase
      .from("chunks")
      .select("id, content, tags")
      .in("id", chunkIds);
    if (chErr) throw chErr;

    const chunksMap = new Map<number, ChunkRow>();
    for (const c of (chunksRaw || []) as ChunkRow[]) chunksMap.set(c.id, c);

    // 3. Прогон
    let entConf: ConfusionCounts = { tp: 0, fp: 0, fn: 0 };
    let relConf: ConfusionCounts = { tp: 0, fp: 0, fn: 0 };
    const entTypeConf = new Map<string, ConfusionCounts>();
    const relTypeConf = new Map<string, ConfusionCounts>();
    const domainConf = new Map<
      string,
      { ent: ConfusionCounts; rel: ConfusionCounts; chunks: number }
    >();
    const missingSamples: Array<{ chunkId: number; entity: EvalEntity }> = [];
    const spuriousSamples: Array<{ chunkId: number; entity: EvalEntity }> = [];

    console.log(`[kg-eval] start: ${gold.length} чанков из gold${domainFilter ? ` (domain=${domainFilter})` : ""}`);
    const t0 = Date.now();
    let processed = 0;

    for (const g of gold) {
      const chunk = chunksMap.get(g.chunk_id);
      if (!chunk) continue;
      processed += 1;
      const tChunk = Date.now();

      const ont = resolveOntologyForTags(chunk.tags);
      const addendum = buildDomainPromptAddendum(ont);
      const prompt = `${EXTRACTION_PROMPT}${addendum}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${chunk.content.slice(0, 6000)}`;

      let predicted: { entities: EvalEntity[]; relations: EvalRelation[] } = {
        entities: [],
        relations: [],
      };

      try {
        const resp = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        });
        const parsed = parseLLMJson(resp.text) as {
          entities?: EvalEntity[];
          relations?: EvalRelation[];
        };
        predicted = {
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        };
      } catch (err) {
        console.error(`[kg-eval] extraction failed for chunk ${g.chunk_id}:`, err);
      }

      const eRes = scoreEntities(g.expected_entities, predicted.entities);
      const rRes = scoreRelations(g.expected_relations, predicted.relations);

      entConf = addConfusion(entConf, {
        tp: eRes.total.tp,
        fp: eRes.total.fp,
        fn: eRes.total.fn,
      });
      relConf = addConfusion(relConf, {
        tp: rRes.total.tp,
        fp: rRes.total.fp,
        fn: rRes.total.fn,
      });

      for (const [type, m] of Object.entries(eRes.byType)) {
        const cur = entTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
        entTypeConf.set(type, { tp: cur.tp + m.tp, fp: cur.fp + m.fp, fn: cur.fn + m.fn });
      }
      for (const [type, m] of Object.entries(rRes.byType)) {
        const cur = relTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
        relTypeConf.set(type, { tp: cur.tp + m.tp, fp: cur.fp + m.fp, fn: cur.fn + m.fn });
      }

      const dcur = domainConf.get(g.domain) ?? {
        ent: { tp: 0, fp: 0, fn: 0 },
        rel: { tp: 0, fp: 0, fn: 0 },
        chunks: 0,
      };
      dcur.ent = addConfusion(dcur.ent, eRes.total);
      dcur.rel = addConfusion(dcur.rel, rRes.total);
      dcur.chunks += 1;
      domainConf.set(g.domain, dcur);

      for (const m of eRes.missing.slice(0, 3)) {
        if (missingSamples.length < 20) missingSamples.push({ chunkId: g.chunk_id, entity: m });
      }
      for (const s of eRes.spurious.slice(0, 3)) {
        if (spuriousSamples.length < 20) spuriousSamples.push({ chunkId: g.chunk_id, entity: s });
      }

      console.log(
        `[kg-eval] ${processed}/${gold.length}: chunk=${g.chunk_id} domain=${g.domain} ent=${predicted.entities.length} rel=${predicted.relations.length} (${Date.now() - tChunk}ms)`
      );
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`[kg-eval] done: ${processed} чанков, elapsed=${Date.now() - t0}ms`);

    const entMetrics = toMetrics(entConf);
    const relMetrics = toMetrics(relConf);

    const entityTypes: Record<string, Metrics> = {};
    for (const [t, c] of entTypeConf) entityTypes[t] = toMetrics(c);
    const relationTypes: Record<string, Metrics> = {};
    for (const [t, c] of relTypeConf) relationTypes[t] = toMetrics(c);

    const domains: Record<
      string,
      { entities: Metrics; relations: Metrics; chunks: number }
    > = {};
    for (const [d, v] of domainConf) {
      domains[d] = {
        entities: toMetrics(v.ent),
        relations: toMetrics(v.rel),
        chunks: v.chunks,
      };
    }

    const metricsJson = { domains, entityTypes, relationTypes, missingSamples, spuriousSamples };

    const sourceSet = new Set(gold.map((g) => g.source ?? "manual"));
    const goldModel = sourceSet.size === 1 ? [...sourceSet][0] : "mixed";

    const { data: run, error: runErr } = await supabase
      .from("kg_eval_run")
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
      .select("id, run_at")
      .single();

    if (runErr) console.error("[kg-eval] failed to persist run:", runErr);

    return res.json({
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
  } catch (err: unknown) {
    console.error("[kg-eval][POST] error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Ошибка запуска eval" });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/admin/kg-eval/seed-gold
   Генерирует псевдо-эталон через сильную модель (Pro) и пишет
   в kg_eval_gold. Body: { perDomain?, goldModel?, domains?, overwrite?, notes? }
   ══════════════════════════════════════════════════════════════ */
router.post("/api/admin/kg-eval/seed-gold", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const body = (req.body ?? {}) as {
      perDomain?: number;
      goldModel?: string;
      domains?: string[];
      overwrite?: boolean;
      notes?: string;
    };

    const perDomain = Math.min(Math.max(Number(body.perDomain) || 10, 1), 50);
    const goldModel: string =
      typeof body.goldModel === "string" && body.goldModel.trim()
        ? body.goldModel.trim()
        : DEFAULT_GOLD_MODEL;
    const overwrite: boolean = Boolean(body.overwrite);
    const notes: string = typeof body.notes === "string" ? body.notes : "";
    const requestedDomains: string[] | null =
      Array.isArray(body.domains) && body.domains.length
        ? body.domains.map((d) => String(d).toLowerCase())
        : null;

    const supabase = createServiceClient();
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

    const ontologies = DOMAIN_ONTOLOGIES.filter(
      (o) => !requestedDomains || requestedDomains.includes(o.name)
    );
    if (ontologies.length === 0) {
      return res.status(400).json({
        message: "Нет доменов для seed (проверь параметр domains)",
      });
    }

    const stats: SeedStats[] = [];
    let totalInserted = 0;

    console.log(`[seed-gold] start: domains=${ontologies.map((o) => o.name).join(",")}, perDomain=${perDomain}, model=${goldModel}`);
    const t0 = Date.now();

    for (const ont of ontologies) {
      const stat: SeedStats = {
        domain: ont.name,
        planned: 0,
        extracted: 0,
        skipped: 0,
        failed: 0,
      };
      const tDomain = Date.now();

      const { data: chunksRaw, error: chErr } = await supabase
        .from("chunks")
        .select("id, content, tags")
        .overlaps("tags", ont.tags as unknown as string[])
        .not("content", "is", null)
        .limit(perDomain * 4);

      if (chErr) {
        if (isMissingTableError(chErr)) return migrationRequired(res, "chunks");
        console.error(`[seed-gold] chunks query failed for ${ont.name}:`, chErr);
        stats.push(stat);
        continue;
      }

      const candidates = ((chunksRaw || []) as CandidateChunk[])
        .filter((c) => c.content && c.content.trim().length >= 200)
        .sort(() => Math.random() - 0.5)
        .slice(0, perDomain);
      stat.planned = candidates.length;
      if (candidates.length === 0) {
        stats.push(stat);
        continue;
      }

      const ids = candidates.map((c) => c.id);
      const { data: existing, error: exErr } = await supabase
        .from("kg_eval_gold")
        .select("chunk_id, source")
        .in("chunk_id", ids);
      if (exErr && isMissingTableError(exErr)) return migrationRequired(res, "kg_eval_gold");

      const existingMap = new Map<number, string>(
        (existing || []).map((r) => [r.chunk_id as number, (r.source as string) ?? "manual"])
      );

      console.log(`[seed-gold] ${ont.name}: ${candidates.length} кандидатов, уже в gold: ${existingMap.size}`);

      let idx = 0;
      for (const chunk of candidates) {
        idx += 1;
        const existingSource = existingMap.get(chunk.id);
        if (existingSource) {
          if (existingSource === "manual" || !overwrite) {
            stat.skipped += 1;
            console.log(`[seed-gold] ${ont.name} ${idx}/${candidates.length}: chunk=${chunk.id} skipped (${existingSource})`);
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
        const tChunk = Date.now();

        try {
          const resp = await ai.models.generateContent({
            model: goldModel,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              temperature: 0.05,
              maxOutputTokens: 8192,
              responseMimeType: "application/json",
            },
          });
          const raw = parseLLMJson(resp.text) as {
            entities?: EvalEntity[];
            relations?: EvalRelation[];
          };
          parsed = {
            entities: Array.isArray(raw.entities) ? raw.entities : [],
            relations: Array.isArray(raw.relations) ? raw.relations : [],
          };
        } catch (err) {
          console.error(`[seed-gold] model call failed for chunk ${chunk.id}:`, err);
          stat.failed += 1;
          continue;
        }

        const entities = parsed.entities
          .filter((e) => e && typeof e.name === "string" && typeof e.type === "string")
          .map((e) => ({
            name: e.name.trim(),
            type: e.type.trim(),
            description:
              typeof e.description === "string" ? e.description.trim() : undefined,
          }))
          .filter((e) => e.name && e.type);

        const entityNames = new Set(entities.map((e) => e.name.toLowerCase()));
        const relations = parsed.relations
          .filter(
            (r) =>
              r &&
              typeof r.source === "string" &&
              typeof r.target === "string" &&
              typeof r.type === "string"
          )
          .map((r) => ({
            source: r.source.trim(),
            target: r.target.trim(),
            type: r.type.trim(),
          }))
          .filter(
            (r) =>
              r.source &&
              r.target &&
              r.type &&
              entityNames.has(r.source.toLowerCase()) &&
              entityNames.has(r.target.toLowerCase())
          );

        const { error: upErr } = await supabase.from("kg_eval_gold").upsert(
          {
            chunk_id: chunk.id,
            domain: chunkOnt.name,
            expected_entities: entities,
            expected_relations: relations,
            source: goldModel,
            notes,
          },
          { onConflict: "chunk_id" }
        );

        if (upErr) {
          console.error(`[seed-gold] upsert failed for chunk ${chunk.id}:`, upErr);
          stat.failed += 1;
          continue;
        }

        stat.extracted += 1;
        totalInserted += 1;
        console.log(
          `[seed-gold] ${ont.name} ${idx}/${candidates.length}: chunk=${chunk.id} +ent=${entities.length} +rel=${relations.length} (${Date.now() - tChunk}ms)`
        );

        await new Promise((r) => setTimeout(r, 400));
      }

      console.log(
        `[seed-gold] ${ont.name} done: +${stat.extracted}, skipped ${stat.skipped}, failed ${stat.failed} (${Date.now() - tDomain}ms)`
      );
      stats.push(stat);
    }
    console.log(`[seed-gold] total done: inserted=${totalInserted}, elapsed=${Date.now() - t0}ms`);

    const { count: goldCount } = await supabase
      .from("kg_eval_gold")
      .select("*", { count: "exact", head: true });

    return res.json({
      goldModel,
      totalInserted,
      goldDatasetSize: goldCount ?? 0,
      stats,
    });
  } catch (err: unknown) {
    console.error("[seed-gold] error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Ошибка генерации gold-датасета" });
  }
});

export default router;
