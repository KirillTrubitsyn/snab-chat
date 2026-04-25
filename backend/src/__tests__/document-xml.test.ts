/**
 * Tests for buildDocumentXml — the <document> formatter for the RAG context.
 * Guards against a regression of audit 24.04.2026 finding High-2, where the
 * system prompt referenced a `tags` XML attribute that was never emitted.
 */

import { describe, it, expect } from "vitest";
import { buildDocumentXml, escapeXmlAttr } from "../lib/document-xml.js";

const baseInput = {
  source_filename: "Стандарт_С-СГК-В5-03.pdf",
  chunk_index: 7,
  similarity: 0.83,
  tags: ["стандарт", "вне 223-фз"],
  hasScreenshots: false,
  sanitizedContent: "Текст чанка",
};

describe("buildDocumentXml — High-2 regression guard", () => {
  it("emits a tags attribute matching the input tags", () => {
    const xml = buildDocumentXml(baseInput, 1);
    expect(xml).toContain('tags="стандарт вне 223-фз"');
  });

  it("emits an empty tags attribute when tags array is empty", () => {
    const xml = buildDocumentXml({ ...baseInput, tags: [] }, 1);
    expect(xml).toContain('tags=""');
  });

  it("emits an empty tags attribute when tags is undefined", () => {
    const xml = buildDocumentXml(
      // @ts-expect-error simulating runtime where tags may be missing
      { ...baseInput, tags: undefined },
      1
    );
    expect(xml).toContain('tags=""');
  });

  it("preserves regime tags critical to system prompt routing", () => {
    const xml223 = buildDocumentXml({ ...baseInput, tags: ["223-фз"] }, 1);
    const xmlNon223 = buildDocumentXml({ ...baseInput, tags: ["вне 223-фз"] }, 1);
    expect(xml223).toContain('tags="223-фз"');
    expect(xmlNon223).toContain('tags="вне 223-фз"');
    // System prompt at chat.ts:1737 reads these to discriminate procurement regime.
  });
});

describe("buildDocumentXml — structural attributes", () => {
  it("includes id, filename, chunk, similarity, has_screenshots", () => {
    const xml = buildDocumentXml(baseInput, 3);
    expect(xml).toContain('id="3"');
    expect(xml).toContain('filename="Стандарт_С-СГК-В5-03.pdf"');
    expect(xml).toContain('chunk="7"');
    expect(xml).toContain('similarity="0.83"');
    expect(xml).toContain('has_screenshots="no"');
  });

  it("formats similarity with 2 decimals", () => {
    expect(buildDocumentXml({ ...baseInput, similarity: 0.123456 }, 1)).toContain('similarity="0.12"');
    expect(buildDocumentXml({ ...baseInput, similarity: 1 }, 1)).toContain('similarity="1.00"');
  });

  it("emits has_screenshots=yes when hasScreenshots is true", () => {
    const xml = buildDocumentXml({ ...baseInput, hasScreenshots: true }, 1);
    expect(xml).toContain('has_screenshots="yes"');
  });

  it("wraps content between opening and closing tags", () => {
    const xml = buildDocumentXml({ ...baseInput, sanitizedContent: "BODY_TEXT" }, 1);
    expect(xml).toMatch(/<document [^>]*>\nBODY_TEXT\n<\/document>$/);
  });
});

describe("buildDocumentXml — XML attribute escaping", () => {
  it("escapes filenames containing & < > \" '", () => {
    const xml = buildDocumentXml(
      { ...baseInput, source_filename: `it's <weird>&"safe".pdf` },
      1
    );
    expect(xml).toContain('filename="it&apos;s &lt;weird&gt;&amp;&quot;safe&quot;.pdf"');
  });

  it("escapes tags containing special XML chars", () => {
    const xml = buildDocumentXml({ ...baseInput, tags: ["a&b", "c<d", 'e"f'] }, 1);
    expect(xml).toContain('tags="a&amp;b c&lt;d e&quot;f"');
  });

  it("does not break attribute structure when tags include quotes", () => {
    // If escape were missing, an unescaped quote would terminate the attribute.
    const xml = buildDocumentXml({ ...baseInput, tags: ['inject" onerror=x'] }, 1);
    // Count unescaped double-quotes — must be even (they pair up).
    const quoteCount = (xml.match(/"/g) || []).length;
    expect(quoteCount % 2).toBe(0);
  });
});

describe("escapeXmlAttr — direct contract", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXmlAttr(`& " ' < >`)).toBe("&amp; &quot; &apos; &lt; &gt;");
  });

  it("is a no-op for plain ASCII", () => {
    expect(escapeXmlAttr("plain-text-123")).toBe("plain-text-123");
  });

  it("is a no-op for non-ASCII Cyrillic", () => {
    expect(escapeXmlAttr("стандарт закупок")).toBe("стандарт закупок");
  });
});
