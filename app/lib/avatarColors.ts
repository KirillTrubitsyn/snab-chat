export const AVATAR_COLORS = [
  "#0099CC", // голубой (accent)
  "#1565C0", // синий
  "#2E7D32", // зелёный
  "#6A1B9A", // фиолетовый
  "#C62828", // красный
  "#E65100", // оранжевый
];

const STORAGE_KEY = "snabchat_avatar_color";

export function getOrAssignAvatarColor(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && AVATAR_COLORS.includes(stored)) return stored;
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  localStorage.setItem(STORAGE_KEY, color);
  return color;
}

export function getAvatarColor(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && AVATAR_COLORS.includes(stored) ? stored : AVATAR_COLORS[0];
}

export function setAvatarColor(color: string): void {
  localStorage.setItem(STORAGE_KEY, color);
}
