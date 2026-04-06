import { NextRequest, NextResponse } from "next/server";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse, badRequest, serverError } from "@/app/lib/api-helpers";
import dns from "node:dns/promises";
import net from "node:net";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB max page size
const FETCH_TIMEOUT = 15000; // 15 seconds
const MAX_OUTPUT_CHARS = 50000; // Same as MAX_UPLOADED_DOC_CHARS in chat route

// ── SSRF Protection ──

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

/**
 * Check if an IP address is in a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                             // 0.0.0.0/8
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 127) return true;                           // 127.0.0.0/8
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;                 // IPv6 loopback
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 (ULA)
    if (normalized.startsWith("fe80")) return true;        // fe80::/10 (link-local)
    return false;
  }

  return false;
}

/**
 * Validate that a URL hostname does not resolve to a private/internal IP.
 * Prevents SSRF attacks targeting internal services and cloud metadata endpoints.
 */
async function validateUrlTarget(url: URL): Promise<string | null> {
  const hostname = url.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return "Доступ к внутренним ресурсам запрещён";
  }

  // If hostname is already an IP, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return "Доступ к внутренним ресурсам запрещён";
    }
    return null;
  }

  // Resolve hostname and check all IPs
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const allAddresses = [...addresses, ...addresses6];

    if (allAddresses.length === 0) {
      return "Не удалось разрешить доменное имя";
    }

    for (const addr of allAddresses) {
      if (isPrivateIP(addr)) {
        return "Доступ к внутренним ресурсам запрещён";
      }
    }
  } catch {
    return "Не удалось разрешить доменное имя";
  }

  return null;
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
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
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

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

  try {
    const { url } = await req.json();

    if (!url || typeof url !== "string") {
      return badRequest("URL не указан");
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return badRequest("Некорректный URL");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return badRequest("Поддерживаются только HTTP/HTTPS ссылки");
    }

    // SSRF protection: validate that the URL does not point to internal/private resources
    const ssrfError = await validateUrlTarget(parsedUrl);
    if (ssrfError) {
      return badRequest(ssrfError);
    }

    // Fetch the page (manual redirect to validate each hop)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response: Response;
    try {
      for (let i = 0; i <= MAX_REDIRECTS; i++) {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; SnabChat/1.0; +https://snabchat.ru)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
          },
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const redirectUrl = new URL(location, currentUrl);
          if (!["http:", "https:"].includes(redirectUrl.protocol)) {
            return badRequest("Некорректный редирект");
          }
          // Validate redirect target against SSRF
          const redirectSsrfError = await validateUrlTarget(redirectUrl);
          if (redirectSsrfError) {
            return badRequest(redirectSsrfError);
          }
          currentUrl = redirectUrl.href;
          continue;
        }
        break;
      }
      // response is set by the loop above
      response = response!;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        return badRequest("Не удалось загрузить страницу: таймаут");
      }
      return badRequest("Не удалось загрузить страницу: сайт недоступен");
    }
    clearTimeout(timeout);

    if (!response.ok) {
      return badRequest(`Не удалось загрузить страницу: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      return badRequest("Страница не содержит текст (тип: " + contentType.split(";")[0] + ")");
    }

    // Check content length
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_CONTENT_LENGTH) {
      return badRequest("Страница слишком большая (> 5 МБ)");
    }

    const html = await response.text();
    if (html.length > MAX_CONTENT_LENGTH) {
      return badRequest("Страница слишком большая (> 5 МБ)");
    }

    const title = extractTitle(html) || parsedUrl.hostname;
    let markdown = htmlToMarkdown(html);

    // Truncate to max output chars
    if (markdown.length > MAX_OUTPUT_CHARS) {
      markdown = markdown.slice(0, MAX_OUTPUT_CHARS) + "\n\n... (содержимое обрезано)";
    }

    // Skip if too little content extracted
    if (markdown.length < 50) {
      return badRequest("Не удалось извлечь текст со страницы (возможно, контент загружается через JavaScript)");
    }

    return NextResponse.json({
      title,
      url: parsedUrl.href,
      markdown,
      length: markdown.length,
    });
  } catch (err) {
    console.error("[fetch-url] Error:", err);
    return serverError("Ошибка при загрузке страницы");
  }
}
