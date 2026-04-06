export interface ParsedSheet {
  name: string;
  rows: string[][];
}

/**
 * Lightweight check: does the markdown contain at least one table?
 * Looks for 2+ consecutive lines starting/ending with "|".
 */
export function containsMarkdownTable(md: string): boolean {
  const lines = md.split("\n");
  let consecutive = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("|") && t.endsWith("|")) {
      consecutive++;
      if (consecutive >= 2) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Extract markdown tables into structured sheets.
 * Splits on `## ` headings for sheet names.
 * Multiple tables without headings get "Таблица 1", "Таблица 2" names.
 */
export function parseMarkdownTables(
  md: string,
  defaultSheetName: string = "Данные"
): ParsedSheet[] {
  const sheets: ParsedSheet[] = [];
  const sections = md.split(/^## /gm);

  for (const section of sections) {
    if (!section.trim()) continue;

    const lines = section.split("\n");
    const sectionName = lines[0]?.trim() || defaultSheetName;

    // Collect all table blocks within this section
    let currentTable: string[][] = [];
    let inTable = false;

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        // Skip separator rows (|---|---|)
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
          inTable = true;
          continue;
        }

        const cells = trimmed
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim().replace(/\\\|/g, "|"));
        currentTable.push(cells);
        inTable = true;
      } else {
        if (inTable && currentTable.length > 0) {
          pushTable(sheets, sectionName, currentTable);
          currentTable = [];
        }
        inTable = false;
      }
    }

    // Flush remaining table
    if (currentTable.length > 0) {
      pushTable(sheets, sectionName, currentTable);
    }
  }

  // If no ## headings, try parsing the whole text as tables
  if (sheets.length === 0) {
    const lines = md.split("\n");
    let currentTable: string[][] = [];
    let inTable = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
          inTable = true;
          continue;
        }
        const cells = trimmed
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim().replace(/\\\|/g, "|"));
        currentTable.push(cells);
        inTable = true;
      } else {
        if (inTable && currentTable.length > 0) {
          pushTable(sheets, defaultSheetName, currentTable);
          currentTable = [];
        }
        inTable = false;
      }
    }

    if (currentTable.length > 0) {
      pushTable(sheets, defaultSheetName, currentTable);
    }
  }

  // Normalize column counts within each sheet
  for (const sheet of sheets) {
    const maxCols = Math.max(...sheet.rows.map((r) => r.length), 0);
    sheet.rows = sheet.rows.map((r) =>
      Array.from({ length: maxCols }, (_, i) => r[i] || "")
    );
  }

  return sheets;
}

function pushTable(
  sheets: ParsedSheet[],
  baseName: string,
  rows: string[][]
): void {
  // Deduplicate sheet names
  const existing = sheets.filter((s) => s.name.startsWith(baseName)).length;
  const name = existing > 0 ? `${baseName} ${existing + 1}` : baseName;
  // If there is already one with exact baseName, rename it
  if (existing === 1) {
    const first = sheets.find((s) => s.name === baseName);
    if (first) first.name = `${baseName} 1`;
  }
  sheets.push({ name, rows: [...rows] });
}
