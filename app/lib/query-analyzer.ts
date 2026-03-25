/**
 * Analyzes user query and extracts tag hints for filtering hybrid search.
 * Returns null if no specific filter can be determined (search all docs).
 */
export function extractSearchHints(query: string): string[] | null {
  const lower = query.toLowerCase();
  const hints: string[] = [];

  // Information system hints
  if (/\bsrm\b/i.test(query)) hints.push("SRM");
  if (/\bb2b\b/i.test(query)) hints.push("B2B");
  if (/\bиаис\b/i.test(lower)) hints.push("ИАИС");
  if (/\bsap\b/i.test(query) || /\bмм226\b/i.test(lower) || /\bторо\b/i.test(lower)) hints.push("SAP");

  // Pricing hints
  if (/индекс|фер|гэсн|базов\w+ цен|чел[\-\s]*час|смет|нмцд|расценк/i.test(lower)) {
    hints.push("ценообразование");
  }

  // Process-specific hints
  if (/единственн\w+ источник|еи\b/i.test(lower)) hints.push("единственный источник");
  if (/аварийн\w+ закупк/i.test(lower)) hints.push("аварийная закупка");
  if (/рамочн\w+ договор/i.test(lower)) hints.push("рамочный договор");

  // Regulation scope
  if (/223[\-\s]*фз/i.test(lower) && !/вне\s+223/i.test(lower)) hints.push("223-ФЗ");
  if (/вне\s+223|не\s+по\s+223|без\s+223/i.test(lower)) hints.push("вне 223-ФЗ");

  // Work type hints
  if (/\bсмр\b|строительн/i.test(lower)) hints.push("СМР");
  if (/\bпир\b|проектн/i.test(lower)) hints.push("ПИР");

  // Organization hints
  if (/сибэм\b/i.test(lower)) hints.push("СибЭМ");
  if (/нак\s*азот|нмгрэс/i.test(lower)) hints.push("НАК Азот");

  // Return null if too few hints (don't filter, search everything)
  return hints.length > 0 ? hints : null;
}
