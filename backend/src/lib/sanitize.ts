import DOMPurify from "isomorphic-dompurify";

/** Экранирует строку для безопасного использования в XML-атрибутах */
export function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Санитизация содержимого документов для защиты от промпт-инъекций */
export function sanitizeDocContent(content: string): string {
  const filtered = content
    .replace(/<\/?(?:system|instructions?|prompt|override|admin|role)\b[^>]*>/gi, "[filtered]")
    .replace(/(?:ignore|forget|disregard|забудь|игнорируй|отбрось)\s+(?:all\s+|все\s+)?(?:previous|above|prior|предыдущие|прошлые|выше)\s+(?:instructions?|rules?|prompts?|инструкции|правила|промпт)/gi, "[filtered]")
    .replace(/(?:SYSTEM\s*OVERRIDE|ADMIN\s*MODE|NEW\s*INSTRUCTIONS?|НОВЫЕ\s*ИНСТРУКЦИИ)/gi, "[filtered]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // Экранируем XML-спецсимволы, чтобы содержимое документа
  // не могло закрыть теги <document>/<documents> и подменить структуру промпта.
  return filtered
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Санитизирует HTML-строку, удаляя потенциально опасные теги и атрибуты.
 * Используется для рендера пользовательского/внешнего HTML через dangerouslySetInnerHTML.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr", "span", "div",
      "strong", "b", "em", "i", "u", "s", "sub", "sup",
      "ul", "ol", "li",
      "table", "thead", "tbody", "tr", "th", "td", "caption", "colgroup", "col",
      "a", "img",
      "blockquote", "pre", "code",
      "mark",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "class", "id",
      "colspan", "rowspan", "width", "height", "style",
      "target", "rel",
    ],
    ALLOW_DATA_ATTR: false,
  });
}

/** Экранирует HTML-сущности в строке */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Безопасная подсветка совпадений в тексте.
 * 1. Экранирует HTML-сущности в исходном тексте
 * 2. Оборачивает совпадения в <mark>
 */
export function highlightText(text: string, query: string): string {
  const escaped = escapeHtml(text);
  if (!query.trim()) return escaped;

  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return escaped;

  const regex = new RegExp(`(${words.join("|")})`, "gi");
  return escaped.replace(regex, "<mark>$1</mark>");
}
