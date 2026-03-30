/* ── Section reference detection ── */

export interface SectionReference {
  /** Section identifiers found, e.g. ["61", "61.1"] */
  sections: string[];
  /** Document name hint extracted from query (partial match) */
  documentHint: string | null;
}

/**
 * Detects references to specific document sections/points in user query.
 * E.g. "пункт 61 Положения о закупках" → { sections: ["61"], documentHint: "положен" }
 */
export function detectSectionReference(query: string): SectionReference | null {
  const lower = query.toLowerCase();

  // Match patterns: пункт 61, п. 61, п.61, раздел 5, статья 12, ст. 12, глава 3, часть 2
  // Also: пункта 61, пунктом 61, пунктов 61 (Russian case forms)
  const sectionPatterns = [
    /(?:пункт[аеуом]?[мвыхи]?)\s+(\d+(?:\.\d+)*)/gi,
    /(?:п\.?\s*)(\d+(?:\.\d+)*)/gi,
    /(?:раздел[аеуом]?[мвыхи]?)\s+(\d+(?:\.\d+)*)/gi,
    /(?:стать[яиейюёй])\s+(\d+(?:\.\d+)*)/gi,
    /(?:ст\.?\s*)(\d+(?:\.\d+)*)/gi,
    /(?:глав[аеуыой]?)\s+(\d+(?:\.\d+)*)/gi,
    /(?:част[ьиейю])\s+(\d+(?:\.\d+)*)/gi,
    /(?:приложени[еяийюём])\s+(?:№\s*)?(\d+)/gi,
  ];

  const sections = new Set<string>();
  for (const pattern of sectionPatterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      sections.add(match[1]);
    }
  }

  if (sections.size === 0) return null;

  // Try to extract document name hint
  const documentHint = extractDocumentHint(lower);

  return { sections: Array.from(sections), documentHint };
}

/* ── Document name reference detection ── */

export interface DocumentReference {
  /** Filename substring hints for ILIKE matching */
  filenameHints: string[];
}

/**
 * Extracts document hint from query text (lowercase).
 * Returns a substring for ILIKE matching against source_filename.
 */
function extractDocumentHint(lower: string): string | null {
  // 1. Direct filename mention (with extension)
  const filenameMatch = lower.match(/[а-яёa-z0-9_\-]+\.(?:docx?|pdf|xlsx?)/i);
  if (filenameMatch) {
    // Strip extension and return the name part
    return filenameMatch[0].replace(/\.(?:docx?|pdf|xlsx?)$/i, "");
  }

  // 2. Quoted document name: «...» or "..."
  const quotedMatch = lower.match(/[«"]([^»"]+)[»"]/);
  if (quotedMatch && quotedMatch[1].length > 3) {
    return quotedMatch[1];
  }

  // 3. Common document type patterns with distinguishing keywords
  const docPatterns: Array<{ re: RegExp; hint: string }> = [
    // Specific documents with organization names
    { re: /положени[яеийюём]\s*(?:о\s*)?закупк\S*\s+(?:сгк|сибирск)/i, hint: "положен" },
    { re: /положени[яеийюём]\s*(?:о\s*)?закупк/i, hint: "положен" },
    { re: /положени[яеийюём]\s*(?:о\s*)?закупочн/i, hint: "положен" },
    { re: /стандарт[аеуом]?\s+закуп/i, hint: "стандарт" },
    { re: /стандарт[аеуом]?\s+планиров/i, hint: "стандарт" },
    { re: /стандарт[аеуом]?\s/i, hint: "стандарт" },
    { re: /инструкци[яиейюём]/i, hint: "инструкци" },
    { re: /методик[аиейу]/i, hint: "методик" },
    { re: /регламент[аеуом]?/i, hint: "регламент" },
    { re: /порядк[аеуом]?/i, hint: "порядок" },
  ];

  for (const dp of docPatterns) {
    if (dp.re.test(lower)) {
      return dp.hint;
    }
  }

  return null;
}

/**
 * Detects when user explicitly references a specific document by name.
 * Returns filename hints for direct chunk lookup.
 *
 * Handles:
 * - Explicit filenames: "Положение_о_закупках_СГК-Новосибирск_ред_15.docx"
 * - Quoted names: «Положение о закупках СГК-Новосибирск»
 * - Natural references: "в положении о закупках СГК-Новосибирск"
 * - Organization-specific: "положение СГК-Новосибирск", "стандарт НАК Азот"
 */
export function detectDocumentReference(query: string): DocumentReference | null {
  const lower = query.toLowerCase();
  const hints: string[] = [];

  // 1. Direct filename mention (with extension) — highest priority
  const filenameMatch = query.match(/[\wА-Яа-яёЁ_\-]+\.(?:docx?|pdf|xlsx?)/i);
  if (filenameMatch) {
    const name = filenameMatch[0].replace(/\.(?:docx?|pdf|xlsx?)$/i, "");
    hints.push(name);
  }

  // 2. Quoted document name
  const quotedPatterns = [/«([^»]+)»/g, /"([^"]+)"/g, /„([^"]+)"/g];
  for (const pattern of quotedPatterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      if (match[1].length > 5) {
        hints.push(match[1]);
      }
    }
  }

  // 3. Organization-specific document references
  // "положение о закупках СГК-Новосибирск" → hints: ["положен", "новосибирск"]
  const orgPatterns: Array<{ re: RegExp; hints: string[] }> = [
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(сгк[\-\s]*новосибирск)/i, hints: ["новосибирск"] },
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(кузбасс)/i, hints: ["кузбасс"] },
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(енисей)/i, hints: ["енисей"] },
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(сгк[\-\s]*алтай)/i, hints: ["алтай"] },
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(нак[\-\s]*азот|новомосковск)/i, hints: ["нак", "азот"] },
    { re: /(?:положени|стандарт|инструкци|регламент|порядок)\S*\s+.*?(сибэм)/i, hints: ["сибэм"] },
  ];

  for (const op of orgPatterns) {
    if (op.re.test(lower)) {
      hints.push(...op.hints);
      break;
    }
  }

  // 3b. Direct entity/object mentions (without document type prefix)
  // "срочная закупка на НМГРЭС" → hints: ["нмгрэс"]
  const entityPatterns: Array<{ re: RegExp; hints: string[] }> = [
    { re: /\bнмгрэс\b/i, hints: ["нмгрэс"] },
    { re: /\bнак[\-\s]*азот\b/i, hints: ["нак", "азот"] },
    { re: /\bсгк[\-\s]*новосибирск\b/i, hints: ["новосибирск"] },
    { re: /\bсгк[\-\s]*алтай\b/i, hints: ["алтай"] },
    { re: /\bенисейск\S*\s+тгк\b/i, hints: ["енисей"] },
    { re: /\bкузбассэнерго\b/i, hints: ["кузбасс"] },
    { re: /\bсибэм\b/i, hints: ["сибэм"] },
    { re: /\bнтск\b/i, hints: ["нтск"] },
    { re: /\bбарнаул/i, hints: ["алтай"] },
    { re: /\bкрасноярск/i, hints: ["енисей"] },
    { re: /\bкемеров/i, hints: ["кузбасс"] },
    { re: /\bновосибирск/i, hints: ["новосибирск"] },
    { re: /\bновомосковск/i, hints: ["нмгрэс"] },
  ];

  if (hints.length === 0) {
    for (const ep of entityPatterns) {
      if (ep.re.test(lower)) {
        hints.push(...ep.hints);
        break;
      }
    }
  }

  // 4. Generic document type + any distinguishing words
  // "положение о закупках ред 15" → ["положен", "ред_15" or "ред 15"]
  const redMatch = lower.match(/ред(?:акци[яиейю])?\s*(?:№?\s*)(\d+)/);
  if (redMatch) {
    hints.push(`ред_${redMatch[1]}`);
    hints.push(`ред ${redMatch[1]}`);
  }

  if (hints.length === 0) return null;

  return { filenameHints: hints };
}

/**
 * Analyzes user query and extracts tag hints for filtering hybrid search.
 * Returns null if no specific filter can be determined (search all docs).
 */
export function extractSearchHints(query: string): string[] | null {
  const lower = query.toLowerCase();
  const hints: string[] = [];

  // Information system hints (all lowercase to match stored tags)
  if (/\bsrm\b/i.test(query)) hints.push("srm");
  if (/\bb2b\b/i.test(query)) hints.push("b2b");
  if (/\bиаис\b/i.test(lower)) hints.push("иаис");
  if (/\bsap\b/i.test(query) || /\bмм226\b/i.test(lower) || /\bторо\b/i.test(lower)) hints.push("sap");

  // Pricing hints
  if (/индекс|фер|гэсн|базов\w+ цен|чел[\-\s]*час|смет|нмцд|расценк/i.test(lower)) {
    hints.push("ценообразование");
  }

  // Process-specific hints
  if (/единственн\w+ источник|еи\b/i.test(lower)) hints.push("единственный источник");
  if (/аварийн\w+ закупк/i.test(lower)) hints.push("аварийная закупка");
  if (/рамочн\w+ договор/i.test(lower)) hints.push("рамочный договор");

  // Regulation scope (lowercase to match stored tags)
  // Detect "вне 223-ФЗ" patterns first (more specific)
  const isNon223 = /вне\s+223|не\s+по\s+223|без\s+223|не\s+в\s+рамках\s+(?:фз[\-\s]*)?223|не\s+в\s+рамках\s+223[\-\s]*фз|не\s+(?:по|в\s+рамках)\s+(?:фз[\-\s]*)?223|не\s+подпада\S*\s+под\s+223/i.test(lower);
  if (isNon223) {
    hints.push("вне 223-фз");
  } else if (/223[\-\s]*фз|фз[\-\s]*223/i.test(lower)) {
    hints.push("223-фз");
  }

  // Work type hints (lowercase)
  if (/\bсмр\b|строительн/i.test(lower)) hints.push("смр");
  if (/\bпир\b|проектн/i.test(lower)) hints.push("пир");

  // Organization hints (lowercase)
  if (/сибэм\b/i.test(lower)) hints.push("сибэм");
  if (/нак\s*азот|нмгрэс/i.test(lower)) hints.push("нак азот");

  // Return null if too few hints (don't filter, search everything)
  return hints.length > 0 ? hints : null;
}
