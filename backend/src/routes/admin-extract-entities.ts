import { Router, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createServiceClient } from "../lib/supabase.js";
import { embedQuery } from "../lib/embeddings.js";
import {
  requireAdmin,
  isDocumentAdmin,
  getAdminName,
} from "../lib/auth.js";
import { logAuditEvent } from "../lib/audit-log.js";
import {
  resolveOntologyForTags,
  resolveOntologyForBatch,
  buildDomainPromptAddendum,
  type DomainOntology,
} from "../lib/kg-ontologies.js";

/* ══════════════════════════════════════════════════════════════════════
   POST /api/admin/extract-entities
   Батч-извлечение сущностей и связей из chunks через Gemini 3 Flash.

   ПОРТИРОВАНО С Vercel (app/api/admin/extract-entities/route.ts) НА RAILWAY
   по двум причинам:
     1. Vercel function limit 300s, Railway без ограничений — а прогоны
        на 50 чанков занимают 1-3 мин и могут превышать лимит.
     2. Нужен service-auth путь для межсервисных вызовов без браузерной
        2FA-сессии (см. ниже).

   АВТОРИЗАЦИЯ — две независимые ветки:

   A) Browser path (обычный вызов из админки):
      x-admin-code + x-admin-session (2FA-токен) + Origin allowlist.
      Проходит через стандартный Origin-middleware и requireAdmin().

   B) Service path (межсервисный вызов без браузера):
      x-api-key = process.env.EXTRACTION_SERVICE_KEY (timing-safe сравн.)
      + x-admin-code с флагом isDocAdmin = true.
      Origin-middleware для этого пути скипается в index.ts — только если
      service-условия выполнены. Иначе fallback на обычную Origin-проверку.

   Обе ветки пишут audit_log с auth_method.

   ══════════════════════════════════════════════════════════════════════ */

const router = Router();

// ── Конфиг ────────────────────────────────────────────────────────────

const DEFAULT_FILTER_TAGS = [
  "стандарт",
  "положения",
  "договоры",
  "матрица полномочий",
];

const STRICT_MATCH_TYPES = new Set([
  "standard",
  "regulation",
  "threshold",
  "section",
]);

const ENTITY_TYPES = [
  "standard",
  "branch",
  "mtr_type",
  "procedure",
  "system",
  "organization",
  "document",
  "role",
  "threshold",
  "concept",
  "regulation",
  "section",
  "contract_party",
  "obligation",
  "approval_level",
];

const RELATION_TYPES = [
  "defines",
  "references",
  "requires",
  "governs",
  "part_of",
  "belongs_to",
  "supersedes",
  "amends",
  "sets_threshold",
  "restricts",
  "delegates_to",
  "requires_approval",
  "party_of",
  "obliged_to",
  "penalized_by",
  "approves",
  "escalates_to",
  // B1/B2: soft-link для близких, но не идентичных сущностей
  "related_to",
];

const EXTRACTION_PROMPT = `Ты — эксперт по извлечению сущностей и связей из документов в области закупочной деятельности.

Извлеки из текста все именованные сущности и связи между ними.

ТИПЫ СУЩНОСТЕЙ:
- standard: стандарты (ГОСТ, СТО, РД, ОСТ, ТУ с номерами)
- branch: филиалы СГК (СГК-Алтай, ЕТГК, Кузбассэнерго, СГК-Новосибирск, НТСК и др.)
- mtr_type: виды МТР (трубопроводная арматура, кабельная продукция, запчасти и т.д.)
- procedure: процедуры закупок (конкурс, аукцион, запрос котировок, закупка у ед. поставщика и т.д.)
- system: информационные системы (SRM, SAP, B2B-Center, 1С и т.д.)
- organization: организации, подразделения, контрагенты
- document: названия документов, регламентов, положений (на которые есть ссылки)
- role: должности и роли (директор по закупкам, руководитель ДЗ, закупочная комиссия и т.д.)
- threshold: пороговые значения (суммы в рублях, сроки в днях, проценты)
- concept: ключевые понятия закупочной деятельности (НМЦД, ТЗ, КД, реестр и т.д.)
- regulation: нормативные акты (223-ФЗ, 44-ФЗ, ГК РФ и т.д.)
- section: конкретные пункты/разделы документов (п. 3.2, раздел 5 и т.д.)
- contract_party: сторона договора (Заказчик, Исполнитель, Поставщик, Подрядчик)
- obligation: конкретное обязательство в договоре (поставка, оплата, гарантия и т.д.)
- approval_level: уровень согласования из матрицы полномочий (1-й уровень, ЦЗК, Правление)

ТИПЫ СВЯЗЕЙ:
- defines: определяет
- references: ссылается на
- requires: требует
- governs: регулирует
- part_of: является частью
- belongs_to: принадлежит
- supersedes: заменяет
- amends: изменяет
- sets_threshold: устанавливает порог
- restricts: ограничивает
- delegates_to: делегирует полномочия
- requires_approval: требует согласования
- party_of: организация/роль является стороной договора
- obliged_to: сторона обязуется выполнить (contract_party → obligation)
- penalized_by: обязательство обеспечено санкцией (obligation → threshold)
- approves: роль/уровень согласовывает (role/approval_level → procedure/threshold)
- escalates_to: эскалация между уровнями согласования

ПРАВИЛА:
1. Извлекай ТОЛЬКО сущности, явно упомянутые в тексте.
2. Для стандартов указывай полный номер (например, «ГОСТ 12.1.005-88», «СТО СГК 013-2021»).
3. Для порогов указывай конкретное значение (например, «500 000 руб.», «10 рабочих дней»).
4. Каждая связь должна соединять две извлечённые сущности.
5. Confidence связи: 1.0 если прямо указана в тексте, 0.8 если подразумевается контекстом.
6. Не дублируй сущности: если одно и то же понятие упомянуто в разных формах, выбери каноническую.

Верни JSON строго в формате:
{
  "entities": [
    {"name": "полное название", "type": "тип из списка", "description": "краткое описание из контекста"}
  ],
  "relations": [
    {"source": "имя сущности-источника", "target": "имя сущности-цели", "type": "тип из списка", "description": "суть связи", "confidence": 1.0}
  ]
}

Если сущностей или связей нет, верни пустые массивы.`;

// ── Утилиты нормализации и matching ───────────────────────────────────

function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/«|»|"|"/g, "")
    .replace(/\bсгк\b/g, "сибирская генерирующая компания")
    .replace(/\bдз\b/g, "дирекция по закупкам")
    .replace(/\bмтр\b/g, "материально-технические ресурсы")
    .replace(/\bнмцд\b/g, "начальная максимальная цена договора")
    .replace(/\bтз\b/g, "техническое задание")
    .replace(/\bкд\b/g, "конкурсная документация")
    .replace(/\bцзк\b/g, "центральная закупочная комиссия")
    .replace(/\bзк\b/g, "закупочная комиссия");
}

// B1 (recovery plan от 2026-04-20): STRICT canonical name matching.
// Подробности см. в комментарии в app/api/admin/extract-entities/route.ts
// (Jaccard ≥ 0.75, length ratio ≤ 1.5x, exact match по цифровым токенам).
function canonicalNamesCompatible(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (shorter.length === 0) return false;
  if (longer.length / shorter.length > 1.5) return false;

  const tokenize = (s: string) => s.split(/[\s\-.,;:/()]+/).filter(Boolean);

  const digitLike = (t: string) => /\d/.test(t);
  const digitsA = new Set(tokenize(a).filter(digitLike));
  const digitsB = new Set(tokenize(b).filter(digitLike));
  if (digitsA.size !== digitsB.size) return false;
  for (const d of digitsA) if (!digitsB.has(d)) return false;

  const significant = (t: string) => t.length >= 4 && !digitLike(t);
  const setA = new Set(tokenize(a).filter(significant));
  const setB = new Set(tokenize(b).filter(significant));
  if (setA.size === 0 && setB.size === 0) return false;

  const union = new Set([...setA, ...setB]);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const jaccard = union.size > 0 ? inter / union.size : 0;
  return jaccard >= 0.75;
}

// B2: detection режима 223-ФЗ vs вне 223-ФЗ по тегам чанков.
type RegimeLabel = "223" | "non-223";
function detectRegime(
  tags: Array<string[] | null | undefined>,
): RegimeLabel | null {
  let has223 = false;
  let hasNon223 = false;
  for (const t of tags) {
    if (!t) continue;
    if (t.includes("223-фз")) has223 = true;
    if (t.includes("вне 223-фз")) hasNon223 = true;
  }
  if (has223 && !hasNon223) return "223";
  if (hasNon223 && !has223) return "non-223";
  return null;
}

// ── Типы ──────────────────────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

interface ExtractedRelation {
  source: string;
  target: string;
  type: string;
  description: string;
  confidence: number;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

interface AuthContext {
  adminName: string;
  authMethod: "browser" | "service";
}

/**
 * Безопасное извлечение заголовка с URI-декодированием (для кириллических
 * админ-кодов, которые HTTP-клиенты URL-кодируют). Клон auth.getHeader,
 * не экспортируется там.
 */
function readHeader(req: Request, name: string): string {
  const raw = req.headers[name] as string | undefined;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ── Авторизация (две ветки) ──────────────────────────────────────────

/**
 * Проверяет service-auth: timing-safe сравнение x-api-key + наличие
 * isDocAdmin-флага у кода. Возвращает null если service-путь не применим
 * (ключ или код отсутствуют/невалидны).
 *
 * SECURITY: все ответы при неудаче идентичны (401 Unauthorized без деталей),
 * чтобы закрыть канал enumeration. Вызывающая сторона решает, отдать 401
 * или попытаться browser-путь.
 */
function tryServiceAuth(req: Request): AuthContext | null {
  const serviceKey = process.env.EXTRACTION_SERVICE_KEY;
  if (!serviceKey || serviceKey.length < 32) return null;

  const providedKey = readHeader(req, "x-api-key");
  if (!providedKey) return null;

  // Timing-safe compare: длины должны совпадать для корректности timingSafeEqual.
  const aBuf = Buffer.from(providedKey);
  const bBuf = Buffer.from(serviceKey);
  if (aBuf.length !== bBuf.length) return null;
  try {
    if (!timingSafeEqual(aBuf, bBuf)) return null;
  } catch {
    return null;
  }

  // Второй фактор: админ-код с isDocAdmin. URL-декодируем для кириллицы.
  const adminCode = readHeader(req, "x-admin-code");
  if (!adminCode || !isDocumentAdmin(adminCode)) return null;

  return {
    adminName: getAdminName(adminCode) ?? "service",
    authMethod: "service",
  };
}

/**
 * Главная функция авторизации: сначала service-путь, потом browser.
 * Возвращает null и отдаёт ответ в случае неуспеха.
 */
async function authorize(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const service = tryServiceAuth(req);
  if (service) return service;

  // Service-путь не применим — падаем на browser.
  const browser = await requireAdmin(req, res);
  if (!browser) return null;

  // Для extract-entities дополнительно требуем isDocAdmin даже по browser-пути.
  const adminCode = readHeader(req, "x-admin-code");
  if (!isDocumentAdmin(adminCode)) {
    res.status(403).json({ error: "Требуются права администратора документов" });
    return null;
  }

  return { adminName: browser.adminName, authMethod: "browser" };
}

// ── Source IP extraction ──────────────────────────────────────────────

function getSourceIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const ips = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return ips[ips.length - 1] || "unknown";
  }
  return req.ip || "unknown";
}

// ── Утилиты для дедупликации и merge ──────────────────────────────────

async function mergeIntoExisting(
  supabase: ReturnType<typeof createServiceClient>,
  existing: { id: string; source_chunk_ids: string[]; source_ids: string[] },
  chunkIds: (string | number)[],
  sourceIds: (string | number)[],
): Promise<void> {
  const mergedChunks = [
    ...new Set([...existing.source_chunk_ids, ...chunkIds]),
  ] as string[];
  const mergedSources = [
    ...new Set([...existing.source_ids, ...sourceIds]),
  ] as string[];

  await supabase
    .from("kg_entities")
    .update({
      source_chunk_ids: mergedChunks,
      source_ids: mergedSources,
    })
    .eq("id", existing.id);

  existing.source_chunk_ids = mergedChunks;
  existing.source_ids = mergedSources;
}

function findTypeByName(entities: ExtractedEntity[], name: string): string {
  const found = entities.find((e) => e.name === name);
  return found?.type || "concept";
}

// ══════════════════════════════════════════════════════════════════════
//   POST /api/admin/extract-entities
// ══════════════════════════════════════════════════════════════════════

router.post(
  "/api/admin/extract-entities",
  async (req: Request, res: Response) => {
    const auth = await authorize(req, res);
    if (!auth) return;

    const sourceIp = getSourceIp(req);

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const filterTags: string[] = Array.isArray(body.filterTags)
        ? (body.filterTags as string[])
        : DEFAULT_FILTER_TAGS;
      const batchSize: number = Math.min(Number(body.batchSize) || 5, 10);
      const limit: number = Math.min(Number(body.limit) || 50, 200);
      const embedEntities: boolean = body.embedEntities !== false;
      const crossDocResolution: boolean =
        embedEntities && body.crossDocResolution !== false;
      const resolveSimilarityThreshold: number = Math.min(
        Math.max(Number(body.resolveSimilarityThreshold) || 0.92, 0.8),
        0.99,
      );

      // Audit-log на старте (fire-and-forget)
      logAuditEvent({
        action: "kg.extract_entities",
        adminName: auth.adminName,
        details: {
          auth_method: auth.authMethod,
          source_ip: sourceIp,
          filter_tags: filterTags,
          batch_size: batchSize,
          limit,
          embed_entities: embedEntities,
          cross_doc_resolution: crossDocResolution,
          resolve_similarity_threshold: resolveSimilarityThreshold,
        },
      });

      const supabase = createServiceClient();
      const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

      // 1. Список уже обработанных чанков.
      // PostgREST ограничивает ответ 1000 строк по умолчанию, поэтому
      // при разрастании лога >1000 часть свежих чанков выпадала из
      // processedIds и обрабатывалась повторно. Пагинируем через range.
      const processedIds = new Set<string>();
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data: page, error: logErr } = await supabase
          .from("kg_extraction_log")
          .select("chunk_id")
          .range(from, from + pageSize - 1);
        if (logErr) throw logErr;
        if (!page || page.length === 0) break;
        for (const r of page) processedIds.add(r.chunk_id);
        if (page.length < pageSize) break;
      }

      // 2. Чанки с нужными тегами, ещё не обработанные
      let query = supabase
        .from("chunks")
        .select("id, content, source_id, source_filename, tags")
        .order("chunk_index", { ascending: true });

      if (filterTags.length > 0) {
        query = query.overlaps("tags", filterTags);
      }

      const { data: allChunks, error: chunksError } = await query;
      if (chunksError) throw chunksError;

      const chunks = (allChunks || [])
        .filter((c) => !processedIds.has(c.id))
        .slice(0, limit);

      if (chunks.length === 0) {
        return res.json({
          message: "Все чанки с указанными тегами уже обработаны",
          processed: 0,
          remaining: 0,
          authMethod: auth.authMethod,
        });
      }

      // 3. Загрузить существующие сущности для дедупликации.
      // Также пагинируем — при >1000 сущностей часть выпадала бы из
      // entityCache и создавала бы дубликаты при cross-doc merge.
      const entityCache = new Map<
        string,
        { id: string; source_chunk_ids: string[]; source_ids: string[] }
      >();
      for (let from = 0; ; from += pageSize) {
        const { data: entPage, error: entErr } = await supabase
          .from("kg_entities")
          .select(
            "id, canonical_name, entity_type, source_chunk_ids, source_ids",
          )
          .range(from, from + pageSize - 1);
        if (entErr) throw entErr;
        if (!entPage || entPage.length === 0) break;
        for (const e of entPage) {
          entityCache.set(`${e.canonical_name}::${e.entity_type}`, {
            id: e.id,
            source_chunk_ids: e.source_chunk_ids || [],
            source_ids: e.source_ids || [],
          });
        }
        if (entPage.length < pageSize) break;
      }

      let totalEntities = 0;
      let totalRelations = 0;
      const newEntityIds: string[] = [];
      const ontologyUsage: Record<string, number> = {};

      // Группировка чанков по домену (per-tag онтологии)
      const chunksByDomain = new Map<
        string,
        { ontology: DomainOntology | null; list: typeof chunks }
      >();
      for (const c of chunks) {
        const ont = resolveOntologyForTags(c.tags);
        const key = ont?.name ?? "__default__";
        const entry = chunksByDomain.get(key);
        if (entry) entry.list.push(c);
        else chunksByDomain.set(key, { ontology: ont, list: [c] });
      }

      // 4. Обработка пачками
      for (const {
        ontology: groupOntology,
        list: groupChunks,
      } of chunksByDomain.values()) {
        for (let i = 0; i < groupChunks.length; i += batchSize) {
          const batch = groupChunks.slice(i, i + batchSize);

          const batchText = batch
            .map(
              (c, idx) =>
                `--- Чанк ${idx + 1} (файл: ${c.source_filename}) ---\n${c.content.slice(0, 6000)}`,
            )
            .join("\n\n");

          const batchOntology = groupOntology ?? resolveOntologyForBatch(batch);
          const domainAddendum = buildDomainPromptAddendum(batchOntology);
          const ontologyKey = batchOntology?.name ?? "default";
          ontologyUsage[ontologyKey] =
            (ontologyUsage[ontologyKey] || 0) + batch.length;

          let extraction: ExtractionResult = { entities: [], relations: [] };

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: `${EXTRACTION_PROMPT}${domainAddendum}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${batchText}`,
                      },
                    ],
                  },
                ],
                config: {
                  temperature: 0.1,
                  maxOutputTokens: 8192,
                  responseMimeType: "application/json",
                },
              });

              const text = response.text || "";
              const parsed = JSON.parse(text);
              extraction = {
                entities: Array.isArray(parsed.entities) ? parsed.entities : [],
                relations: Array.isArray(parsed.relations)
                  ? parsed.relations
                  : [],
              };
              break;
            } catch (err: unknown) {
              const error = err as { status?: number; message?: string };
              if (error.status === 429 && attempt < 2) {
                await new Promise((r) =>
                  setTimeout(r, Math.pow(2, attempt) * 2000),
                );
                continue;
              }
              console.error(
                `[extract-entities] batch ${i} (domain=${ontologyKey}) error:`,
                error.message,
              );
              break;
            }
          }

          // 5. Upsert сущностей
          const batchEntityMap = new Map<string, string>();
          let batchResolvedByEmbedding = 0;
          let batchSoftLinked = 0;
          let batchRegimeConflicts = 0;

          const batchRegime = detectRegime(batch.map((c) => c.tags));

          for (const ent of extraction.entities) {
            if (!ent.name || !ent.type || !ENTITY_TYPES.includes(ent.type))
              continue;

            const canonical = normalize(ent.name);
            const cacheKey = `${canonical}::${ent.type}`;
            const chunkIds = batch.map((c) => c.id);
            const sourceIds = [...new Set(batch.map((c) => c.source_id))];

            // 5a. Точный мёрж
            if (entityCache.has(cacheKey)) {
              const existing = entityCache.get(cacheKey)!;
              await mergeIntoExisting(supabase, existing, chunkIds, sourceIds);
              batchEntityMap.set(ent.name, existing.id);
              continue;
            }

            // 5b. Cross-doc semantic merge
            let entityId: string | null = null;
            let entityEmbedding: number[] | null = null;
            const softRelated: string[] = [];

            if (crossDocResolution && !STRICT_MATCH_TYPES.has(ent.type)) {
              try {
                const embedText = `${ent.name}. ${ent.description || ""}`.trim();
                entityEmbedding = await embedQuery(embedText);

                const { data: matches, error: matchErr } = await supabase.rpc(
                  "kg_search_entities",
                  {
                    query_embedding: JSON.stringify(entityEmbedding),
                    match_count: 3,
                    filter_types: [ent.type],
                  },
                );

                if (!matchErr && Array.isArray(matches)) {
                  for (const m of matches as Array<{
                    entity_id: string;
                    canonical_name: string;
                    similarity: number;
                    source_chunk_ids: string[] | null;
                    source_ids: string[] | null;
                  }>) {
                    if (m.similarity < resolveSimilarityThreshold) continue;

                    const canonicalOk = canonicalNamesCompatible(
                      canonical,
                      m.canonical_name,
                    );

                    let candidateRegime: RegimeLabel | null = null;
                    if (m.source_chunk_ids && m.source_chunk_ids.length > 0) {
                      try {
                        const { data: candChunks } = await supabase
                          .from("chunks")
                          .select("tags")
                          .in("id", m.source_chunk_ids.slice(0, 20));
                        candidateRegime = detectRegime(
                          (candChunks || []).map((c) => c.tags),
                        );
                      } catch {
                        // ignore — merge not blocked if we can't determine regime
                      }
                    }
                    const regimeConflict =
                      batchRegime !== null &&
                      candidateRegime !== null &&
                      batchRegime !== candidateRegime;

                    if (canonicalOk && !regimeConflict) {
                      const resolved = {
                        id: m.entity_id,
                        source_chunk_ids: m.source_chunk_ids || [],
                        source_ids: m.source_ids || [],
                      };
                      await mergeIntoExisting(
                        supabase,
                        resolved,
                        chunkIds,
                        sourceIds,
                      );

                      entityCache.set(
                        `${m.canonical_name}::${ent.type}`,
                        resolved,
                      );
                      entityCache.set(cacheKey, resolved);
                      entityId = m.entity_id;
                      batchResolvedByEmbedding++;
                      break;
                    }

                    if (
                      softRelated.length < 2 &&
                      softRelated.indexOf(m.entity_id) === -1
                    ) {
                      softRelated.push(m.entity_id);
                    }
                    if (regimeConflict) batchRegimeConflicts++;
                  }
                }
              } catch (err) {
                console.error(
                  "[extract-entities] cross-doc resolve error for",
                  ent.name,
                  err,
                );
              }
            }

            if (entityId) {
              batchEntityMap.set(ent.name, entityId);
              continue;
            }

            // 5c. Новая сущность
            const insertPayload: Record<string, unknown> = {
              name: ent.name,
              canonical_name: canonical,
              entity_type: ent.type,
              description: ent.description || "",
              source_chunk_ids: chunkIds,
              source_ids: sourceIds,
            };
            if (entityEmbedding) {
              insertPayload.embedding = JSON.stringify(entityEmbedding);
            }

            const { data: inserted, error: insError } = await supabase
              .from("kg_entities")
              .upsert(insertPayload, {
                onConflict: "canonical_name,entity_type",
              })
              .select("id")
              .single();

            if (!insError && inserted) {
              entityCache.set(cacheKey, {
                id: inserted.id,
                source_chunk_ids: chunkIds,
                source_ids: sourceIds,
              });
              batchEntityMap.set(ent.name, inserted.id);
              if (!entityEmbedding) newEntityIds.push(inserted.id);
              totalEntities++;

              for (const targetId of softRelated) {
                if (targetId === inserted.id) continue;
                const { error: relErr } = await supabase
                  .from("kg_relations")
                  .insert({
                    source_entity_id: inserted.id,
                    target_entity_id: targetId,
                    relation_type: "related_to",
                    description:
                      "Семантически близкая сущность (cross-doc); merge отклонён canonical-чеком или режимным фасетом",
                    confidence: 0.6,
                    source_chunk_id: chunkIds[0] ?? null,
                    source_id: sourceIds[0] ?? null,
                  });
                if (!relErr) batchSoftLinked++;
              }
            }
          }

          if (
            batchResolvedByEmbedding > 0 ||
            batchSoftLinked > 0 ||
            batchRegimeConflicts > 0
          ) {
            console.log(
              `[extract-entities] batch ${i} (domain=${ontologyKey}): merged=${batchResolvedByEmbedding}, soft-linked=${batchSoftLinked}, regime-conflicts=${batchRegimeConflicts}, batchRegime=${batchRegime ?? "unknown"}`,
            );
          }

          // 6. Вставка связей
          for (const rel of extraction.relations) {
            if (
              !rel.source ||
              !rel.target ||
              !rel.type ||
              !RELATION_TYPES.includes(rel.type)
            )
              continue;

            const sourceId =
              batchEntityMap.get(rel.source) ||
              entityCache.get(
                `${normalize(rel.source)}::${findTypeByName(
                  extraction.entities,
                  rel.source,
                )}`,
              )?.id;
            const targetId =
              batchEntityMap.get(rel.target) ||
              entityCache.get(
                `${normalize(rel.target)}::${findTypeByName(
                  extraction.entities,
                  rel.target,
                )}`,
              )?.id;

            if (!sourceId || !targetId || sourceId === targetId) continue;

            const { error: relError } = await supabase
              .from("kg_relations")
              .insert({
                source_entity_id: sourceId,
                target_entity_id: targetId,
                relation_type: rel.type,
                description: rel.description || "",
                confidence: rel.confidence || 1.0,
                source_chunk_id: batch[0].id,
                source_id: batch[0].source_id,
              });

            if (!relError) totalRelations++;
          }

          // 7. Записать в лог
          const logEntries = batch.map((c) => ({
            chunk_id: c.id,
            source_id: c.source_id,
            entities_count: extraction.entities.length,
            relations_count: extraction.relations.length,
          }));

          await supabase
            .from("kg_extraction_log")
            .upsert(logEntries, { onConflict: "chunk_id" });

          // Пауза между батчами
          if (i + batchSize < groupChunks.length) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }

      // 8. Эмбеддинги для новых сущностей
      let embeddedCount = 0;
      if (embedEntities && newEntityIds.length > 0) {
        const { data: newEnts } = await supabase
          .from("kg_entities")
          .select("id, name, description")
          .in("id", newEntityIds)
          .is("embedding", null);

        for (const ent of newEnts || []) {
          try {
            const text = `${ent.name}. ${ent.description}`.trim();
            const emb = await embedQuery(text);
            await supabase
              .from("kg_entities")
              .update({ embedding: JSON.stringify(emb) })
              .eq("id", ent.id);
            embeddedCount++;
          } catch {
            console.error(`[extract-entities] Failed to embed entity ${ent.id}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      const totalRemaining =
        (allChunks || []).filter((c) => !processedIds.has(c.id)).length -
        chunks.length;

      return res.json({
        processed: chunks.length,
        newEntities: totalEntities,
        newRelations: totalRelations,
        embeddedEntities: embeddedCount,
        remaining: Math.max(0, totalRemaining),
        filterTags,
        crossDocResolution,
        resolveSimilarityThreshold,
        ontologyUsage,
        authMethod: auth.authMethod,
        message:
          totalRemaining > 0
            ? `Обработано ${chunks.length} чанков. Осталось ~${totalRemaining}. Запустите ещё раз.`
            : "Все чанки обработаны.",
      });
    } catch (error: unknown) {
      console.error(
        "[extract-entities] fatal error:",
        error instanceof Error ? error.message : error,
      );
      return res.status(500).json({ error: "Ошибка извлечения сущностей" });
    }
  },
);

// ══════════════════════════════════════════════════════════════════════
//   GET /api/admin/extract-entities — статистика графа (kg_stats RPC)
// ══════════════════════════════════════════════════════════════════════

router.get("/api/admin/extract-entities", async (req: Request, res: Response) => {
  const auth = await authorize(req, res);
  if (!auth) return;

  try {
    const supabase = createServiceClient();
    const { data } = await supabase.rpc("kg_stats");
    return res.json(data?.[0] || data || {});
  } catch {
    return res.status(500).json({ error: "kg_stats RPC not found" });
  }
});

export default router;
