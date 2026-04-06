import DOMPurify from "isomorphic-dompurify";

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
