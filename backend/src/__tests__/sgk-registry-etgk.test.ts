/**
 * Regression tests for ETGK entity recognition in sgk-registry.
 *
 * Bug they guard against:
 *   findAllEntities did not recognise "Енисейской ТГК" (genitive case) on
 *   the actual production query "Проведи детальный сравнительный анализи
 *   положеий о закупках Енисейской ТГК и НТСК ...". Aliases for ETGK were
 *   only in nominative case ("енисейская тгк", "тгк-13", "тгк 13", "етгк"),
 *   and lower.includes(alias) does not do morphological matching, so
 *   detectedEntityNames came back as ["нтск"] only — single entity.
 *
 *   Downstream consequences: per-entity hybrid search ran only for НТСК,
 *   per-entity DOC pre-seed (new in this PR) would do nothing for ETGK,
 *   and the actual Положение_о_закупках_АО_Енисейская_ТГК.docx only
 *   showed up via the "Added original source documents" fallback.
 */

import { describe, it, expect } from "vitest";
import { findAllEntities } from "../lib/sgk-registry.js";

const ETGK = "АО «Енисейская ТГК (ТГК-13)»";
const NTSK = 'ООО «Новосибирская теплосетевая компания»';

describe("findAllEntities — ETGK case-form matching", () => {
  it.each([
    ["Положение АО «Енисейская ТГК (ТГК-13)»",                                  [ETGK]],
    ["Закупки в ТГК-13",                                                         [ETGK]],
    ["Что в ЕТГК?",                                                              [ETGK]],
    ["Структура енисейской ТГК",                                                 [ETGK]],
    ["По енисейской тгк есть данные?",                                           [ETGK]],
    ["Дела в енисейской тгк-13",                                                 [ETGK]],
    // The actual user query (with typos) — must return BOTH entities
    [
      "Проведи детальный сравнительный анализи положеий о закупках Енисейской ТГК и НТСК, составь таблицу отличий",
      [ETGK, NTSK],
    ],
    ["Сравни ЕТГК и НТСК",                                                       [ETGK, NTSK]],
    ["Сравни енисейскую тгк и нтск",                                             [ETGK, NTSK]],
  ])("query=%j recognises %j", (q, expected) => {
    const got = findAllEntities(q).map((e) => e.name);
    for (const exp of expected) {
      expect(got).toContain(exp);
    }
  });
});

describe("findAllEntities — single-entity NTSK case-form matching", () => {
  it("matches НТСК across queries", () => {
    expect(findAllEntities("По какому ФЗ работает НТСК?").map((e) => e.name)).toContain(NTSK);
    expect(findAllEntities("Положение НТСК").map((e) => e.name)).toContain(NTSK);
  });
});

describe("findAllEntities — does not match unrelated text", () => {
  it("does not match common Russian word fragments that happen to share letters", () => {
    // No registry entity should pop out from a generic question
    const ents = findAllEntities("Как считается НМЦД при индексации цен договора?").map((e) => e.name);
    // It is fine to match nothing here. The key constraint: it must not
    // hallucinate ETGK or NTSK from this query.
    expect(ents).not.toContain(ETGK);
    expect(ents).not.toContain(NTSK);
  });
});
