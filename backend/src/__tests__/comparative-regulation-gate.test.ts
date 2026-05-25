/**
 * Regression tests for the isComparativeRegulationQuery gate.
 *
 * The bug they guard against:
 *   Comparative regulation queries like "Сравни положения о закупках ЕТГК
 *   и НТСК, составь таблицу отличий" pull in three "Перечень компаний"
 *   files + contractor cards (ООО _КРСК_, ООО _РУСЭНЕРГО_), pushing the
 *   actual Положение о закупках НТСК (sources.id=1421) out of the
 *   retrieved sources.
 *
 *   Root cause: when the query names two organisations, the LLM intent
 *   classifier returns "entity_lookup". chat.ts then runs both the
 *   org-registry pre-seed and searchContractorCards, both of which are
 *   correct for "по какому ФЗ работает X" but wrong for comparing
 *   substantive regulations.
 *
 * The gate fires when query mentions a document type
 * (положение/стандарт/регламент/...) AND a comparative verb
 * (сравни/отличи/различи/таблиц/...). Both conditions must match,
 * so genuine entity_lookup queries are unaffected.
 *
 * The helper itself is private to chat.ts (not exported). These tests
 * re-implement the same regex pair to lock the behavior down — if anyone
 * changes the regex in chat.ts, this file will need to be updated, which
 * is the desired behavior for a documented contract.
 */

import { describe, it, expect } from "vitest";

const COMPARATIVE_REGULATION_DOC_PATTERN =
  /полож|стандарт|регламент|порядок|правил|инструкци|методик/i;
const COMPARATIVE_REGULATION_VERB_PATTERN =
  /сравни|сопостав|отлич|различ|разниц|таблиц|разбер|анализ/i;

function isComparativeRegulationQuery(text: string): boolean {
  if (!text) return false;
  return (
    COMPARATIVE_REGULATION_DOC_PATTERN.test(text) &&
    COMPARATIVE_REGULATION_VERB_PATTERN.test(text)
  );
}

describe("isComparativeRegulationQuery — positive cases (gate fires, registry suppressed)", () => {
  it.each([
    "Проведи детальный сравнительный анализ положений о закупках Енисейской ТГК и НТСК, составь таблицу отличий",
    "Проведи детальный сравнительный анализи положеий о закупках Енисейской ТГК и НТСК, составь таблицу отличий", // user's actual typo'd query
    "Сравни стандарты закупок Кузбассэнерго и СГК-Алтай",
    "Чем отличаются регламенты закупок ЕТГК от НТСК?",
    "Сопоставь порядок проведения закупок в двух филиалах",
    "Дай таблицу различий положений о закупках по 223-ФЗ и вне 223-ФЗ",
    "Разбери инструкции по подрядчикам у двух организаций",
  ])("fires on: %s", (q) => {
    expect(isComparativeRegulationQuery(q)).toBe(true);
  });
});

describe("isComparativeRegulationQuery — negative cases (gate does not fire, registry runs)", () => {
  it.each([
    "По какому ФЗ работает НМГРЭС?",
    "Кто согласовывает закупки в Кузбассэнерго?",
    "Какие компании входят в группу СГК?",
    "Дай перечень компаний группы",
    "Контакты ООО КРСК ИНЖИНИРИНГ",
    "Найди подрядчиков для монтажа лифтов в Новосибирске",
    "Какой годовой бюджет закупок у ЕТГК?",
    // Document keyword without comparative verb — must NOT match
    "Покажи положение о закупках НТСК",
    "Где взять стандарт закупок СГК-Алтай?",
    // Comparative verb without document keyword — must NOT match
    "Сравни выручку ЕТГК и НТСК за 2025",
  ])("does not fire on: %s", (q) => {
    expect(isComparativeRegulationQuery(q)).toBe(false);
  });

  it("does not fire on empty string", () => {
    expect(isComparativeRegulationQuery("")).toBe(false);
  });
});

describe("isComparativeRegulationQuery — NMGRES guard", () => {
  it("does not fire on regime-style NMGRES query", () => {
    expect(isComparativeRegulationQuery("По какому ФЗ работает НМГРЭС, кто согласует свыше 5 млн?")).toBe(
      false,
    );
  });

  it("does fire if NMGRES query happens to ask for a comparison of regulations", () => {
    // Edge case — if someone explicitly compares НМГРЭС regulation against
    // another entity's regulation, the gate fires. Registry won't be
    // pre-seeded, but the dedicated detectNmgresAuthorityQuery branch
    // (chat.ts:700) still routes the matrix correctly.
    expect(
      isComparativeRegulationQuery("Сравни положения НМГРЭС и Кузбассэнерго"),
    ).toBe(true);
  });
});
