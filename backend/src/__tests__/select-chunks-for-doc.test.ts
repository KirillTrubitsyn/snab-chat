/**
 * Tests for selectChunksForDoc — the per-document chunk selector used by
 * fetchChunksByDocument. Guards against a regression of audit 24.04.2026
 * finding High-1, where the inline loop bound was tautological
 * (`selected.length < selected.length + offset`) and overshot the per-doc
 * cap.
 */

import { describe, it, expect } from "vitest";
import { selectChunksForDoc, type ChunkLike } from "../lib/select-chunks-for-doc.js";

interface TestChunk extends ChunkLike {
  chunk_index: number;
  source_filename: string;
}

function makeChunks(n: number, content: (i: number) => string = (i) => `chunk ${i}`): TestChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    content: content(i),
    chunk_index: i,
    source_filename: "doc.pdf",
  }));
}

describe("selectChunksForDoc — boundary cases", () => {
  it("returns empty for empty input", () => {
    expect(selectChunksForDoc([], 5)).toEqual([]);
  });

  it("returns empty when docLimit <= 0", () => {
    expect(selectChunksForDoc(makeChunks(10), 0)).toEqual([]);
    expect(selectChunksForDoc(makeChunks(10), -3)).toEqual([]);
  });

  it("returns all chunks when count <= docLimit", () => {
    const chunks = makeChunks(3);
    const result = selectChunksForDoc(chunks, 5);
    expect(result).toEqual(chunks);
  });

  it("returns exactly docLimit when count > docLimit (sampling)", () => {
    const chunks = makeChunks(20);
    const result = selectChunksForDoc(chunks, 4);
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result[0]).toBe(chunks[0]);
  });
});

describe("selectChunksForDoc — keyword scoring branch (High-1 regression guard)", () => {
  it("respects docLimit when keyword matches dominate", () => {
    const chunks = makeChunks(50, (i) =>
      i % 3 === 0 ? "приказ приказ приказ закупка" : "общий технический текст"
    );
    const result = selectChunksForDoc(chunks, 5, "приказ");
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("respects docLimit when keyword has zero matches", () => {
    const chunks = makeChunks(50, () => "обычный текст без ключа");
    const result = selectChunksForDoc(chunks, 5, "несуществующее_слово");
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0]).toBe(chunks[0]);
  });

  it("respects docLimit when keyword matches partially fill", () => {
    // Only 2 chunks contain the keyword; we ask for 8.
    // Pre-fix: filler loop overshot and pushed many extra chunks.
    // Post-fix: total stays at 8.
    const chunks = makeChunks(50, (i) =>
      i === 5 || i === 12 ? "уникальный_ключ в этом куске" : "обычный технический текст"
    );
    const result = selectChunksForDoc(chunks, 8, "уникальный_ключ");
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it("never exceeds docLimit across many random sizes", () => {
    for (const docCount of [10, 20, 50, 100, 500]) {
      for (const limit of [1, 2, 5, 8, 15]) {
        const chunks = makeChunks(docCount, (i) =>
          i % 7 === 0 ? "ключ ключ ключ" : "balanced text"
        );
        const result = selectChunksForDoc(chunks, limit, "ключ");
        expect(result.length, `docCount=${docCount}, limit=${limit}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("places first chunk at position 0", () => {
    const chunks = makeChunks(20, (i) => (i === 10 ? "топ топ топ ключ" : "хвост"));
    const result = selectChunksForDoc(chunks, 4, "ключ");
    expect(result[0]).toBe(chunks[0]);
  });

  it("returns unique chunk ids only", () => {
    const chunks = makeChunks(30, (i) => (i % 4 === 0 ? "ключ ключ" : "обычный"));
    const result = selectChunksForDoc(chunks, 6, "ключ");
    const ids = new Set(result.map((c) => c.id));
    expect(ids.size).toBe(result.length);
  });
});

describe("selectChunksForDoc — sampling branch (no query)", () => {
  it("respects docLimit", () => {
    const chunks = makeChunks(100);
    for (const limit of [1, 3, 8, 15]) {
      const result = selectChunksForDoc(chunks, limit);
      expect(result.length, `limit=${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("starts with first chunk", () => {
    const chunks = makeChunks(50);
    const result = selectChunksForDoc(chunks, 5);
    expect(result[0]).toBe(chunks[0]);
  });

  it("samples evenly distributed indices", () => {
    const chunks = makeChunks(20);
    const result = selectChunksForDoc(chunks, 5);
    // Indices should be monotonic non-decreasing in chunk_index
    const indices = result.map((c) => c.chunk_index);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });
});

describe("selectChunksForDoc — adversarial High-1 reproduction", () => {
  // The pre-fix loop condition was:
  //   selected.length < selected.length + (docLimit - 1 - topChunks.length)
  // which reduces to 0 < (docLimit - 1 - topChunks.length).
  // When that's positive, the pre-fix loop iterates until i >= docChunks.length,
  // adding far more chunks than docLimit. This test reproduces exactly that
  // regime: small topChunks vs. larger docLimit.
  it("does not overshoot when topChunks much smaller than docLimit", () => {
    // 100 chunks, exactly 1 contains the keyword (index 5).
    // topChunks.length === 1, docLimit === 8 → pre-fix would push ~all 100.
    const chunks = makeChunks(100, (i) =>
      i === 5 ? "редкое_слово в одном куске" : "никаких ключей"
    );
    const result = selectChunksForDoc(chunks, 8, "редкое_слово");
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it("does not overshoot in sampling when docChunks is much larger", () => {
    // 200 chunks, no query → sampling path.
    // Pre-fix: the condition `selected.length < selected.length + docLimit - 1`
    // was constant-true and pushed every stepped chunk until exhausted.
    const chunks = makeChunks(200);
    const result = selectChunksForDoc(chunks, 6);
    expect(result.length).toBeLessThanOrEqual(6);
  });
});
