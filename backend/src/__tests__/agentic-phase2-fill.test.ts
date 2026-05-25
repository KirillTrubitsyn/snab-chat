/**
 * Regression tests for entity-balanced Phase-2 fill in finalizeAgenticResults.
 *
 * The bug they guard against:
 *   Pre-seed sites in chat.ts inflate similarity to 0.75 (org-registry,
 *   catalog, per-entity hybrid, graph-aware) or 0.80 (NMGRES authority
 *   matrix). Before this fix, Phase-2 fill in finalizeAgenticResults
 *   ranked the unclassified pool by the boosted `similarity`. As a
 *   result, low-quality boosted chunks (originalSimilarity ≈ 0.05) won
 *   over genuine content chunks (similarity ≈ 0.55) and dominated the
 *   final 17-source list on comparative queries
 *   ("Сравни положения о закупках ЕТГК и НТСК" → Положение НТСК
 *   missing, "Перечень компаний" / "Матрица полномочий" /
 *   "Схема взаимодействия" present).
 *
 * The fix: Phase-2 sort and filter by originalSimilarity (or fallback
 * to similarity for results that never went through a pre-seed site),
 * with a soft floor of 0.30 to drop boosted-low chunks entirely.
 *
 * These tests use entityNames.length >= 2 so the LLM reranker path is
 * skipped (it makes a real Gemini call); intentAwareRerank stays in
 * the path but with intent={general, unknown} it does not mutate
 * similarities for chunks with empty tags arrays.
 */

// GoogleGenAI is instantiated at module load — supply a dummy key so the
// constructor does not throw on import. No network call is made by the
// tests below.
process.env.GOOGLE_API_KEY ||= "test-key-not-used-by-this-suite";

import { describe, it, expect } from "vitest";
import {
  finalizeAgenticResults,
  createAgenticContext,
  type AgenticContext,
} from "../lib/agentic-rag.js";
import type { SearchResult } from "../lib/retrieval.js";
import type { IntentResult } from "../lib/intent-classifier.js";

/** Tag-free chunk so intentAwareRerank / tierWeightedRerank do not mutate similarity. */
function mkChunk(
  id: string,
  filename: string,
  similarity: number,
  opts: Partial<SearchResult> = {},
): SearchResult {
  return {
    id,
    content: `content-${id}`,
    source_filename: filename,
    chunk_index: 0,
    similarity,
    tags: [],
    image_paths: [],
    ...opts,
  };
}

function ctxFrom(chunks: SearchResult[]): AgenticContext {
  const ctx = createAgenticContext();
  for (const c of chunks) ctx.chunks.set(c.id, c);
  return ctx;
}

const NEUTRAL_INTENT: IntentResult = {
  intent: "general",
  fz_type: "unknown",
  search_tags: [],
  query_variants: [],
  confidence: 0.9,
};

const QUERY = "compare ETGK and NTSK procurement regulations";
const ENTITY_HINTS = ["ETGK", "NTSK"];
const ENTITY_NAMES = ["ETGK", "NTSK"]; // length >= 2 → rerank() is skipped

describe("finalizeAgenticResults — entity-balanced Phase-2 fill", () => {
  it(
    "drops boosted-low-original chunks (Перечень компаний 0.75/0.05) " +
      "and keeps genuine content chunks (0.55) in the final list",
    async () => {
      // 4 real content chunks: 2 per entity. similarity == originalSimilarity.
      const etgk1 = mkChunk("etgk-1", "Положение_о_закупках_ETGK.docx", 0.60);
      const etgk2 = mkChunk("etgk-2", "Положение_о_закупках_ETGK.docx", 0.55);
      const ntsk1 = mkChunk("ntsk-1", "Положение_о_закупках_NTSK.docx", 0.58);
      const ntsk2 = mkChunk("ntsk-2", "Положение_о_закупках_NTSK.docx", 0.52);

      // 3 boosted-low registry chunks — boosted to 0.75 but original near zero.
      // filename matches neither hint → unclassified → flows into Phase-2 fill.
      const reg1 = mkChunk("reg-1", "Перечень_компаний_Общества.xlsx", 0.75, {
        originalSimilarity: 0.05,
        preseeded: true,
      });
      const reg2 = mkChunk("reg-2", "Матрица_полномочий.docx", 0.75, {
        originalSimilarity: 0.08,
      });
      const reg3 = mkChunk("reg-3", "Схема_взаимодействия.pdf", 0.75, {
        originalSimilarity: 0.12,
      });

      const ctx = ctxFrom([etgk1, etgk2, ntsk1, ntsk2, reg1, reg2, reg3]);

      const { results } = await finalizeAgenticResults(
        ctx,
        QUERY,
        ENTITY_HINTS,
        NEUTRAL_INTENT,
        ENTITY_NAMES,
      );

      const ids = new Set(results.map((r) => r.id));
      // All four genuine content chunks must be in the final list.
      expect(ids.has("etgk-1")).toBe(true);
      expect(ids.has("etgk-2")).toBe(true);
      expect(ids.has("ntsk-1")).toBe(true);
      expect(ids.has("ntsk-2")).toBe(true);
      // All three boosted-low registry chunks must be dropped — their
      // honest originalSimilarity (0.05/0.08/0.12) is below the Phase-2
      // floor of 0.30.
      expect(ids.has("reg-1")).toBe(false);
      expect(ids.has("reg-2")).toBe(false);
      expect(ids.has("reg-3")).toBe(false);
    },
  );

  it(
    "keeps a boosted registry chunk when its ORIGINAL similarity " +
      "is genuinely high (>= Phase-2 floor)",
    async () => {
      // One entity bucket each, plus one boosted registry chunk that *is*
      // actually relevant (original ≈ 0.55, boosted to 0.75). This must NOT
      // be filtered — the floor only drops chunks whose honest score is low.
      const etgk1 = mkChunk("etgk-1", "Положение_о_закупках_ETGK.docx", 0.60);
      const ntsk1 = mkChunk("ntsk-1", "Положение_о_закупках_NTSK.docx", 0.58);
      const goodReg = mkChunk("reg-good", "Перечень_компаний_Общества.xlsx", 0.75, {
        originalSimilarity: 0.55,
        preseeded: true,
      });

      const ctx = ctxFrom([etgk1, ntsk1, goodReg]);

      const { results } = await finalizeAgenticResults(
        ctx,
        QUERY,
        ENTITY_HINTS,
        NEUTRAL_INTENT,
        ENTITY_NAMES,
      );

      const ids = results.map((r) => r.id);
      expect(ids).toContain("etgk-1");
      expect(ids).toContain("ntsk-1");
      expect(ids).toContain("reg-good");
    },
  );

  it(
    "ranks Phase-2 fill by ORIGINAL similarity, not by boosted value " +
      "(content 0.55 beats boosted-low 0.75 with original 0.05)",
    async () => {
      // Phase-1 minPerEntity = floor(MAX_BALANCED / 2) = 6, but we only
      // give 1 chunk per entity, so Phase-1 picks both content chunks.
      // The interesting question is whether Phase-2 fill prefers the
      // remaining "content_extra" (no boost, similarity = 0.55) over the
      // boosted registry chunk (similarity = 0.75, original = 0.05).
      const etgk1 = mkChunk("etgk-1", "Положение_о_закупках_ETGK.docx", 0.60);
      const ntsk1 = mkChunk("ntsk-1", "Положение_о_закупках_NTSK.docx", 0.58);
      const extra = mkChunk("extra", "Стандарт_закупок_общий.docx", 0.55);
      const boostedJunk = mkChunk("junk", "Перечень_компаний_Общества.xlsx", 0.75, {
        originalSimilarity: 0.05,
        preseeded: true,
      });

      const ctx = ctxFrom([etgk1, ntsk1, extra, boostedJunk]);

      const { results } = await finalizeAgenticResults(
        ctx,
        QUERY,
        ENTITY_HINTS,
        NEUTRAL_INTENT,
        ENTITY_NAMES,
      );

      const ids = results.map((r) => r.id);
      expect(ids).toContain("extra");        // legitimately relevant
      expect(ids).not.toContain("junk");      // boosted-low is filtered out
    },
  );
});

describe(
  "finalizeAgenticResults — backward compatibility on chunks " +
    "without originalSimilarity",
  () => {
    it("falls back to similarity for chunks that never went through a pre-seed site", async () => {
      // No originalSimilarity field — Phase-2 must use similarity as the
      // honest score. All three should pass the 0.30 floor.
      const a = mkChunk("a", "doc-A.docx", 0.60);
      const b = mkChunk("b", "doc-B.docx", 0.55);
      const c = mkChunk("c", "other.docx", 0.45);
      const ctx = ctxFrom([a, b, c]);

      const { results } = await finalizeAgenticResults(
        ctx,
        QUERY,
        ["A", "B"], // hint matches filenames "doc-A" / "doc-B"
        NEUTRAL_INTENT,
        ["A", "B"],
      );

      const ids = results.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(["a", "b", "c"]));
    });
  },
);
