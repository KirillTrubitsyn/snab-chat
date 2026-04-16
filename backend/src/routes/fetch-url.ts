import { Router, Request, Response } from "express";
import { promises as dns } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";
import { getInviteCodeFromHeader } from "../lib/auth.js";

const router = Router();

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB max page size
const FETCH_TIMEOUT = 15000; // 15 seconds
const MAX_OUTPUT_CHARS = 50000; // Same as MAX_UPLOADED_DOC_CHARS in chat route

// M-B fix: диапазоны IP, к которым запрещено обращаться (защита от SSRF + DNS rebinding)
const BLOCKED_IP_RANGES = new Set([
  "private",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "carrierGradeNat",
  "reserved",
  "unspecified",
  "multicast",
  "broadcast",
]);

function isBlockedIP(ip: string): boolean {
  try {
    const addr = ipaddr.parse(ip);
    const range = addr.range();
    if (BLOCKED_IP_RANGES.has(range)) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d): проверяем базовый IPv4
    if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
      const v4 = (addr as ipaddr.IPv6).toIPv4Address();
      return BLOCKED_IP_RANGES.has(v4.range());
    }
    return false;
  } catch {
    // Неразборчивый IP — блокируем
    return true;
  }
}

/**
 * Резолвит hostname во все A и AAAA записи, валидирует КАЖДЫЙ IP против чёрного списка диапазонов.
 * Если хотя бы один IP попадает во внутренний диапазон — отказ (защита от multi-answer DNS rebinding).
 * Возвращает первый допустимый IP для закрепления в undici Agent (защита от TTL=0 rebinding).
 */
async function resolveAndPinHostname(hostname: string): Promise<{ ip: string; family: 4 | 6 }> {
  // Если пользователь передал голый IP — валидируем напрямую, DNS не нужен
  if (ipaddr.isValid(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error("BLOCKED_IP");
    }
    const family = ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6;
    return { ip: hostname, family };
  }

  const [ipv4, ipv6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);

  const all = [...ipv4, ...ipv6];
  if (all.length === 0) {
    throw new Error("NO_DNS");
  }

  for (const ip of all) {
    if (isBlockedIP(ip)) {
      throw new Error("BLOCKED_IP");
    }
  }

  if (ipv4.length > 0) {
    return { ip: ipv4[0], family: 4 };
  }
  return { ip: ipv6[0], family: 6 };
}

/**
 * Строит undici Agent, закреплённый на заранее проверенном IP.
 * Все последующие соединения внутри этого Agent резолвят hostname только в указанный IP,
 * что исключает DNS rebinding между моментом проверки и моментом TCP-соединения.
 */
function createPinnedAgent(pinnedIP: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, cb) => {
        cb(null, pinnedIP, family);
      },
    },
    connectTimeout: 10_000,
    bodyTimeout: FETCH_TIMEOUT,
    headersTimeout: FETCH_TIMEOUT,
  });
}

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

    // M-B fix: доменные суффиксы, недопустимые независимо от результата DNS
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const BLOCKED_DOMAIN_SUFFIXES = [/\.internal$/, /\.local$/, /\.localhost$/, /^localhost$/];
    if (BLOCKED_DOMAIN_SUFFIXES.some((p) => p.test(hostname))) {
      return res.status(403).json({ error: "Обращение к внутренним адресам запрещено" });
    }

    // Fetch the page with manual redirect handling to prevent SSRF via redirect chains
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const MAX_REDIRECTS = 5;
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (compatible; SnabChat/1.0; +https://snabchat.ru)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
    };

    let response!: Awaited<ReturnType<typeof undiciFetch>>;
    let currentUrl = url;
    const agents: Agent[] = [];
    try {
      for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const targetUrl = new URL(currentUrl);
        const targetHost = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");

        if (BLOCKED_DOMAIN_SUFFIXES.some((p) => p.test(targetHost))) {
          return res.status(403).json({ error: "Обращение к внутренним адресам запрещено" });
        }

        // M-B fix: резолвим DNS единожды перед каждым хопом, валидируем все IP,
        // затем закрепляем undici Agent на первом допустимом IP, чтобы предотвратить rebinding.
        let pinned: { ip: string; family: 4 | 6 };
        try {
          pinned = await resolveAndPinHostname(targetHost);
        } catch (e) {
          if (e instanceof Error && e.message === "BLOCKED_IP") {
            return res.status(403).json({ error: "Обращение к внутренним адресам запрещено" });
          }
          return res.status(400).json({ error: "Не удалось разрешить имя хоста" });
        }

        const dispatcher = createPinnedAgent(pinned.ip, pinned.family);
        agents.push(dispatcher);

        response = await undiciFetch(currentUrl, {
          signal: controller.signal,
          headers: fetchHeaders,
          redirect: "manual",
          dispatcher,
        });

        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.get("location");
          if (!location) break;

          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, currentUrl);
          } catch {
            return res.status(400).json({ error: "Некорректный редирект" });
          }

          if (!["http:", "https:"].includes(redirectUrl.protocol)) {
            return res.status(400).json({ error: "Некорректный редирект" });
          }

          currentUrl = redirectUrl.href;
          if (i === MAX_REDIRECTS) {
            return res.status(400).json({ error: "Слишком много редиректов" });
          }
          continue;
        }

        break;
      }
    } catch (err) {
      clearTimeout(timeout);
      for (const a of agents) await a.close().catch(() => {});
      if (err instanceof Error && err.name === "AbortError") {
        return res.status(400).json({ error: "Не удалось загрузить страницу: таймаут" });
      }
      return res.status(400).json({ error: "Не удалось загрузить страницу: сайт недоступен" });
    }
    clearTimeout(timeout);

    try {
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
    } finally {
      // Освобождаем все закреплённые undici Agent (TCP-сокеты)
      for (const a of agents) await a.close().catch(() => {});
    }
  } catch (err) {
    console.error("[fetch-url] Error:", err);
    return res.status(500).json({ error: "Ошибка при загрузке страницы" });
  }
});

export default router;
