/**
 * Общие функции форматирования дат.
 * Все даты форматируются для русской локали.
 */

/** Краткая дата с относительными "сегодня"/"вчера" (для сайдбара чата) */
export function formatDateRelative(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();

  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) return "сегодня";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "вчера";

  const months = [
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек",
  ];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/** Дата в формате ДД.ММ.ГГГГ (для таблиц админки) */
export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Дата со временем: "1 янв. 2025 г., 14:30" (для детальных представлений) */
export function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Краткая дата: "1 янв. 2025 г." (для поиска по базе знаний) */
export function formatDateMedium(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/** Московское время в формате ru-RU (для Telegram-уведомлений) */
export function getMoscowTime(): string {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}
