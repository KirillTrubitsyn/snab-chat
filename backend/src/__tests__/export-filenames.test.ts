/**
 * Regression tests for the export filename policy (PR #5).
 *
 * Policy: "<YYYY-MM-DD> <up-to-6-topic-words>.<ext>"
 *
 * Explicitly disallowed in the filename:
 *   - "СнабЧат" / "snabchat" — brand prefix is folder-listing clutter.
 *   - Date placed AFTER the topic — chronological sort needs date first.
 */

import { describe, it, expect } from "vitest";
import {
  generateDocxFilename,
  generateXlsxFilename,
  asciiFilename,
} from "../lib/export-filenames.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

describe("generateDocxFilename", () => {
  it("starts with ISO date", () => {
    expect(generateDocxFilename("Какие сроки рассмотрения заявок?")).toMatch(DATE_RE);
  });

  it("does NOT contain the brand", () => {
    const name = generateDocxFilename("Какие сроки рассмотрения заявок?");
    expect(name.toLowerCase()).not.toContain("снабчат");
    expect(name.toLowerCase()).not.toContain("snabchat");
  });

  it("includes topic words from a real comparative-regulation question", () => {
    const name = generateDocxFilename(
      "Проведи детальный сравнительный анализ положений о закупках Енисейской ТГК и НТСК",
    );
    // Several of the topic stems should appear; not pinning the exact set
    // because stop-word stripping order is an implementation detail.
    expect(name).toMatch(/сравнительный|анализ|положений|закупках|енисейской|нтск/i);
  });

  it("ends with .docx", () => {
    expect(generateDocxFilename("Покажи стандарт закупок").endsWith(".docx")).toBe(true);
  });

  it("falls back to '<date> ответ.docx' on empty / stopword-only input", () => {
    const empty = generateDocxFilename("");
    expect(empty).toMatch(DATE_RE);
    expect(empty.toLowerCase()).toContain("ответ");
    expect(empty).toMatch(/\.docx$/);

    const stop = generateDocxFilename("что а это и или");
    expect(stop.toLowerCase()).toContain("ответ");
  });
});

describe("generateXlsxFilename", () => {
  it("starts with ISO date and ends with .xlsx", () => {
    const name = generateXlsxFilename("Сделай таблицу по матрице полномочий");
    expect(name).toMatch(DATE_RE);
    expect(name.endsWith(".xlsx")).toBe(true);
  });

  it("does NOT contain the brand", () => {
    const name = generateXlsxFilename("Сделай таблицу по закупкам");
    expect(name.toLowerCase()).not.toContain("снабчат");
    expect(name.toLowerCase()).not.toContain("snabchat");
  });

  it("strips spreadsheet-format stop words so the topic gets the slots", () => {
    const name = generateXlsxFilename("Составь таблицу по закупкам ЕТГК");
    expect(name.toLowerCase()).not.toContain("таблиц");
    expect(name.toLowerCase()).not.toContain("составь");
    expect(name).toMatch(/закупкам|етгк/i);
  });

  it("falls back to '<date> таблица.xlsx' on empty input", () => {
    const name = generateXlsxFilename("");
    expect(name).toMatch(DATE_RE);
    expect(name).toMatch(/\.xlsx$/);
    expect(name.toLowerCase()).toContain("таблица");
  });
});

describe("asciiFilename (Content-Disposition fallback)", () => {
  it("is ASCII-only, date-prefixed, brand-free", () => {
    const d = asciiFilename("docx");
    const x = asciiFilename("xlsx");
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}-document\.docx$/);
    expect(x).toMatch(/^\d{4}-\d{2}-\d{2}-spreadsheet\.xlsx$/);
    // ASCII only
    // eslint-disable-next-line no-control-regex
    expect(d).toMatch(/^[\x00-\x7F]+$/);
    expect(x).toMatch(/^[\x00-\x7F]+$/);
    expect(d.toLowerCase()).not.toContain("snabchat");
    expect(x.toLowerCase()).not.toContain("snabchat");
  });
});
