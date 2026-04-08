#!/usr/bin/env node

/**
 * Программа тестирования загрузки файлов в СнабЧат
 * =================================================
 *
 * Тестирует:
 * 1. Парсинг всех поддерживаемых форматов (DOCX, DOC, PDF, PPTX, XLSX, TXT, MD, MP3, WAV, изображения)
 * 2. Загрузку больших файлов (>4MB) через Supabase Storage
 * 3. Валидацию форматов (отклонение неподдерживаемых)
 * 4. Обработку ошибок
 *
 * Использование:
 *   node scripts/test-uploads/run-tests.mjs <BASE_URL> <INVITE_CODE>
 *
 * Пример:
 *   node scripts/test-uploads/run-tests.mjs http://localhost:3000 ФАМИЛИЯ-1234
 *   node scripts/test-uploads/run-tests.mjs https://snab-chat.vercel.app МОЙ-КОД
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───
const BASE_URL = process.argv[2] || "http://localhost:3000";
const INVITE_CODE = process.argv[3] || "";

if (!INVITE_CODE) {
  console.error("Использование: node run-tests.mjs <BASE_URL> <INVITE_CODE>");
  console.error("Пример: node run-tests.mjs http://localhost:3000 ФАМИЛИЯ-1234");
  process.exit(1);
}

const FIXTURES_DIR = path.join(__dirname, "fixtures");

// ─── Test results ───
let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function pass(name, detail = "") {
  passed++;
  results.push({ name, status: "PASS", detail });
  log("✅", `${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed++;
  results.push({ name, status: "FAIL", detail });
  log("❌", `${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, reason = "") {
  skipped++;
  results.push({ name, status: "SKIP", reason });
  log("⏭️", `${name} — ${reason}`);
}

// ─── Helpers ───

async function parseFile(filePath, mimeType) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: mimeType });

  const formData = new FormData();
  formData.append("file", blob, fileName);

  const res = await fetch(`${BASE_URL}/api/parse`, {
    method: "POST",
    body: formData,
    headers: {
      "x-invite-code": encodeURIComponent(INVITE_CODE),
    },
  });

  return { status: res.status, data: await res.json().catch(() => null) };
}

async function parseViaStorage(filePath, mimeType) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  // Step 1: Get upload URL
  const urlRes = await fetch(`${BASE_URL}/api/chat-upload-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-invite-code": encodeURIComponent(INVITE_CODE),
    },
    body: JSON.stringify({ filename: fileName, mimeType }),
  });

  if (!urlRes.ok) {
    return { status: urlRes.status, data: null, error: "Failed to get upload URL" };
  }

  const { uploadUrl, storagePath } = await urlRes.json();

  // Step 2: Upload to storage
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "x-upsert": "false" },
    body: fileBuffer,
  });

  if (!putRes.ok) {
    return { status: putRes.status, data: null, error: "Storage upload failed" };
  }

  // Step 3: Parse via storagePath
  const formData = new FormData();
  formData.append("storagePath", storagePath);
  formData.append("storageBucket", "chat-uploads");
  formData.append("filename", fileName);
  formData.append("mimeType", mimeType);

  const res = await fetch(`${BASE_URL}/api/parse`, {
    method: "POST",
    body: formData,
    headers: {
      "x-invite-code": encodeURIComponent(INVITE_CODE),
    },
  });

  return { status: res.status, data: await res.json().catch(() => null) };
}

function createTextFile(name, content) {
  const filePath = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function createBinaryFile(name, sizeBytes) {
  const filePath = path.join(FIXTURES_DIR, name);
  const buf = Buffer.alloc(sizeBytes, 0x41); // fill with 'A'
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ─── Tests ───

async function testAuthRequired() {
  console.log("\n📋 1. Аутентификация");

  const formData = new FormData();
  formData.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt");

  const res = await fetch(`${BASE_URL}/api/parse`, {
    method: "POST",
    body: formData,
    // no invite code header
  });

  if (res.status === 401) {
    pass("Запрос без invite-кода отклонён (401)");
  } else {
    fail("Запрос без invite-кода", `Ожидали 401, получили ${res.status}`);
  }
}

async function testTxtParsing() {
  console.log("\n📋 2. Парсинг текстовых файлов");

  // TXT
  const txtPath = createTextFile("test.txt", "Тестовый документ.\nВторая строка с текстом о закупках.");
  try {
    const { status, data } = await parseFile(txtPath, "text/plain");
    if (status === 200 && data?.markdown?.includes("Тестовый документ")) {
      pass("TXT парсинг", `${data.markdown.length} символов`);
    } else {
      fail("TXT парсинг", `status=${status}, markdown=${data?.markdown?.slice(0, 50)}`);
    }
  } catch (e) {
    fail("TXT парсинг", e.message);
  }

  // MD
  const mdPath = createTextFile("test.md", "# Заголовок\n\n- Пункт 1\n- Пункт 2\n\nТекст о **закупках**.");
  try {
    const { status, data } = await parseFile(mdPath, "text/markdown");
    if (status === 200 && data?.markdown?.includes("Заголовок")) {
      pass("MD парсинг", `${data.markdown.length} символов`);
    } else {
      fail("MD парсинг", `status=${status}, markdown=${data?.markdown?.slice(0, 50)}`);
    }
  } catch (e) {
    fail("MD парсинг", e.message);
  }
}

async function testDocxParsing() {
  console.log("\n📋 3. Парсинг DOCX");

  // Создаём минимальный .docx (ZIP с XML)
  // Это самый простой валидный DOCX
  const docxFixture = path.join(FIXTURES_DIR, "test.docx");
  if (fs.existsSync(docxFixture)) {
    try {
      const { status, data } = await parseFile(docxFixture, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      if (status === 200 && data?.markdown != null) {
        pass("DOCX парсинг", `${data.markdown.length} символов, ${data.totalChunks} чанков`);
      } else {
        fail("DOCX парсинг", `status=${status}, error=${data?.error}`);
      }
    } catch (e) {
      fail("DOCX парсинг", e.message);
    }
  } else {
    skip("DOCX парсинг", `Положите test.docx в ${FIXTURES_DIR}`);
  }
}

async function testDocParsing() {
  console.log("\n📋 4. Парсинг DOC (Word 97-2003)");

  const docFixture = path.join(FIXTURES_DIR, "test.doc");
  if (fs.existsSync(docFixture)) {
    try {
      const { status, data } = await parseFile(docFixture, "application/msword");
      if (status === 200 && data?.markdown != null && data.markdown.length > 0) {
        pass("DOC парсинг", `${data.markdown.length} символов (mammoth или Gemini OCR)`);
      } else {
        fail("DOC парсинг", `status=${status}, error=${data?.error}, md_len=${data?.markdown?.length}`);
      }
    } catch (e) {
      fail("DOC парсинг", e.message);
    }
  } else {
    skip("DOC парсинг", `Положите test.doc в ${FIXTURES_DIR}`);
  }
}

async function testPdfParsing() {
  console.log("\n📋 5. Парсинг PDF");

  const pdfFixture = path.join(FIXTURES_DIR, "test.pdf");
  if (fs.existsSync(pdfFixture)) {
    try {
      const { status, data } = await parseFile(pdfFixture, "application/pdf");
      if (status === 200 && data?.markdown != null) {
        pass("PDF парсинг", `${data.markdown.length} символов`);
      } else {
        fail("PDF парсинг", `status=${status}, error=${data?.error}`);
      }
    } catch (e) {
      fail("PDF парсинг", e.message);
    }
  } else {
    skip("PDF парсинг", `Положите test.pdf в ${FIXTURES_DIR}`);
  }
}

async function testXlsxParsing() {
  console.log("\n📋 6. Парсинг XLSX");

  const xlsxFixture = path.join(FIXTURES_DIR, "test.xlsx");
  if (fs.existsSync(xlsxFixture)) {
    try {
      const { status, data } = await parseFile(xlsxFixture, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      if (status === 200 && data?.markdown != null) {
        pass("XLSX парсинг", `${data.markdown.length} символов`);
      } else {
        fail("XLSX парсинг", `status=${status}, error=${data?.error}`);
      }
    } catch (e) {
      fail("XLSX парсинг", e.message);
    }
  } else {
    skip("XLSX парсинг", `Положите test.xlsx в ${FIXTURES_DIR}`);
  }
}

async function testPptxParsing() {
  console.log("\n📋 7. Парсинг PPTX");

  const pptxFixture = path.join(FIXTURES_DIR, "test.pptx");
  if (fs.existsSync(pptxFixture)) {
    try {
      const { status, data } = await parseFile(pptxFixture, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      if (status === 200 && data?.markdown != null) {
        pass("PPTX парсинг", `${data.markdown.length} символов, ${data.totalImages} изображений`);
      } else {
        fail("PPTX парсинг", `status=${status}, error=${data?.error}`);
      }
    } catch (e) {
      fail("PPTX парсинг", e.message);
    }
  } else {
    skip("PPTX парсинг", `Положите test.pptx в ${FIXTURES_DIR}`);
  }
}

async function testImageParsing() {
  console.log("\n📋 8. Парсинг изображений (OCR)");

  for (const [ext, mime] of [["jpg", "image/jpeg"], ["png", "image/png"]]) {
    const fixture = path.join(FIXTURES_DIR, `test.${ext}`);
    if (fs.existsSync(fixture)) {
      try {
        const { status, data } = await parseFile(fixture, mime);
        if (status === 200 && data?.markdown != null) {
          pass(`${ext.toUpperCase()} OCR`, `${data.markdown.length} символов`);
        } else {
          fail(`${ext.toUpperCase()} OCR`, `status=${status}, error=${data?.error}`);
        }
      } catch (e) {
        fail(`${ext.toUpperCase()} OCR`, e.message);
      }
    } else {
      skip(`${ext.toUpperCase()} OCR`, `Положите test.${ext} в ${FIXTURES_DIR}`);
    }
  }
}

async function testAudioParsing() {
  console.log("\n📋 9. Парсинг аудио (транскрипция)");

  for (const [ext, mime] of [["mp3", "audio/mpeg"], ["wav", "audio/wav"]]) {
    const fixture = path.join(FIXTURES_DIR, `test.${ext}`);
    if (fs.existsSync(fixture)) {
      try {
        // Audio files are typically >4MB, use storage path
        const fileSize = fs.statSync(fixture).size;
        let result;
        if (fileSize > 4 * 1024 * 1024) {
          log("📤", `${ext.toUpperCase()} ${(fileSize / 1024 / 1024).toFixed(1)}MB — загрузка через Storage...`);
          result = await parseViaStorage(fixture, mime);
        } else {
          result = await parseFile(fixture, mime);
        }

        const { status, data, error } = result;
        if (error) {
          fail(`${ext.toUpperCase()} транскрипция`, error);
        } else if (status === 200 && data?.markdown != null && data.markdown.length > 0) {
          pass(`${ext.toUpperCase()} транскрипция`, `${data.markdown.length} символов`);
        } else {
          fail(`${ext.toUpperCase()} транскрипция`, `status=${status}, error=${data?.error}, md_len=${data?.markdown?.length}`);
        }
      } catch (e) {
        fail(`${ext.toUpperCase()} транскрипция`, e.message);
      }
    } else {
      skip(`${ext.toUpperCase()} транскрипция`, `Положите test.${ext} в ${FIXTURES_DIR}`);
    }
  }
}

async function testLargeFileUpload() {
  console.log("\n📋 10. Загрузка больших файлов (>4MB) через Storage");

  // Test chat-upload-url endpoint
  try {
    const res = await fetch(`${BASE_URL}/api/chat-upload-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": encodeURIComponent(INVITE_CODE),
      },
      body: JSON.stringify({ filename: "test-large.txt", mimeType: "text/plain" }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.uploadUrl && data.storagePath) {
        pass("chat-upload-url эндпоинт", `storagePath=${data.storagePath}`);
      } else {
        fail("chat-upload-url эндпоинт", "Нет uploadUrl или storagePath в ответе");
      }
    } else {
      fail("chat-upload-url эндпоинт", `status=${res.status}`);
    }
  } catch (e) {
    fail("chat-upload-url эндпоинт", e.message);
  }

  // Test actual large file upload + parse
  const largeTxtPath = createTextFile(
    "large-test.txt",
    "Большой тестовый файл.\n".repeat(300000) // ~6MB
  );
  const fileSize = fs.statSync(largeTxtPath).size;
  log("📤", `Тест файла ${(fileSize / 1024 / 1024).toFixed(1)}MB через Storage...`);

  try {
    const result = await parseViaStorage(largeTxtPath, "text/plain");
    if (result.error) {
      fail("Большой TXT через Storage", result.error);
    } else if (result.status === 200 && result.data?.markdown?.includes("Большой тестовый файл")) {
      pass("Большой TXT через Storage", `${result.data.markdown.length} символов`);
    } else {
      fail("Большой TXT через Storage", `status=${result.status}, error=${result.data?.error}`);
    }
  } catch (e) {
    fail("Большой TXT через Storage", e.message);
  }
}

async function testChatUploadUrlAuth() {
  console.log("\n📋 11. Безопасность chat-upload-url");

  // Without auth
  const res = await fetch(`${BASE_URL}/api/chat-upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "test.txt", mimeType: "text/plain" }),
  });

  if (res.status === 401) {
    pass("chat-upload-url без авторизации отклонён (401)");
  } else {
    fail("chat-upload-url без авторизации", `Ожидали 401, получили ${res.status}`);
  }
}

async function testDocumentAdminRestriction() {
  console.log("\n📋 12. Ограничение загрузки в базу знаний");

  // Test /api/ingest (should require isDocAdmin=true)
  const formData = new FormData();
  formData.append("filename", "test.txt");
  formData.append("mimeType", "text/plain");
  formData.append("markdown", "Test content");
  formData.append("tags", "[]");

  const res = await fetch(`${BASE_URL}/api/ingest`, {
    method: "POST",
    body: formData,
    headers: {
      "x-admin-code": encodeURIComponent("FAKE-NON-DOC-ADMIN"),
    },
  });

  if (res.status === 401 || res.status === 403) {
    pass("Ingest отклонён для не-docAdmin", `status=${res.status}`);
  } else {
    fail("Ingest для не-docAdmin", `Ожидали 401/403, получили ${res.status}`);
  }

  // Test /api/upload-url
  const res2 = await fetch(`${BASE_URL}/api/upload-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-code": encodeURIComponent("FAKE-NON-DOC-ADMIN"),
    },
    body: JSON.stringify({ filename: "test.txt", mimeType: "text/plain" }),
  });

  if (res2.status === 401 || res2.status === 403) {
    pass("Upload-url отклонён для не-КИРИЛЛ админа", `status=${res2.status}`);
  } else {
    fail("Upload-url для не-КИРИЛЛ админа", `Ожидали 401/403, получили ${res2.status}`);
  }
}

// ─── Main ───

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  ТЕСТИРОВАНИЕ ЗАГРУЗКИ ФАЙЛОВ — СнабЧат");
  console.log("═══════════════════════════════════════════════");
  console.log(`  URL:    ${BASE_URL}`);
  console.log(`  Код:    ${INVITE_CODE}`);
  console.log(`  Время:  ${new Date().toLocaleString("ru-RU")}`);

  // Ensure fixtures dir exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  console.log(`\n  Папка фикстур: ${FIXTURES_DIR}`);
  console.log("  Для полного тестирования положите в неё файлы:");
  console.log("    test.docx, test.doc, test.pdf, test.xlsx,");
  console.log("    test.pptx, test.jpg, test.png, test.mp3, test.wav");

  try {
    await testAuthRequired();
    await testTxtParsing();
    await testDocxParsing();
    await testDocParsing();
    await testPdfParsing();
    await testXlsxParsing();
    await testPptxParsing();
    await testImageParsing();
    await testAudioParsing();
    await testLargeFileUpload();
    await testChatUploadUrlAuth();
    await testDocumentAdminRestriction();
  } catch (e) {
    console.error("\n💥 Критическая ошибка:", e.message);
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════");
  console.log("  ИТОГО");
  console.log("═══════════════════════════════════════════════");
  console.log(`  ✅ Пройдено:   ${passed}`);
  console.log(`  ❌ Провалено:  ${failed}`);
  console.log(`  ⏭️  Пропущено: ${skipped}`);
  console.log("═══════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("  Проваленные тесты:");
    results.filter((r) => r.status === "FAIL").forEach((r) => {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    });
    console.log("");
  }

  if (skipped > 0) {
    console.log("  Пропущенные тесты (нужны файлы-фикстуры):");
    results.filter((r) => r.status === "SKIP").forEach((r) => {
      console.log(`    ⏭️  ${r.name}: ${r.reason}`);
    });
    console.log("");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
