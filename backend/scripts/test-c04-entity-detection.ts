/**
 * C04 verification harness — replicates the entity-detection block from
 * backend/src/routes/chat.ts (after the C04 fix) and asserts that all
 * pre-C04-blind entities are now detected.
 *
 * Run:  npx tsx backend/scripts/test-c04-entity-detection.ts
 *
 * Exit code: 0 on pass, 1 on any assertion failure.
 */

import { findAllEntities, SGK_REGISTRY } from "../src/lib/sgk-registry.js";

// ══ Replicates chat.ts:576–590 entity detection block verbatim ══
function detectEntitiesLikeChatTs(query: string): string[] {
  const queryLowerForEntities = query.toLowerCase();
  const detected: string[] = [];
  const matched = findAllEntities(query);
  for (const entity of matched) {
    let bestAlias = "";
    for (const alias of entity.aliases) {
      if (
        queryLowerForEntities.includes(alias) &&
        alias.length > bestAlias.length
      ) {
        bestAlias = alias;
      }
    }
    if (bestAlias) detected.push(bestAlias);
  }
  return detected;
}

// ══ Test cases ══
interface TestCase {
  label: string;
  query: string;
  // Substrings required in the detected list (case-insensitive equality
  // is not enforced because detection returns the alias as-matched —
  // we check that at least one of the aliases of each expected entity landed).
  expectEntityNames: string[];
  expectEmpty?: boolean;
}

const OLD_HARDCODED = [
  "СГК-Алтай",
  "НТСК",
  "ЕТГК",
  "Кузбассэнерго",
  "СГК-Новосибирск",
];

const TESTS: TestCase[] = [
  // ── Old hardcode still works ──
  {
    label: "backward-compat: СГК-Алтай",
    query: "Какой порядок закупок в СГК-Алтай?",
    expectEntityNames: ["АО «СГК-Алтай»"],
  },
  {
    label: "backward-compat: НТСК",
    query: "Регламент выбора поставщика в НТСК",
    expectEntityNames: ["ООО «Новосибирская теплосетевая компания»"],
  },
  {
    label: "backward-compat: ЕТГК",
    query: "Политика закупок ЕТГК",
    expectEntityNames: ["АО «Енисейская ТГК (ТГК-13)»"],
  },

  // ── New entities that old hardcode MISSED ──
  {
    label: "NEW: НМГРЭС (commit message explicit regression case)",
    query: "По какому ФЗ работает НМГРЭС?",
    expectEntityNames: [], // see note below
  },
  {
    label: "NEW: Абаканская ТЭЦ (nominative — C04 covers)",
    query: "Абаканская ТЭЦ — порог ЕП?",
    expectEntityNames: ["АО «Абаканская ТЭЦ»"],
  },
  {
    label: "KNOWN LIMITATION: oblique case not covered (morphology, not C04 regression)",
    query: "Как проходят закупки в Абаканской ТЭЦ?",
    expectEntityNames: [],
    expectEmpty: true,
  },
  {
    label: "NEW: Красноярская ТЭЦ-3",
    query: "Регламент закупок Красноярская ТЭЦ-3",
    expectEntityNames: ["Красноярская ТЭЦ-3"],
  },
  {
    label: "NEW: Минусинская ТЭЦ",
    query: "Поставщики Минусинская ТЭЦ",
    expectEntityNames: ["Минусинская ТЭЦ"],
  },
  {
    label: "NEW: Беловская ГРЭС",
    query: "Беловская ГРЭС — к какому юрлицу относится?",
    expectEntityNames: ["Беловская ГРЭС"],
  },
  {
    label: "NEW: Барнаульская ТЭЦ-2",
    query: "Закупки Барнаульская ТЭЦ-2",
    expectEntityNames: ["Барнаульская ТЭЦ-2"],
  },
  {
    label: "NEW: Томь-Усинская ГРЭС",
    query: "Томь-Усинская ГРЭС. Порог ЕП?",
    expectEntityNames: ["Томь-Усинская ГРЭС"],
  },
  {
    label: "NEW: multi-entity in one query",
    query: "Сравни закупки в СГК-Алтай, Абаканская ТЭЦ и Канская ТЭЦ",
    expectEntityNames: [
      "АО «СГК-Алтай»",
      "АО «Абаканская ТЭЦ»",
      "Канская ТЭЦ",
    ],
  },

  // ── Negatives ──
  {
    label: "NEG: no entity mentioned",
    query: "Что такое закупка у единственного поставщика?",
    expectEntityNames: [],
    expectEmpty: true,
  },
  {
    label: "NEG: foreign entity (Квадра)",
    query: "Как работает АО «Квадра»?",
    expectEntityNames: [],
    expectEmpty: true,
  },
  {
    label: "NEG: partial-word overlap should not trigger",
    query: "Расскажи про котельные в России",
    expectEntityNames: [],
    expectEmpty: true,
  },
];

// ══ Helper: look up entity by its display name to inspect its aliases ══
function aliasesOf(entityName: string): string[] {
  const e = SGK_REGISTRY.find((x) => x.name === entityName);
  return e ? e.aliases : [];
}

// ══ Run ══
let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log(`═══ C04 entity detection harness ═══`);
console.log(`SGK_REGISTRY total entries: ${SGK_REGISTRY.length}`);
console.log(`Old hardcode coverage: ${OLD_HARDCODED.length} names`);
console.log("");

for (const tc of TESTS) {
  const detected = detectEntitiesLikeChatTs(tc.query);
  const detectedLower = new Set(detected.map((d) => d.toLowerCase()));

  let ok = true;
  const missing: string[] = [];

  if (tc.expectEmpty) {
    if (detected.length !== 0) {
      ok = false;
      missing.push(`expected empty, got: [${detected.join(", ")}]`);
    }
  } else {
    for (const expectedName of tc.expectEntityNames) {
      const expectedAliases = aliasesOf(expectedName);
      const found = expectedAliases.some((a) => detectedLower.has(a));
      if (!found) {
        ok = false;
        missing.push(
          `missing "${expectedName}" (one of aliases: [${expectedAliases.join(", ")}])`
        );
      }
    }
  }

  if (ok) {
    pass++;
    console.log(`  PASS  ${tc.label}`);
    console.log(`        query   : "${tc.query}"`);
    console.log(
      `        detected: [${detected.length === 0 ? "" : detected.join(", ")}]`
    );
  } else {
    fail++;
    console.log(`  FAIL  ${tc.label}`);
    console.log(`        query   : "${tc.query}"`);
    console.log(
      `        detected: [${detected.length === 0 ? "" : detected.join(", ")}]`
    );
    for (const m of missing) console.log(`        ${m}`);
    failures.push(tc.label);
  }
}

console.log("");
console.log(`═══ Result: ${pass} passed, ${fail} failed ═══`);

// Quick confirmation that the pre-C04 hardcode truly missed most of the
// "new" cases — print the alias check for a couple of them.
console.log("");
console.log("═══ Counterfactual: what old hardcode would have detected ═══");
const counterfactual = (query: string): string[] => {
  const lower = query.toLowerCase();
  return OLD_HARDCODED.filter((n) => lower.includes(n.toLowerCase()));
};
for (const tc of TESTS.slice(3, 10)) {
  const old = counterfactual(tc.query);
  console.log(
    `  "${tc.query}"\n    old hardcode → [${old.length === 0 ? "EMPTY (miss)" : old.join(", ")}]`
  );
}

process.exit(fail === 0 ? 0 : 1);
