import { Router, Request, Response } from "express";
import { getInviteCodeFromHeader } from "../lib/auth.js";

const router = Router();

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB max page size
const FETCH_TIMEOUT = 15000; // 15 seconds
const MAX_OUTPUT_CHARS = 50000; // Same as MAX_UPLOADED_DOC_CHARS in chat route

/**
 * Extract readable text content from HTML, converting to simple markdown.
 */
function htmlToMarkdown(html: string): string {
  // Remove script, style, nav, footer, header tags and their content
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "");

  // Convert headings
  cleaned = cleaned.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  cleaned = cleaned.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  cleaned = cleaned.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  cleaned = cleaned.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  cleaned = cleaned.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  cleaned = cleaned.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert lists
  cleaned = cleaned.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  cleaned = cleaned.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Convert paragraphs and divs to line breaks
  cleaned = cleaned.replace(/<\/p>/gi, "\n\n");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/div>/gi, "\n");

  // Convert bold/italic
  cleaned = cleaned.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  cleaned = cleaned.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Convert links — keep text and URL
  cleaned = cleaned.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Convert tables
  cleaned = cleaned.replace(/<\/td>/gi, " | ");
  cleaned = cleaned.replace(/<\/th>/gi, " | ");
  cleaned = cleaned.replace(/<tr[^>]*>/gi, "\n| ");
  cleaned = cleaned.replace(/<\/tr>/gi, "");

  // Remove remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&laquo;/g, "\u00ab")
    .replace(/&raquo;/g, "\u00bb")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // Clean up whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Extract page title from HTML.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    return match[1].replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
  }
  // Try og:title
  const ogMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i);
  return ogMatch ? ogMatch[1].trim() : "";
}

// POST /api/fetch-url
router.post("/api/fetch-url", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) {
      return res.status(401).json({ error: "Требуется инвайт-код" });
    }

    const { url } = req.body;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL не указан" });
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: "Некорректный URL" });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "Поддерживаются только HTTP/HTTPS ссылки" });
    }

    // V04 + N6: Block private/internal IP ranges to prevent SSRF (including bypass techniques)
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const BLOCKED_HOST_PATTERNS = [
      /^localhost$/,
      /^127\./,
      /^0\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      // IPv6 loopback and private
      /^::1$/,
      /^fe80:/i,
      /^fc00:/i,
      /^fd/i,
      // N6 fix: IPv4-mapped IPv6 (::ffff:127.0.0.1)
      /^::ffff:/i,
      // N6 fix: decimal IP notation (e.g., 2130706433 = 127.0.0.1)
      /^\d{8,10}$/,
      // N6 fix: octal IP notation (e.g., 0177.0.0.1)
      /^0\d+\./,
      // N6 fix: hex IP notation (e.g., 0x7f.0.0.1)
      /^0x[0-9a-f]/i,
      // Domain-based
      /\.internal$/,
      /\.local$/,
      /\.localhost$/,
    ];
    if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname))) {
      return res.status(403).json({ error: "Обращение к внутренним адресам запрещено" });
    }

    // Fetch the page
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SnabChat/1.0; +https://snabchat.ru)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
        },
        redirect: "follow",
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        return res.status(400).json({ error: "Не удалось загрузить страницу: таймаут" });
      }
      return res.status(400).json({ error: "Не удалось загрузить страницу: сайт недоступен" });
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(400).json({ error: `Не удалось загрузить страницу: HTTP ${response.status}` });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      return res.status(400).json({ error: "Страница не содержит текст (тип: " + contentType.split(";")[0] + ")" });
    }

    // Check content length
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: "Страница слишком большая (> 5 МБ)" });
    }

    const html = await response.text();
    if (html.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: "Страница слишком большая (> 5 МБ)" });
    }

    const title = extractTitle(html) || parsedUrl.hostname;
    let markdown = htmlToMarkdown(html);

    // Truncate to max output chars
    if (markdown.length > MAX_OUTPUT_CHARS) {
      markdown = markdown.slice(0, MAX_OUTPUT_CHARS) + "\n\n... (содержимое обрезано)";
    }

    // Skip if too little content extracted
    if (markdown.length < 50) {
      return res.status(400).json({ error: "Не удалось извлечь текст со страницы (возможно, контент загружается через JavaScript)" });
    }

    return res.json({
      title,
      url: parsedUrl.href,
      markdown,
      length: markdown.length,
    });
  } catch (err) {
    console.error("[fetch-url] Error:", err);
    return res.status(500).json({ error: "Ошибка при загрузке страницы" });
  }
});

export default router;
