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
  let documentHint: string | null = null;

  // Common document name patterns in procurement context
  const docPatterns: Array<{ re: RegExp; hint: string }> = [
    { re: /положени[яеийюём]\s*(о\s*)?закупк/i, hint: "положение" },
    { re: /положени[яеийюём]\s*(о\s*)?закупочн/i, hint: "положение" },
    { re: /стандарт[аеуом]?\s/i, hint: "стандарт" },
    { re: /инструкци[яиейюём]/i, hint: "инструкци" },
    { re: /методик[аиейу]/i, hint: "методик" },
    { re: /регламент[аеуом]?/i, hint: "регламент" },
    { re: /223[\-\s]*фз/i, hint: "223" },
    { re: /порядк[аеуом]?/i, hint: "порядок" },
  ];

  for (const dp of docPatterns) {
    if (dp.re.test(lower)) {
      documentHint = dp.hint;
      break;
    }
  }

  return { sections: Array.from(sections), documentHint };
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
  if (/223[\-\s]*фз/i.test(lower) && !/вне\s+223/i.test(lower)) hints.push("223-фз");
  if (/вне\s+223|не\s+по\s+223|без\s+223/i.test(lower)) hints.push("вне 223-фз");

  // Work type hints (lowercase)
  if (/\bсмр\b|строительн/i.test(lower)) hints.push("смр");
  if (/\bпир\b|проектн/i.test(lower)) hints.push("пир");

  // Organization hints (lowercase)
  if (/сибэм\b/i.test(lower)) hints.push("сибэм");
  if (/нак\s*азот|нмгрэс/i.test(lower)) hints.push("нак азот");

  // Return null if too few hints (don't filter, search everything)
  return hints.length > 0 ? hints : null;
}
