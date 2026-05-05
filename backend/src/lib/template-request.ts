/**
 * Detector for "give me the template" / "form" / "blank" requests.
 *
 * Templates are semantically poor (tables with placeholders, headers, no
 * narrative), so cosine similarity loses them to descriptive methodology
 * documents. The user observed this on 04.05.2026 ("Замечание №4"): the
 * ТЗ template for ЕТГК was loaded into the KB but the chat answered with a
 * description of "what a ТЗ is" instead of returning the file.
 *
 * Strategy:
 *   1. Detect the request by keyword (zero latency).
 *   2. Boost tags «форма», «шаблон» in retrieval rerank (see retrieval.ts).
 *   3. Look up matching sources directly by tag + entity hint, and inject
 *      a download link into the system prompt. If `original_file_url` is
 *      empty (true for legacy ingest paths), derive a signed URL on the
 *      fly from `storage_path` against the Supabase Storage `documents`
 *      bucket.
 */

import { createServiceClient } from "./supabase.js";

const TEMPLATE_KEYWORDS: RegExp[] = [
  /\bшаблон\b/i,
  /\bформ[аыу]\b/i,
  /\bбланк/i,
  /\bобраз(?:е|цо)/i,
  /\bтиповой/i,
];

const NEGATION_PATTERNS: RegExp[] = [
  /\bне\s+нужен\s+(?:шаблон|форм)/i,
  /\bбез\s+(?:шаблон|форм)/i,
];

const ACTION_KEYWORDS: RegExp[] = [
  /\bдай\b/i,
  /\bпредостав/i,
  /\bпришли\b/i,
  /\bвышли\b/i,
  /\bпокаж/i,
  /\bнужен\b/i,
  /\bищу\b/i,
  /\bесть ли\b/i,
];

export function isTemplateRequest(query: string): boolean {
  const q = query.toLowerCase();
  if (NEGATION_PATTERNS.some((rx) => rx.test(q))) return false;
  const hasKeyword = TEMPLATE_KEYWORDS.some((rx) => rx.test(q));
  if (!hasKeyword) return false;
  if (ACTION_KEYWORDS.some((rx) => rx.test(q))) return true;
  return q.length < 80;
}

/* ── Source resolver ── */

export interface TemplateSourceHit {
  filename: string;
  original_filename: string | null;
  original_file_url: string | null;
  storage_path: string | null;
  tags: string[];
  folder_path: string | null;
}

const TEMPLATE_TAGS = ["форма", "шаблон", "образец", "бланк"];
const STORAGE_BUCKET = "documents";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours

/**
 * Find sources that look like templates and (optionally) match an entity hint
 * extracted from the query. Returns up to `limit` matches.
 */
export async function findTemplateSources(
  query: string,
  entityHints: string[] = [],
  limit: number = 4,
): Promise<TemplateSourceHit[]> {
  const supabase = createServiceClient();
  let q = supabase
    .from("sources")
    .select("filename, original_filename, original_file_url, storage_path, tags, folder_path")
    .overlaps("tags", TEMPLATE_TAGS)
    .limit(50);

  for (const hint of entityHints.slice(0, 3)) {
    q = q.ilike("filename", `%${hint}%`);
  }

  const { data, error } = await q;
  if (error || !data) {
    console.warn("findTemplateSources error:", error?.message);
    return [];
  }
  return (data as TemplateSourceHit[]).slice(0, limit);
}

/**
 * Resolve a download URL for a template hit. Prefers the precomputed
 * `original_file_url`; falls back to a signed URL generated from
 * `storage_path` (legacy sources ingested before original_file_url was
 * populated).
 */
export async function resolveTemplateUrl(
  hit: TemplateSourceHit,
): Promise<string | null> {
  if (hit.original_file_url && hit.original_file_url.length > 0) {
    return hit.original_file_url;
  }
  if (!hit.storage_path) return null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(hit.storage_path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.warn(
      `resolveTemplateUrl: failed to sign storage_path=${hit.storage_path}: ${error?.message}`,
    );
    return null;
  }
  return data.signedUrl;
}

export async function generateTemplatePromptBlock(
  hits: TemplateSourceHit[],
): Promise<string> {
  if (hits.length === 0) return "";

  const resolved = await Promise.all(
    hits.map(async (h) => ({ hit: h, url: await resolveTemplateUrl(h) })),
  );

  let block = `\n=== ШАБЛОНЫ В БАЗЕ ЗНАНИЙ ===\n\n`;
  block += `Пользователь запросил шаблон / форму / бланк / образец. Ниже — найденные документы. ОБЯЗАТЕЛЬНО включи в ответ ссылку для скачивания каждого подходящего шаблона. Не пересказывай структуру и содержание шаблона как замену самого файла.\n\n`;
  for (const { hit, url } of resolved) {
    const display = hit.original_filename ?? hit.filename;
    if (url) {
      block += `• [${display}](${url})`;
    } else {
      block += `• ${display} — ссылка на оригинал отсутствует, попроси пользователя обратиться к администратору`;
    }
    if (hit.folder_path) block += ` (раздел: ${hit.folder_path})`;
    block += `\n`;
  }
  block += `\nФормат ответа: 1) краткое подтверждение, что шаблон найден; 2) ссылка для скачивания; 3) короткое описание ключевых полей шаблона. Если ни один шаблон не подходит под уточнение пользователя — честно скажи об этом и предложи альтернативу.\n`;
  return block;
}
