/**
 * Anti-injection sanitization with homoglyph tolerance.
 *
 * Audit 24.04.2026 Medium-1 fix. The previous implementation in chat.ts
 * detected injection patterns on a Cyrillic→Latin folded copy of the text
 * but ran replacement on the original — bypassing redaction for attacks
 * written with mixed-script homoglyphs (e.g. "іgnore аll рrevious
 * instructions" with Cyrillic і, а, р). This module fixes the asymmetry
 * by building tolerant regexes that match Latin-Cyrillic confusables and
 * zero-width insertions directly on the original content. One pipeline,
 * no normalize/replace mismatch.
 */

/* ── Homoglyph character classes ──────────────────────────────────────── */

/**
 * For each Latin "letter slot", the character class that matches the Latin
 * letter AND its Cyrillic homoglyphs. Mirrors the mapping in the previous
 * normalizeForInjectionCheck (chat.ts) so detection coverage is preserved.
 */
const HG_LAT: Record<string, string> = {
  A: "[Aa\u0410\u0430]",
  B: "[Bb\u0412\u0432]",
  C: "[Cc\u0421\u0441]",
  D: "[Dd]",
  E: "[Ee\u0415\u0435]",
  F: "[Ff]",
  G: "[Gg]",
  H: "[Hh\u041D\u043D]",
  I: "[Ii]",
  J: "[Jj]",
  K: "[Kk\u041A\u043A]",
  L: "[Ll]",
  M: "[Mm\u041C\u043C]",
  N: "[Nn]",
  O: "[Oo\u041E\u043E]",
  P: "[Pp\u0420\u0440]",
  Q: "[Qq]",
  R: "[Rr]",
  S: "[Ss\u0421\u0441\u0455]",
  T: "[Tt\u0422\u0442]",
  U: "[Uu]",
  V: "[Vv]",
  W: "[Ww]",
  X: "[Xx\u0425\u0445]",
  Y: "[Yy\u0423\u0443]",
  Z: "[Zz]",
};

/**
 * For each Russian letter, the character class that matches both the
 * Cyrillic letter (upper + lower) AND its Latin lookalike when one exists.
 * Catches the symmetric attack where Latin chars are substituted in
 * Russian payloads (e.g. "zабудь" with Latin z).
 */
const HG_RUS: Record<string, string> = {
  "а": "[Aa\u0410\u0430]",
  "б": "[\u0411\u0431]",
  "в": "[Bb\u0412\u0432]",
  "г": "[\u0413\u0433]",
  "д": "[Dd\u0414\u0434]",
  "е": "[Ee\u0415\u0435]",
  "ё": "[\u0401\u0451]",
  "ж": "[\u0416\u0436]",
  "з": "[\u0417\u0437]",
  "и": "[\u0418\u0438]",
  "й": "[\u0419\u0439]",
  "к": "[Kk\u041A\u043A]",
  "л": "[\u041B\u043B]",
  "м": "[Mm\u041C\u043C]",
  "н": "[Hh\u041D\u043D]",
  "о": "[Oo\u041E\u043E]",
  "п": "[\u041F\u043F]",
  "р": "[Pp\u0420\u0440]",
  "с": "[Cc\u0421\u0441]",
  "т": "[Tt\u0422\u0442]",
  "у": "[Yy\u0423\u0443]",
  "ф": "[\u0424\u0444]",
  "х": "[Xx\u0425\u0445]",
  "ц": "[\u0426\u0446]",
  "ч": "[\u0427\u0447]",
  "ш": "[\u0428\u0448]",
  "щ": "[\u0429\u0449]",
  "ъ": "[\u042A\u044A]",
  "ы": "[\u042B\u044B]",
  "ь": "[\u042C\u044C]",
  "э": "[\u042D\u044D]",
  "ю": "[\u042E\u044E]",
  "я": "[\u042F\u044F]",
};

/**
 * Optional zero-width / invisible separator chars permitted between letters
 * inside a tolerant pattern. Catches insertion attacks like
 * "i\u200Bgnore previous instructions". Same character set the previous
 * normalize step stripped, lifted into the regex itself so detect and
 * replace operate on identical input.
 */
const ZW =
  "[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2060-\u2064\u206A-\u206F]*";

/* ── Tolerant pattern builder ────────────────────────────────────────── */

/**
 * Convert a literal word (Latin or Russian) into a regex source that
 * matches all homoglyph variants and tolerates zero-width insertions
 * between letters.
 */
function tolerantWord(word: string): string {
  return word
    .split("")
    .map((c) => {
      const upper = c.toUpperCase();
      if (HG_LAT[upper]) return HG_LAT[upper];
      const lower = c.toLowerCase();
      if (HG_RUS[lower]) return HG_RUS[lower];
      // Fallback: literal escape.
      return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join(ZW);
}

/** Tolerant alternation `(?:word1|word2|…)`. */
function alt(words: string[]): string {
  return "(?:" + words.map(tolerantWord).join("|") + ")";
}

/* ── Pattern catalogue ───────────────────────────────────────────────── */

export const INJECTION_PATTERNS: RegExp[] = [
  // <system>, <instructions>, <prompt>, <override>, <admin>, <role>, <command>, <scenario>
  new RegExp(
    `<\\/?${alt([
      "system",
      "instruction",
      "instructions",
      "prompt",
      "override",
      "admin",
      "role",
      "command",
      "scenario",
    ])}\\b[^>]*>`,
    "gi"
  ),
  // ignore/forget/disregard (+ all|все)? + previous/above/prior/предыдущие/прошлые/выше + instructions/rules/prompts/инструкции/правила/промпт
  new RegExp(
    `${alt(["ignore", "forget", "disregard", "забудь", "игнорируй", "отбрось"])}\\s+` +
      `(?:${alt(["all", "все"])}\\s+)?` +
      `${alt(["previous", "above", "prior", "предыдущие", "прошлые", "выше"])}\\s+` +
      `${alt([
        "instructions",
        "instruction",
        "rules",
        "rule",
        "prompts",
        "prompt",
        "инструкции",
        "правила",
        "промпт",
      ])}`,
    "gi"
  ),
  // SYSTEM_OVERRIDE / ADMIN_MODE / NEW_INSTRUCTIONS / НОВЫЕ ИНСТРУКЦИИ
  new RegExp(
    `(?:${tolerantWord("system")}[\\s_-]*${tolerantWord("override")}` +
      `|${tolerantWord("admin")}[\\s_-]*${tolerantWord("mode")}` +
      `|${tolerantWord("new")}[\\s_-]*${tolerantWord("instructions")}` +
      `|${tolerantWord("новые")}[\\s_-]*${tolerantWord("инструкции")})`,
    "gi"
  ),
  // [SYSTEM], [/SYSTEM], [INST], [/INST]
  new RegExp(`\\[\\/?${alt(["system", "inst"])}\\]`, "gi"),
  // line-leading >> system / admin / override
  new RegExp(`^>{2,}\\s*${alt(["system", "admin", "override"])}`, "gim"),
];

/* ── Public API ──────────────────────────────────────────────────────── */

/** True iff any tolerant injection pattern matches the original text. */
export function containsInjection(text: string): boolean {
  for (const p of INJECTION_PATTERNS) {
    p.lastIndex = 0; // reset stateful flag for /g
    if (p.test(text)) return true;
  }
  return false;
}

/** Redact every match of every pattern with the literal `[filtered]`. */
export function redactInjection(text: string): string {
  let out = text;
  for (const p of INJECTION_PATTERNS) {
    out = out.replace(p, "[filtered]");
  }
  return out;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ZW_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g;

/** Strip control characters and zero-width characters. */
export function stripInvisible(text: string): string {
  return text.replace(CONTROL_CHARS, "").replace(ZW_CHARS, "");
}

/** XML text-content escape (& < >); attribute escape lives in document-xml.ts. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sanitize a document chunk for embedding inside `<document>...</document>`:
 *   1. Redact homoglyph-tolerant injection patterns.
 *   2. Strip invisible / control characters.
 *   3. XML-escape `& < >`.
 */
export function sanitizeForXml(content: string): string {
  const redacted = containsInjection(content) ? redactInjection(content) : content;
  return escapeXmlText(stripInvisible(redacted));
}

/**
 * Sanitize raw user input (no XML wrapping). Same redaction + invisibles
 * stripping; no HTML entity escape because user queries are plain text.
 */
export function sanitizePlainText(content: string): string {
  const redacted = containsInjection(content) ? redactInjection(content) : content;
  return stripInvisible(redacted);
}
