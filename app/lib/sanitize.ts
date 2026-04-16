import DOMPurify from "isomorphic-dompurify";

/**
 * M-E fix: хук afterSanitizeAttributes, принудительно ставящий безопасные атрибуты
 * на все внешние ссылки. Вызывается один раз при первой загрузке модуля.
 */
let _hookInstalled = false;
function ensureHook(): void {
  if (_hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Любая ссылка с target получает rel="noopener noreferrer" для защиты от tabnabbing
    if (node.nodeName === "A" && node instanceof Element) {
      const target = node.getAttribute("target");
      if (target) {
        node.setAttribute("rel", "noopener noreferrer");
      }
      // javascript:-ссылки уже режет DOMPurify по умолчанию, но дополнительно проверяем href
      const href = node.getAttribute("href") ?? "";
      if (/^\s*javascript:/i.test(href)) {
        node.removeAttribute("href");
      }
    }
  });
  _hookInstalled = true;
}

/**
 * Санитизирует HTML-строку, удаляя потенциально опасные теги и атрибуты.
 * Используется для рендера пользовательского/внешнего HTML через dangerouslySetInnerHTML.
 *
 * M-E: из ALLOWED_ATTR убран "style" (рендер стилизуется классами; style допускал CSS-инъекции
 * через url()/expression() в устаревших движках и визуальное маскирование для фишинга).
 */
export function sanitizeHtml(html: string): string {
  ensureHook();
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
      "colspan", "rowspan", "width", "height",
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
