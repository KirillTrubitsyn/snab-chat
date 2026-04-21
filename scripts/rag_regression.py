#!/usr/bin/env python3
"""
Регрессионный тест RAG-пайплайна СнабЧат.

Прогоняет набор вопросов через продакшн `/api/chat` и проверяет ответы
против ожиданий. Запускается из GitHub Actions по push в main, по расписанию
и вручную через workflow_dispatch.

Конфигурация через environment variables:
  RAG_API_HOST        — хост (default: snab-chat-production.up.railway.app)
  RAG_API_ORIGIN      — Origin header (default: https://www.snabchat.app)
  RAG_INVITE_CODE     — инвайт-код (required)
  RAG_AUTH_TOKEN      — HMAC-подписанный auth-токен (required)
  RAG_TEST_DELAY_SEC  — пауза между вопросами в секундах (default: 3)
  RAG_REQUEST_TIMEOUT — таймаут одного запроса (default: 180)

Exit codes:
  0 — все тесты OK
  1 — один или более FAIL/ERROR
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
from http.client import HTTPSConnection

API_HOST = os.environ.get("RAG_API_HOST", "snab-chat-production.up.railway.app")
API_PATH = "/api/chat"
ORIGIN = os.environ.get("RAG_API_ORIGIN", "https://www.snabchat.app")
INVITE_CODE = os.environ.get("RAG_INVITE_CODE", "")
AUTH_TOKEN = os.environ.get("RAG_AUTH_TOKEN", "")
DELAY_SEC = float(os.environ.get("RAG_TEST_DELAY_SEC", "3"))
REQUEST_TIMEOUT = int(os.environ.get("RAG_REQUEST_TIMEOUT", "180"))

# Вопросы: (id, текст, ожидания)
#   must_contain      — все подстроки обязательны
#   must_contain_any  — хотя бы одна из подстрок
#   must_not_contain  — ни одна подстрока не должна встретиться
TESTS = [
    # Priority 1. Кейс НМГРЭС (2026-04-20 галлюцинация «Квадра»).
    ("P1.1", "Новомосковская ГРЭС не работает по 223-ФЗ",
     {"must_contain": ["вне 223", "НМГРЭС"], "must_not_contain": ["Квадра"]}),
    ("P1.2", "У Новомосковской ГРЭС своя матрица полномочий по принятию решений",
     {"must_contain_any": ["матриц", "НМГРЭС", "Новомосковск"], "must_not_contain": ["Квадра"]}),
    ("P1.3", "Посмотри матрицу полномочий по принятию решений (приложение к приказу от 16.10.2025 №355-од/НМГРЭС)",
     {"must_contain_any": ["355", "НМГРЭС", "Новомосковск"], "must_not_contain": ["Квадра"]}),
    ("P1.4", "В рамках одной ЗП запчастей генераторов для Новомосковской ГРЭС выбрано несколько поставщиков, общая сумма по всем поставщикам 30 млн, требуется ли данный вопрос выносить на ЦЗК?",
     {"must_contain_any": ["ЦЗК", "НМГРЭС", "Новомосковск"], "must_not_contain": ["Квадра"]}),
    # Priority 2. Общие вопросы.
    ("P2.1", "Можно ли оплатить по счету 100% аванс поставщику без заключения договора?",
     {"must_contain_any": ["аванс", "договор", "счет", "счёт"]}),
    ("P2.2", "Какие документы нужны для проверки контрагента в ДКБ?",
     {"must_contain_any": ["ДКБ", "контраген", "проверк"]}),
    ("P2.3", "Какие критерии оценки предложений участников?",
     {"must_contain_any": ["критер", "оценк"]}),
]


def chat(question: str, timeout: int = REQUEST_TIMEOUT) -> dict:
    """Отправляет вопрос и возвращает {status, answer, sources, raw_len}."""
    body = json.dumps(
        {"messages": [{"role": "user", "content": question}]},
        ensure_ascii=False,
    ).encode("utf-8")

    conn = HTTPSConnection(API_HOST, timeout=timeout)
    conn.request(
        "POST", API_PATH, body=body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Origin": ORIGIN,
            "x-invite-code": INVITE_CODE,
            "x-auth-token": AUTH_TOKEN,
        },
    )
    resp = conn.getresponse()
    status = resp.status
    headers = dict(resp.getheaders())
    raw = resp.read().decode("utf-8", errors="replace")
    conn.close()

    # Sources приходят в X-Sources (URL-encoded JSON).
    sources_raw = headers.get("x-sources") or headers.get("X-Sources") or ""
    try:
        sources = json.loads(urllib.parse.unquote(sources_raw)) if sources_raw else []
    except Exception:
        sources = []

    # Vercel AI SDK data-stream protocol: 0:"token" — фрагменты ответа.
    text_parts: list[str] = []
    for line in raw.splitlines():
        if not line:
            continue
        m = re.match(r'^0:"(.*)"$', line)
        if m:
            try:
                text_parts.append(json.loads('"' + m.group(1) + '"'))
            except Exception:
                text_parts.append(m.group(1))
    answer = "".join(text_parts)

    return {
        "status": status,
        "answer": answer,
        "sources": sources,
        "raw_len": len(raw),
    }


def check(answer: str, expect: dict) -> list[str]:
    """Возвращает список проблем. Пустой список означает, что тест прошёл."""
    issues: list[str] = []
    low = answer.lower()
    for s in expect.get("must_contain", []):
        if s.lower() not in low:
            issues.append(f"missing required substring: {s!r}")
    any_reqs = expect.get("must_contain_any")
    if any_reqs and not any(s.lower() in low for s in any_reqs):
        issues.append(f"none of required substrings present: {any_reqs}")
    for s in expect.get("must_not_contain", []):
        if s.lower() in low:
            issues.append(f"FORBIDDEN substring present: {s!r}")
    return issues


def require_env() -> None:
    missing = [k for k, v in {"RAG_INVITE_CODE": INVITE_CODE, "RAG_AUTH_TOKEN": AUTH_TOKEN}.items() if not v]
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)


def main() -> int:
    require_env()
    results: list[tuple] = []
    for tid, q, expect in TESTS:
        t0 = time.time()
        print(f"\n{'=' * 76}")
        print(f"[{tid}] {q[:100]}")
        print(f"{'=' * 76}")
        try:
            r = chat(q)
        except Exception as e:
            print(f"  HTTP error: {e}")
            results.append((tid, "ERROR", [str(e)]))
            continue
        dt = time.time() - t0
        issues = check(r["answer"], expect)
        verdict = "OK" if not issues else "FAIL"
        print(f"  status={r['status']}  time={dt:.1f}s  answer_len={len(r['answer'])}  sources={len(r['sources'])}")
        print(f"  verdict: {verdict}")
        for i in issues:
            print(f"    - {i}")
        print(f"  sources: {r['sources'][:5]}{'...' if len(r['sources']) > 5 else ''}")
        preview = r["answer"][:400].replace(chr(10), " ")
        print(f"  answer preview: {preview}")
        results.append((tid, verdict, issues, r))
        time.sleep(DELAY_SEC)

    print(f"\n\n{'=' * 76}\nИтог\n{'=' * 76}")
    ok = sum(1 for r in results if r[1] == "OK")
    fail = sum(1 for r in results if r[1] == "FAIL")
    err = sum(1 for r in results if r[1] == "ERROR")
    for r in results:
        print(f"  [{r[0]}] {r[1]}")
        for i in r[2]:
            print(f"       - {i}")
    print(f"\n  OK: {ok}  FAIL: {fail}  ERROR: {err}")

    # Для GitHub Actions annotations.
    if fail:
        print(f"::error::RAG regression: {fail} test(s) failed")
    if err:
        print(f"::error::RAG regression: {err} test(s) errored")

    return 0 if (fail == 0 and err == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
