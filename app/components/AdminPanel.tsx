"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import DocumentViewer, { DocumentSource } from "./DocumentViewer";

/* ── Types ── */

interface InviteCode {
  id: string;
  code: string;
  name: string;
  organization: string | null;
  uses_remaining: number | null;
  chat_limit: number | null;
  infographic_limit: number | null;
  device_limit: number | null;
  is_active: boolean;
  created_at: string;
  conversation_count: number;
  device_count: number;
}

interface ActivityItem {
  id: string;
  type: "chat" | "infographic";
  user_name: string;
  organization: string | null;
  content: string;
  created_at: string;
}

interface Source {
  id: number;
  filename: string;
  mime_type: string;
  tags: string[];
  storage_path: string | null;
  folder_path: string | null;
  created_at: string;
}

interface ParsedFile {
  filename: string;
  mimeType: string;
  markdown: string;
  tags: string[];
  chunks: { index: number; preview: string; length: number }[];
  totalChunks: number;
}

interface NontargetItem {
  id: string;
  user_name: string;
  organization: string | null;
  category: string;
  query_text: string;
  created_at: string;
}

interface SupportItem {
  id: string;
  user_name: string;
  organization: string | null;
  message: string;
  admin_reply: string | null;
  admin_number: number | null;
  status: string;
  created_at: string;
  replied_at: string | null;
}

interface UserMessageItem {
  id: string;
  user_name: string;
  organization: string | null;
  content: string;
  created_at: string;
}

interface ErrorItem {
  id: string;
  error_type: string;
  error_message: string;
  endpoint: string | null;
  user_name: string | null;
  organization: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  procurement: "Закупки и снабжение",
  household: "Быт и дом",
  family_personal: "Семья и отношения",
  food_cooking: "Еда и кулинария",
  health_beauty: "Здоровье и красота",
  esoteric: "Эзотерика и гороскопы",
  psychology: "Психология",
  travel: "Путешествия",
  shopping: "Покупки и товары",
  entertainment: "Развлечения",
  tech_personal: "Личные технологии",
  nature_weather: "Природа и погода",
  personal_finance: "Личные финансы",
  education_hobby: "Образование и хобби",
  gambling: "Азартные игры",
  pets: "Домашние питомцы",
  politics: "Политика",
  military: "Войны и военное дело",
  other_off_topic: "Прочее нецелевое",
};

const ERROR_TYPE_LABELS: Record<string, string> = {
  chat: "Чат",
  parse: "Парсинг",
  ingest: "Индексация",
  client: "Клиент",
};

interface AdminPanelProps {
  adminCode: string;
  userName: string;
  onLogout: () => void;
}

/* ── Helpers ── */

/* ── Document Categories (client-side) ── */

const DOC_CATEGORIES = [
  { key: "npa", label: "НПА", icon: "gavel" },
  { key: "standards", label: "Стандарты и Положения", icon: "verified" },
  { key: "forms", label: "Формы и Шаблоны", icon: "article" },
  { key: "schemas", label: "Схемы процессов", icon: "schema" },
  { key: "instructions", label: "Инструкции и Методики", icon: "menu_book" },
  { key: "pricing", label: "Ценообразование", icon: "payments" },
  { key: "references", label: "Справочники и Реестры", icon: "list_alt" },
  { key: "contracts", label: "Договоры", icon: "handshake" },
];

const CATEGORY_KEYWORDS: Record<string, string> = {
  "федеральный закон": "npa", "постановление правительства": "npa",
  "223-фз": "npa", "кодекс": "npa",
  "ценообразование": "pricing", "стоимость чел-час": "pricing",
  "сметная стоимость": "pricing", "базовые цены": "pricing",
  "индексы": "pricing", "индекс": "pricing",
  "коэффициент": "pricing", "тариф": "pricing", "нмцд": "pricing", "фер": "pricing",
  "справочник": "references", "реестр": "references",
  "перечень": "references", "лимит": "references",
  "классификатор": "references", "нормативные сроки": "references",
  "зоны ответственности": "references", "список ответственных": "references",
  "договор": "contracts", "контракт": "contracts",
  "дополнительное соглашение": "contracts", "агентский": "contracts",
  "инструкция": "instructions", "методика": "instructions",
  "руководство": "instructions", "памятка": "instructions",
  "onboarding": "instructions", "обучение": "instructions",
  "форма": "forms", "шаблон": "forms", "бланк": "forms", "образец": "forms",
  "инициация": "forms", "служебная записка": "forms",
  "спецификация": "forms", "техническое задание": "forms",
  "протокол": "forms", "бюллетень": "forms",
  "блок-схема": "schemas", "схема": "schemas",
  "алгоритм": "schemas", "диаграмма": "schemas",
  "стандарт": "standards", "положение": "standards",
  "регламент": "standards", "приказ": "standards", "правила": "standards",
  "закон": "npa", "постановление": "npa", "указ": "npa", "распоряжение": "npa",
};

function detectCategoryClient(tags: string[], filename?: string): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  if (filename) {
    const lower = filename.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "standards";
}

const VALID_CATEGORY_KEYS = new Set(DOC_CATEGORIES.map((c) => c.key));

function normalizeFolderPath(fp: string | null | undefined): string {
  return fp && VALID_CATEGORY_KEYS.has(fp) ? fp : "standards";
}

function getCategoryLabel(key: string | null): string {
  const normalized = normalizeFolderPath(key);
  return DOC_CATEGORIES.find((c) => c.key === normalized)?.label || "Стандарты и Положения";
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function AdminPanel({ adminCode, userName, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<"codes" | "activity" | "documents" | "nontarget" | "support" | "errors" | "messages">("activity");

  // Invite codes state
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newChatLimit, setNewChatLimit] = useState("");
  const [newInfographicLimit, setNewInfographicLimit] = useState("");
  const [newDeviceLimit, setNewDeviceLimit] = useState("2");
  const [creating, setCreating] = useState(false);

  // Edit modal state
  const [editingCode, setEditingCode] = useState<InviteCode | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editChatLimit, setEditChatLimit] = useState("");
  const [editInfographicLimit, setEditInfographicLimit] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState("");

  // Activity state
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const [deletingActivity, setDeletingActivity] = useState(false);

  // Documents state
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [sourceTagInput, setSourceTagInput] = useState("");
  const [docCategoryFilter, setDocCategoryFilter] = useState<string>("all");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<number>>(new Set());
  const [viewingSource, setViewingSource] = useState<DocumentSource | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsedFileCategories, setParsedFileCategories] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<"idle" | "parsing" | "review" | "ingesting" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Nontarget queries state (LLM-classified)
  const [nontargetQueries, setNontargetQueries] = useState<NontargetItem[]>([]);
  const [nontargetStats, setNontargetStats] = useState<{ total: number; by_category: Record<string, number>; by_user: Record<string, { count: number; lastQuery: string; lastDate: string }> }>({ total: 0, by_category: {}, by_user: {} });
  const [nontargetLoading, setNontargetLoading] = useState(false);
  const [nontargetDays, setNontargetDays] = useState(7);
  const [selectedNontargetIds, setSelectedNontargetIds] = useState<Set<string>>(new Set());
  const [deletingNontarget, setDeletingNontarget] = useState(false);

  // User messages state
  const [userMessages, setUserMessages] = useState<UserMessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [deletingMsgs, setDeletingMsgs] = useState(false);

  // Support state
  const [supportMessages, setSupportMessages] = useState<SupportItem[]>([]);
  const [supportStats, setSupportStats] = useState({ total: 0, open: 0, answered: 0, closed: 0 });
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportFilter, setSupportFilter] = useState<string>(""); // "", "open", "answered", "closed"
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);

  // Errors state
  const [errorLogs, setErrorLogs] = useState<ErrorItem[]>([]);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [errorsDays, setErrorsDays] = useState(7);
  const [errorTypeFilter, setErrorTypeFilter] = useState("all");
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // Search/filter state
  const [searchName, setSearchName] = useState("");

  // Mobile sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  /* ── Load data ── */

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch("/api/admin/invite-codes", { headers });
      const data = await res.json();
      if (data.codes) setCodes(data.codes);
    } catch { /* ignore */ }
    setCodesLoading(false);
  }, [adminCode]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch("/api/admin/activity", { headers });
      const data = await res.json();
      if (data.activity) setActivity(data.activity);
    } catch { /* ignore */ }
    setActivityLoading(false);
  }, [adminCode]);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (data.sources) setSources(data.sources);
    } catch { /* ignore */ }
    setSourcesLoading(false);
  }, []);

  const loadNontarget = useCallback(async () => {
    setNontargetLoading(true);
    try {
      const res = await fetch(`/api/admin/off-topic?days=${nontargetDays}`, { headers });
      const data = await res.json();
      if (data.queries) setNontargetQueries(data.queries);
      if (data.stats) setNontargetStats(data.stats);
    } catch { /* ignore */ }
    setNontargetLoading(false);
  }, [adminCode, nontargetDays]);

  const loadUserMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      const res = await fetch("/api/admin/activity?type=messages", { headers });
      const data = await res.json();
      if (data.messages) setUserMessages(data.messages);
    } catch { /* ignore */ }
    setMessagesLoading(false);
  }, [adminCode]);

  const toggleMsgSelection = (id: string) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllMsgs = () => {
    if (selectedMsgIds.size === userMessages.length) {
      setSelectedMsgIds(new Set());
    } else {
      setSelectedMsgIds(new Set(userMessages.map((m) => m.id)));
    }
  };

  const deleteSelectedMessages = async () => {
    if (selectedMsgIds.size === 0) return;
    if (!confirm(`Удалить ${selectedMsgIds.size} сообщений?`)) return;
    setDeletingMsgs(true);
    try {
      const ids = Array.from(selectedMsgIds).join(",");
      await fetch(`/api/admin/activity?type=messages&ids=${ids}`, {
        method: "DELETE",
        headers,
      });
      setSelectedMsgIds(new Set());
      loadUserMessages();
    } catch { /* ignore */ }
    setDeletingMsgs(false);
  };

  const deleteSingleMessage = async (id: string) => {
    if (!confirm("Удалить это сообщение?")) return;
    try {
      await fetch(`/api/admin/activity?type=messages&ids=${id}`, {
        method: "DELETE",
        headers,
      });
      setSelectedMsgIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      loadUserMessages();
    } catch { /* ignore */ }
  };

  const loadSupport = useCallback(async () => {
    setSupportLoading(true);
    try {
      const url = supportFilter ? `/api/admin/support?status=${supportFilter}` : "/api/admin/support";
      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.messages) setSupportMessages(data.messages);
      if (data.stats) setSupportStats(data.stats);
    } catch { /* ignore */ }
    setSupportLoading(false);
  }, [adminCode, supportFilter]);

  const loadErrors = useCallback(async () => {
    setErrorsLoading(true);
    try {
      const res = await fetch(`/api/admin/errors?days=${errorsDays}&type=${errorTypeFilter}`, { headers });
      const data = await res.json();
      if (data.errors) setErrorLogs(data.errors);
    } catch { /* ignore */ }
    setErrorsLoading(false);
  }, [adminCode, errorsDays, errorTypeFilter]);

  useEffect(() => {
    if (tab === "codes") loadCodes();
    else if (tab === "activity") loadActivity();
    else if (tab === "documents") loadSources();
    else if (tab === "nontarget") loadNontarget();
    else if (tab === "support") loadSupport();
    else if (tab === "errors") loadErrors();
    else if (tab === "messages") loadUserMessages();
  }, [tab, loadCodes, loadActivity, loadSources, loadNontarget, loadSupport, loadErrors, loadUserMessages]);

  // Close dropdown on scroll (position: fixed)
  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", close, true);
  }, [openMenuId]);

  /* ── Invite code actions ── */

  const createCode = async () => {
    if (!newCode.trim() || !newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/invite-codes", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode.trim(),
          name: newName.trim(),
          organization: newOrg.trim() || null,
          chat_limit: newChatLimit ? parseInt(newChatLimit) : null,
          infographic_limit: newInfographicLimit ? parseInt(newInfographicLimit) : null,
          device_limit: newDeviceLimit ? parseInt(newDeviceLimit) : null,
        }),
      });
      if (res.ok) {
        setNewCode("");
        setNewName("");
        setNewOrg("");
        setNewChatLimit("");
        setNewInfographicLimit("");
        setNewDeviceLimit("2");
        loadCodes();
      } else {
        const data = await res.json();
        alert(data.error || "Ошибка создания кода");
      }
    } catch { /* ignore */ }
    setCreating(false);
  };

  const deleteCode = async (id: string) => {
    if (!confirm("Удалить этот инвайт-код?")) return;
    try {
      await fetch(`/api/admin/invite-codes?id=${id}`, {
        method: "DELETE",
        headers,
      });
      loadCodes();
    } catch { /* ignore */ }
  };

  const toggleCodeActive = async (id: string, currentActive: boolean) => {
    try {
      await fetch(`/api/admin/invite-codes?id=${id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !currentActive }),
      });
      loadCodes();
    } catch { /* ignore */ }
  };

  const saveEdit = async () => {
    if (!editingCode) return;
    try {
      await fetch(`/api/admin/invite-codes?id=${editingCode.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          organization: editOrg.trim() || null,
          chat_limit: editChatLimit ? parseInt(editChatLimit) : null,
          infographic_limit: editInfographicLimit ? parseInt(editInfographicLimit) : null,
          device_limit: editDeviceLimit ? parseInt(editDeviceLimit) : null,
        }),
      });
      setEditingCode(null);
      loadCodes();
    } catch { /* ignore */ }
  };

  const openEdit = (c: InviteCode) => {
    setEditingCode(c);
    setEditName(c.name);
    setEditOrg(c.organization || "");
    setEditChatLimit(c.chat_limit !== null ? String(c.chat_limit) : "");
    setEditInfographicLimit(c.infographic_limit !== null ? String(c.infographic_limit) : "");
    setEditDeviceLimit(c.device_limit !== null ? String(c.device_limit) : "");
  };

  /* ── Support actions ── */

  const replySupportMessage = async (id: string) => {
    if (!replyText.trim()) return;
    setReplySending(true);
    try {
      await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: replyText.trim() }),
      });
      setReplyingTo(null);
      setReplyText("");
      loadSupport();
    } catch { /* ignore */ }
    setReplySending(false);
  };

  const deleteSupportMessage = async (id: string) => {
    if (!confirm("Удалить это обращение?")) return;
    try {
      await fetch(`/api/admin/support?id=${id}`, { method: "DELETE", headers });
      loadSupport();
    } catch { /* ignore */ }
  };

  /* ── Error actions ── */

  const deleteError = async (id: string) => {
    try {
      await fetch(`/api/admin/errors?id=${id}`, { method: "DELETE", headers });
      setErrorLogs((prev) => prev.filter((e) => e.id !== id));
    } catch { /* ignore */ }
  };

  const deleteNontargetQuery = async (id: string) => {
    try {
      await fetch(`/api/admin/off-topic?id=${id}`, { method: "DELETE", headers });
      setNontargetQueries((prev) => prev.filter((q) => q.id !== id));
      setSelectedNontargetIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch { /* ignore */ }
  };

  const toggleNontargetSelection = (id: string) => {
    setSelectedNontargetIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleAllNontarget = () => {
    if (selectedNontargetIds.size === nontargetQueries.length) {
      setSelectedNontargetIds(new Set());
    } else {
      setSelectedNontargetIds(new Set(nontargetQueries.map((q) => q.id)));
    }
  };

  const deleteSelectedNontarget = async () => {
    if (selectedNontargetIds.size === 0) return;
    if (!confirm(`Удалить ${selectedNontargetIds.size} нецелевых запросов?`)) return;
    setDeletingNontarget(true);
    try {
      await Promise.all(
        Array.from(selectedNontargetIds).map((id) =>
          fetch(`/api/admin/off-topic?id=${id}`, { method: "DELETE", headers })
        )
      );
      setSelectedNontargetIds(new Set());
      loadNontarget();
    } catch { /* ignore */ }
    setDeletingNontarget(false);
  };

  // Activity selection
  const toggleActivitySelection = (id: string) => {
    setSelectedActivityIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleAllActivity = () => {
    if (selectedActivityIds.size === activity.length) {
      setSelectedActivityIds(new Set());
    } else {
      setSelectedActivityIds(new Set(activity.map((a) => a.id)));
    }
  };

  const deleteSelectedActivity = async () => {
    if (selectedActivityIds.size === 0) return;
    if (!confirm(`Удалить ${selectedActivityIds.size} записей?`)) return;
    setDeletingActivity(true);
    try {
      const ids = Array.from(selectedActivityIds).join(",");
      await fetch(`/api/admin/activity?type=messages&ids=${ids}`, {
        method: "DELETE",
        headers,
      });
      setSelectedActivityIds(new Set());
      loadActivity();
    } catch { /* ignore */ }
    setDeletingActivity(false);
  };

  const deleteSingleActivity = async (id: string) => {
    try {
      await fetch(`/api/admin/activity?type=messages&ids=${id}`, {
        method: "DELETE",
        headers,
      });
      setSelectedActivityIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      loadActivity();
    } catch { /* ignore */ }
  };

  const cleanupOrphanedConversations = async () => {
    if (!confirm("Удалить все диалоги без привязки к инвайт-коду?")) return;
    try {
      const res = await fetch("/api/admin/activity", {
        method: "DELETE",
        headers,
      });
      const data = await res.json();
      alert(`Удалено диалогов: ${data.deleted || 0}`);
      loadActivity();
    } catch { /* ignore */ }
  };

  /* ── Document actions ── */

  const deleteSource = async (sourceId: number) => {
    if (!confirm("Удалить этот документ из базы знаний?")) return;
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "DELETE",
        headers,
      });
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch { /* ignore */ }
  };

  const deleteSelectedSources = async () => {
    if (selectedSourceIds.size === 0) return;
    if (!confirm(`Удалить ${selectedSourceIds.size} документ(ов) из базы знаний?`)) return;
    try {
      const ids = Array.from(selectedSourceIds);
      await fetch("/api/sources", {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      setSources((prev) => prev.filter((s) => !selectedSourceIds.has(s.id)));
      setSelectedSourceIds(new Set());
      setBulkSelectMode(false);
    } catch { /* ignore */ }
  };

  const updateSourceTags = async (sourceId: number, tags: string[]) => {
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, tags } : s)));
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
    } catch { /* ignore */ }
  };

  const changeSourceCategory = async (sourceId: number, folderPath: string) => {
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, folder_path: folderPath } : s)));
    setOpenMenuId(null);
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: folderPath }),
      });
    } catch { /* ignore */ }
  };

  const recategorizeAll = async () => {
    let updated = 0;
    const updates: { id: number; folderPath: string }[] = [];
    for (const s of sources) {
      const detected = detectCategoryClient(s.tags || [], s.filename);
      if (detected !== normalizeFolderPath(s.folder_path)) {
        updates.push({ id: s.id, folderPath: detected });
      }
    }
    if (updates.length === 0) return;
    setSources((prev) =>
      prev.map((s) => {
        const u = updates.find((x) => x.id === s.id);
        return u ? { ...s, folder_path: u.folderPath } : s;
      })
    );
    for (const u of updates) {
      try {
        await fetch(`/api/sources?id=${u.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ folder_path: u.folderPath }),
        });
        updated++;
      } catch { /* ignore */ }
    }
    alert(`Категории обновлены: ${updated} документов`);
  };

  const startRename = (doc: Source) => {
    setRenamingId(doc.id);
    setRenameValue(doc.filename);
    setOpenMenuId(null);
  };

  const saveRename = async (sourceId: number) => {
    const newName = renameValue.trim();
    if (!newName) { setRenamingId(null); return; }
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, filename: newName } : s)));
    setRenamingId(null);
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: newName }),
      });
    } catch { /* ignore */ }
  };

  /* ── Upload flow ── */

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    setUploadFiles(fileArray);
    setUploadStage("parsing");
    setParsedFiles([]);

    const parsed: ParsedFile[] = [];
    for (const file of fileArray) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/parse", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          parsed.push(data);
        }
      } catch { /* ignore */ }
    }

    setParsedFiles(parsed);
    // Auto-detect categories from tags
    setParsedFileCategories(parsed.map((pf) => detectCategoryClient(pf.tags, pf.filename)));
    setUploadStage(parsed.length > 0 ? "review" : "idle");
  };

  const ingestFiles = async () => {
    setUploadStage("ingesting");
    setUploadProgress(0);

    for (let i = 0; i < parsedFiles.length; i++) {
      const pf = parsedFiles[i];
      const file = uploadFiles.find((f) => f.name === pf.filename);

      const formData = new FormData();
      if (file) formData.append("file", file);
      formData.append("filename", pf.filename);
      formData.append("mimeType", pf.mimeType);
      formData.append("markdown", pf.markdown);
      formData.append("tags", JSON.stringify(pf.tags));
      formData.append("folderPath", parsedFileCategories[i] || "standards");

      try {
        await fetch("/api/ingest", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
      } catch { /* ignore */ }

      setUploadProgress(((i + 1) / parsedFiles.length) * 100);
    }

    setUploadStage("done");
    loadSources();
    setTimeout(() => {
      setShowUpload(false);
      setUploadStage("idle");
      setUploadFiles([]);
      setParsedFiles([]);
    }, 1500);
  };

  const updateParsedFileTags = (index: number, tags: string[]) => {
    setParsedFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, tags } : f))
    );
  };

  // Filter codes
  const filteredCodes = codes.filter((c) => {
    if (searchName && !c.name.toLowerCase().includes(searchName.toLowerCase()) && !c.code.toLowerCase().includes(searchName.toLowerCase())) return false;
    return true;
  });

  // Filter sources by category
  const filteredSources = docCategoryFilter === "all"
    ? sources
    : sources.filter((s) => normalizeFolderPath(s.folder_path) === docCategoryFilter);

  // Count per category
  const categoryCounts = DOC_CATEGORIES.reduce((acc, cat) => {
    acc[cat.key] = sources.filter((s) => normalizeFolderPath(s.folder_path) === cat.key).length;
    return acc;
  }, {} as Record<string, number>);

  /* ── Nav items config ── */
  const navItems = [
    { key: "activity" as const, label: "Активность", icon: "monitoring" },
    { key: "codes" as const, label: "Инвайт-коды", icon: "key" },
    { key: "documents" as const, label: "База знаний", icon: "menu_book" },
    { key: "nontarget" as const, label: "Нецелевые запросы", icon: "block" },
    { key: "support" as const, label: "Поддержка", icon: "headset_mic" },
    { key: "errors" as const, label: "Ошибки", icon: "error" },
    { key: "messages" as const, label: "Сообщения", icon: "forum" },
  ];

  /* ── Render ── */

  return (
    <div className="admin-layout">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="admin-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Sidebar */}
      <aside className={`admin-sidebar ${sidebarOpen ? "open" : ""}`}>
        <a href="/" className="admin-sidebar-logo">
          <svg width="36" height="36" viewBox="0 0 512 512" fill="none">
            <rect width="512" height="512" rx="112" fill="#F0F4FA"/>
            <rect x="120" y="100" width="200" height="260" rx="28" fill="#0D47A1"/>
            <rect x="160" y="140" width="200" height="260" rx="28" fill="#1976D2"/>
            <rect x="200" y="180" width="200" height="260" rx="28" fill="#42A5F5"/>
            <rect x="328" y="368" width="52" height="40" rx="12" fill="#fff"/>
            <polygon points="338,408 328,424 348,408" fill="#fff"/>
          </svg>
          <div>
            <div className="admin-logo-title" style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 20, letterSpacing: '-0.02em', lineHeight: 1 }}>
              <span style={{ color: '#FFFFFF' }}>Снаб</span><span style={{ color: '#7DD3FC' }}>Чат</span>
            </div>
            <div className="admin-logo-subtitle">Admin Panel</div>
          </div>
        </a>
        <nav className="admin-sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`admin-sidebar-nav-item ${tab === item.key ? "active" : ""}`}
              onClick={() => { setTab(item.key); setSidebarOpen(false); }}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <button className="admin-sidebar-nav-item">
            <span className="material-symbols-outlined">settings</span>
            <span>Настройки</span>
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="admin-main">
        {/* Top bar */}
        <header className="admin-topbar">
          <button className="admin-topbar-hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <span className="material-symbols-outlined">{sidebarOpen ? "close" : "menu"}</span>
          </button>
          <div className="admin-topbar-spacer" />
          <a href="/" className="admin-topbar-link">
            <span className="material-symbols-outlined">chat</span>
            <span className="admin-topbar-link-text">К чату</span>
          </a>
          <div className="admin-topbar-divider" />
          <div className="admin-topbar-user">
            <div className="admin-topbar-user-info">
              <span className="admin-topbar-user-name">{userName}</span>
              <span className="admin-topbar-user-role">Администратор</span>
            </div>
            <div className="admin-topbar-avatar">{getInitials(userName)}</div>
          </div>
          <div className="admin-topbar-divider" />
          <button onClick={onLogout} className="admin-topbar-logout">
            <span className="material-symbols-outlined">logout</span>
            <span className="admin-topbar-link-text">Выйти</span>
          </button>
        </header>

        {/* Workspace */}
        <div className="admin-workspace">
          <div className="admin-content">

            {/* ── Tab: Invite Codes ── */}
            {tab === "codes" && (
              <div>
                {/* Create form card */}
                <div className="admin-card">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Создать инвайт-код</h3>
                    </div>
                  </div>
                  <div className="admin-form-row">
                    <div className="admin-form-field">
                      <label>Код *</label>
                      <input
                        placeholder="напр. ИВАНОВ-2024"
                        value={newCode}
                        onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                      />
                    </div>
                    <div className="admin-form-field" style={{ flex: 2 }}>
                      <label>ФИО получателя *</label>
                      <input
                        placeholder="Иванов Иван Иванович"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                    </div>
                    <div className="admin-form-field" style={{ flex: 1.5 }}>
                      <label>Организация</label>
                      <input
                        placeholder="напр. ООО «Компания»"
                        value={newOrg}
                        onChange={(e) => setNewOrg(e.target.value)}
                      />
                    </div>
                    <div className="admin-form-field" style={{ width: 140 }}>
                      <label>Лимит чата</label>
                      <input
                        placeholder="безлимит"
                        value={newChatLimit}
                        onChange={(e) => setNewChatLimit(e.target.value.replace(/\D/g, ""))}
                      />
                    </div>
                    <div className="admin-form-field" style={{ width: 160 }}>
                      <label>Лимит инфографики</label>
                      <input
                        placeholder="безлимит"
                        value={newInfographicLimit}
                        onChange={(e) => setNewInfographicLimit(e.target.value.replace(/\D/g, ""))}
                      />
                    </div>
                    <div className="admin-form-field" style={{ width: 140 }}>
                      <label>Лимит устройств</label>
                      <input
                        placeholder="безлимит"
                        value={newDeviceLimit}
                        onChange={(e) => setNewDeviceLimit(e.target.value.replace(/\D/g, ""))}
                      />
                    </div>
                    <div className="admin-form-field admin-form-field-btn">
                      <button
                        onClick={createCode}
                        disabled={creating || !newCode.trim() || !newName.trim()}
                        className="admin-btn-primary"
                      >
                        {creating ? "Создание..." : "Создать"}
                      </button>
                    </div>
                  </div>
                  <p className="admin-hint">Пусто = без лимита</p>
                </div>

                {/* Codes table */}
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Инвайт-коды</h3>
                      <span className="admin-card-badge">{filteredCodes.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      <div className="admin-form-field admin-search-field">
                        <input
                          placeholder="Поиск по имени или коду..."
                          value={searchName}
                          onChange={(e) => setSearchName(e.target.value)}
                        />
                      </div>
                      <button className="admin-btn-secondary" onClick={loadCodes} disabled={codesLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
                  </div>

                  {codesLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : filteredCodes.length === 0 ? (
                    <div className="admin-empty">
                      {codes.length === 0 ? "Нет инвайт-кодов" : "Ничего не найдено"}
                    </div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th>Код</th>
                            <th>Имя</th>
                            <th>Организация</th>
                            <th>Чат</th>
                            <th>Инфографика</th>
                            <th>Устройства</th>
                            <th>Статус</th>
                            <th>Создан</th>
                            <th style={{ textAlign: "right" }}>Действия</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredCodes.map((c) => (
                            <tr key={c.id} className={!c.is_active ? "admin-row-inactive" : ""}>
                              <td>
                                <span className="admin-code-badge">{c.code}</span>
                              </td>
                              <td className="admin-cell-name">{c.name}</td>
                              <td className="admin-cell-name">
                                {c.organization || <span className="admin-text-muted">—</span>}
                              </td>
                              <td>
                                {c.chat_limit === null ? (
                                  <span className="admin-text-muted">безлимит</span>
                                ) : (
                                  <span className={c.chat_limit <= 0 ? "admin-text-danger" : ""}>
                                    {c.chat_limit}
                                  </span>
                                )}
                              </td>
                              <td>
                                {c.infographic_limit === null ? (
                                  <span className="admin-text-muted">безлимит</span>
                                ) : (
                                  <span className={c.infographic_limit <= 0 ? "admin-text-danger" : ""}>
                                    {c.infographic_limit}
                                  </span>
                                )}
                              </td>
                              <td>
                                {c.device_limit === null ? (
                                  <span className="admin-text-muted">безлимит</span>
                                ) : (
                                  <span className={c.device_count >= c.device_limit ? "admin-text-danger" : ""}>
                                    {c.device_count}/{c.device_limit}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                                  {c.is_active ? "Активен" : "Отключён"}
                                </span>
                              </td>
                              <td className="admin-cell-date">{formatDate(c.created_at)}</td>
                              <td style={{ textAlign: "right" }}>
                                <div className="admin-actions">
                                  <button className="admin-action-link" onClick={() => openEdit(c)}>
                                    Изменить
                                  </button>
                                  <button
                                    className="admin-action-link admin-action-warning"
                                    onClick={() => toggleCodeActive(c.id, c.is_active)}
                                  >
                                    {c.is_active ? "Отключить" : "Включить"}
                                  </button>
                                  <button
                                    className="admin-action-link admin-action-danger"
                                    onClick={() => deleteCode(c.id)}
                                  >
                                    Удалить
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Activity ── */}
            {tab === "activity" && (
              <div>
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Запросы пользователей</h3>
                      <span className="admin-card-badge">{activity.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      {selectedActivityIds.size > 0 && (
                        <button
                          className="admin-btn-danger"
                          onClick={deleteSelectedActivity}
                          disabled={deletingActivity}
                        >
                          <span className="material-symbols-outlined">delete</span>
                          {deletingActivity ? "Удаление..." : `Удалить (${selectedActivityIds.size})`}
                        </button>
                      )}
                      <button className="admin-btn-secondary" onClick={cleanupOrphanedConversations}>
                        <span className="material-symbols-outlined">delete_sweep</span>
                        Очистить старые
                      </button>
                      <button className="admin-btn-secondary" onClick={loadActivity} disabled={activityLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
                  </div>

                  {activityLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : activity.length === 0 ? (
                    <div className="admin-empty">Нет активности</div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>
                              <input
                                type="checkbox"
                                checked={selectedActivityIds.size === activity.length && activity.length > 0}
                                onChange={toggleAllActivity}
                              />
                            </th>
                            <th>ФИО</th>
                            <th>Организация</th>
                            <th>Тип</th>
                            <th>Запрос</th>
                            <th style={{ textAlign: "right" }}>Время</th>
                            <th style={{ width: 60, textAlign: "right" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {activity.map((a) => (
                            <tr key={a.id} className={selectedActivityIds.has(a.id) ? "admin-row-selected" : ""}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedActivityIds.has(a.id)}
                                  onChange={() => toggleActivitySelection(a.id)}
                                />
                              </td>
                              <td className="admin-cell-name">{a.user_name}</td>
                              <td className="admin-cell-name">
                                {a.organization || <span className="admin-text-muted">—</span>}
                              </td>
                              <td>
                                <span className={`admin-status ${a.type === "chat" ? "active" : "infographic"}`}>
                                  {a.type === "chat" ? "Чат" : "Инфографика"}
                                </span>
                              </td>
                              <td className="admin-cell-title" title={a.content}>
                                {a.content}
                              </td>
                              <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(a.created_at)}</td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="admin-btn-icon-danger"
                                  onClick={() => deleteSingleActivity(a.id)}
                                  title="Удалить"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Documents ── */}
            {tab === "documents" && (
              <div onClick={() => setOpenMenuId(null)}>
                {/* Header */}
                <div className="admin-docs-header">
                  <h2 className="admin-card-title" style={{ fontSize: 24 }}>Документы</h2>
                  <div className="admin-card-actions">
                    {!bulkSelectMode ? (
                      <>
                        {sources.length > 0 && (
                          <button className="admin-btn-secondary" onClick={() => setBulkSelectMode(true)}>
                            <span className="material-symbols-outlined">checklist</span>
                            Выбрать
                          </button>
                        )}
                        <button className="admin-btn-secondary" onClick={recategorizeAll}>
                          <span className="material-symbols-outlined">auto_fix_high</span>
                          Пересортировать
                        </button>
                        <button className="admin-btn-secondary" onClick={loadSources} disabled={sourcesLoading}>
                          <span className="material-symbols-outlined">refresh</span>
                          Обновить
                        </button>
                        <button className="admin-btn-primary" onClick={() => setShowUpload(true)}>
                          <span className="material-symbols-outlined">add</span>
                          Загрузить документ
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="admin-btn-secondary"
                          onClick={() => {
                            const allSelected = filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id));
                            if (allSelected) {
                              setSelectedSourceIds(new Set());
                            } else {
                              setSelectedSourceIds(new Set(filteredSources.map((s) => s.id)));
                            }
                          }}
                        >
                          <span className="material-symbols-outlined">
                            {filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id)) ? "deselect" : "select_all"}
                          </span>
                          {filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id)) ? "Снять всё" : "Выбрать все"}
                        </button>
                        <button
                          className="admin-btn-secondary"
                          style={{ color: selectedSourceIds.size > 0 ? "var(--admin-danger, #ef4444)" : undefined }}
                          disabled={selectedSourceIds.size === 0}
                          onClick={deleteSelectedSources}
                        >
                          <span className="material-symbols-outlined">delete</span>
                          Удалить ({selectedSourceIds.size})
                        </button>
                        <button
                          className="admin-btn-secondary"
                          onClick={() => { setSelectedSourceIds(new Set()); setBulkSelectMode(false); }}
                        >
                          <span className="material-symbols-outlined">close</span>
                          Отмена
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Category filter pills */}
                <div className="admin-doc-pills">
                  <button
                    className={`admin-doc-pill ${docCategoryFilter === "all" ? "active" : ""}`}
                    onClick={() => setDocCategoryFilter("all")}
                  >
                    Все ({sources.length})
                  </button>
                  {DOC_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      className={`admin-doc-pill ${docCategoryFilter === cat.key ? "active" : ""}`}
                      onClick={() => setDocCategoryFilter(cat.key)}
                    >
                      {cat.label} ({categoryCounts[cat.key] || 0})
                    </button>
                  ))}
                </div>

                {/* Card grid */}
                {sourcesLoading ? (
                  <div className="admin-loading-text">
                    <div className="admin-spinner" />
                    Загрузка...
                  </div>
                ) : filteredSources.length === 0 ? (
                  <div className="admin-empty" style={{ padding: "80px 24px" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>description</span>
                    <p>{sources.length === 0 ? "Нет загруженных документов" : "Нет документов в этой категории"}</p>
                    {sources.length === 0 && (
                      <p style={{ fontSize: 12, marginTop: 4 }}>Нажмите «Загрузить документ» чтобы добавить</p>
                    )}
                  </div>
                ) : (
                  <div className="admin-doc-list-view">
                    {filteredSources.map((doc) => {
                      const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx";
                      const isMenuOpen = openMenuId === doc.id;
                      return (
                        <div key={doc.id} className={`admin-doc-row-wrapper${expandedSourceId === doc.id ? " expanded" : ""}`}>
                        <div className="admin-doc-row" onClick={() => {
                          if (bulkSelectMode) {
                            setSelectedSourceIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(doc.id)) next.delete(doc.id);
                              else next.add(doc.id);
                              return next;
                            });
                            return;
                          }
                          setExpandedSourceId(expandedSourceId === doc.id ? null : doc.id);
                        }} style={{ cursor: "pointer" }}>
                          {bulkSelectMode && (
                            <input
                              type="checkbox"
                              checked={selectedSourceIds.has(doc.id)}
                              onChange={() => {
                                setSelectedSourceIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(doc.id)) next.delete(doc.id);
                                  else next.add(doc.id);
                                  return next;
                                });
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: 18, height: 18, flexShrink: 0, cursor: "pointer", accentColor: "var(--admin-primary, #3b82f6)" }}
                            />
                          )}
                          <div className={`doc-icon-lg ${ext}`}>
                            {ext === "pdf" ? (
                              <span className="material-symbols-outlined">picture_as_pdf</span>
                            ) : ext === "xlsx" ? (
                              <span className="material-symbols-outlined">table_chart</span>
                            ) : (
                              <span className="material-symbols-outlined">description</span>
                            )}
                          </div>
                          <div className="admin-doc-row-info">
                            {renamingId === doc.id ? (
                              <form
                                className="admin-doc-rename-form"
                                onSubmit={(e) => { e.preventDefault(); saveRename(doc.id); }}
                              >
                                <input
                                  className="admin-doc-rename-input"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={() => saveRename(doc.id)}
                                  onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </form>
                            ) : (
                              <div className="admin-doc-row-name">{doc.filename}</div>
                            )}
                            <div className="admin-doc-row-meta">
                              <span className="admin-doc-row-cat">{getCategoryLabel(doc.folder_path)}</span>
                              <span>&middot;</span>
                              <span>{formatDate(doc.created_at)}</span>
                              <span>&middot;</span>
                              <span className="admin-doc-row-tags-count">
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>label</span>
                                {doc.tags?.length || 0} тегов
                              </span>
                            </div>
                          </div>
                          <div className="admin-doc-row-actions">
                            <button
                              className="admin-doc-action-btn"
                              title="Просмотр"
                              onClick={(e) => { e.stopPropagation(); setViewingSource(doc); }}
                            >
                              <span className="material-symbols-outlined">visibility</span>
                            </button>
                            <a
                              href={`/api/sources/download?id=${doc.id}&action=download`}
                              className="admin-doc-action-btn"
                              title="Скачать"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="material-symbols-outlined">download</span>
                            </a>
                            <div style={{ position: "relative" }}>
                              <button
                                className="admin-doc-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuId(isMenuOpen ? null : doc.id);
                                }}
                                title="Действия"
                              >
                                <span className="material-symbols-outlined">more_vert</span>
                              </button>
                              {isMenuOpen && (
                                <div
                                  className="admin-doc-card-dropdown"
                                  ref={(el) => {
                    if (el && el.parentElement) {
                      const btn = el.parentElement.querySelector(".admin-doc-action-btn");
                      if (btn) {
                        const btnRect = btn.getBoundingClientRect();
                        const dropH = el.offsetHeight;
                        const spaceBelow = window.innerHeight - btnRect.bottom;
                        if (spaceBelow < dropH + 8) {
                          el.style.top = (btnRect.top - dropH - 4) + "px";
                        } else {
                          el.style.top = (btnRect.bottom + 4) + "px";
                        }
                        el.style.right = (window.innerWidth - btnRect.right) + "px";
                      }
                    }
                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="admin-doc-dropdown-label">Переместить в:</div>
                                  {DOC_CATEGORIES.map((cat) => (
                                    <button
                                      key={cat.key}
                                      className={`admin-doc-dropdown-item ${(doc.folder_path || "other") === cat.key ? "active" : ""}`}
                                      onClick={() => changeSourceCategory(doc.id, cat.key)}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{cat.icon}</span>
                                      {cat.label}
                                    </button>
                                  ))}
                                  <div className="admin-doc-dropdown-divider" />
                                  <button
                                    className="admin-doc-dropdown-item"
                                    onClick={() => startRename(doc)}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
                                    Переименовать
                                  </button>
                                  <button
                                    className="admin-doc-dropdown-item danger"
                                    onClick={() => { setOpenMenuId(null); deleteSource(doc.id); }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                    Удалить
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        {expandedSourceId === doc.id && (
                          <div className="admin-doc-tags-panel" onClick={(e) => e.stopPropagation()}>
                            <div className="admin-doc-tags-list">
                              {(doc.tags || []).length === 0 && (
                                <span className="admin-doc-tags-empty">Нет тегов</span>
                              )}
                              {(doc.tags || []).map((tag) => (
                                <span key={tag} className="admin-tag">
                                  {tag}
                                  <button
                                    onClick={() => updateSourceTags(doc.id, doc.tags.filter((t) => t !== tag))}
                                    className="admin-tag-remove"
                                  >&times;</button>
                                </span>
                              ))}
                            </div>
                            <form
                              className="admin-doc-tag-add-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const val = sourceTagInput.trim();
                                if (val && !(doc.tags || []).includes(val)) {
                                  updateSourceTags(doc.id, [...(doc.tags || []), val]);
                                }
                                setSourceTagInput("");
                              }}
                            >
                              <input
                                className="admin-doc-tag-input"
                                placeholder="Добавить тег..."
                                value={expandedSourceId === doc.id ? sourceTagInput : ""}
                                onChange={(e) => setSourceTagInput(e.target.value)}
                                autoFocus
                              />
                              <button type="submit" className="admin-doc-tag-add-btn">
                                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add</span>
                              </button>
                            </form>
                          </div>
                        )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Upload Modal */}
                {showUpload && (
                  <div className="admin-modal-overlay" onClick={() => { if (uploadStage === "idle" || uploadStage === "done") { setShowUpload(false); setUploadStage("idle"); } }}>
                    <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
                      <div className="admin-modal-header">
                        <h3>Загрузка документов</h3>
                        <button onClick={() => { setShowUpload(false); setUploadStage("idle"); setParsedFiles([]); setUploadFiles([]); }} className="admin-modal-close">&times;</button>
                      </div>
                      <div className="admin-modal-body">
                        {uploadStage === "idle" && (
                          <div>
                            <input
                              ref={fileInputRef}
                              type="file"
                              multiple
                              accept=".docx,.pdf,.xlsx,.xls"
                              style={{ display: "none" }}
                              onChange={(e) => handleFilesSelected(e.target.files)}
                            />
                            <div className="admin-upload-area" onClick={() => fileInputRef.current?.click()}>
                              <span className="material-symbols-outlined" style={{ fontSize: 40, opacity: 0.4, marginBottom: 8 }}>upload_file</span>
                              <p>Нажмите для выбора файлов</p>
                              <p className="hint">DOCX, PDF, Excel</p>
                            </div>
                          </div>
                        )}
                        {uploadStage === "parsing" && (
                          <div className="admin-loading-text">
                            <div className="admin-spinner" />
                            Парсинг файлов...
                          </div>
                        )}
                        {uploadStage === "review" && (
                          <div>
                            <p style={{ marginBottom: 16, fontWeight: 500 }}>Готово к загрузке: {parsedFiles.length} файлов</p>
                            {parsedFiles.map((pf, i) => (
                              <div key={i} className="admin-card" style={{ marginBottom: 12 }}>
                                <div style={{ fontWeight: 500, marginBottom: 4 }}>{pf.filename}</div>
                                <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>
                                  {pf.totalChunks} чанков
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                  <label style={{ fontSize: 12, fontWeight: 500, color: "#64748B", display: "block", marginBottom: 4 }}>
                                    Категория
                                  </label>
                                  <select
                                    className="admin-category-select"
                                    value={parsedFileCategories[i] || "standards"}
                                    onChange={(e) => {
                                      setParsedFileCategories((prev) => {
                                        const next = [...prev];
                                        next[i] = e.target.value;
                                        return next;
                                      });
                                    }}
                                  >
                                    {DOC_CATEGORIES.map((cat) => (
                                      <option key={cat.key} value={cat.key}>{cat.label}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="admin-doc-tags">
                                  {pf.tags.map((tag) => (
                                    <span key={tag} className="admin-tag">
                                      {tag}
                                      <button
                                        onClick={() => updateParsedFileTags(i, pf.tags.filter((t) => t !== tag))}
                                        className="admin-tag-remove"
                                      >
                                        &times;
                                      </button>
                                    </span>
                                  ))}
                                  <form
                                    className="admin-doc-tag-add-form"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      const input = e.currentTarget.querySelector("input") as HTMLInputElement;
                                      const val = input.value.trim().toLowerCase();
                                      if (val && !pf.tags.includes(val)) {
                                        updateParsedFileTags(i, [...pf.tags, val]);
                                      }
                                      input.value = "";
                                    }}
                                  >
                                    <input
                                      className="admin-doc-tag-input"
                                      placeholder="+ добавить тег"
                                      onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }}
                                    />
                                    <button type="submit" className="admin-doc-tag-add-btn">
                                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                                    </button>
                                  </form>
                                </div>
                              </div>
                            ))}
                            <button className="admin-btn-primary" onClick={ingestFiles} style={{ marginTop: 16, width: "100%" }}>
                              Загрузить в базу знаний
                            </button>
                          </div>
                        )}
                        {uploadStage === "ingesting" && (
                          <div>
                            <div className="admin-loading-text">
                              <div className="admin-spinner" />
                              Индексация...
                            </div>
                            <div className="admin-progress-bar">
                              <div className="admin-progress-fill" style={{ width: `${uploadProgress}%` }} />
                            </div>
                          </div>
                        )}
                        {uploadStage === "done" && (
                          <div className="admin-loading-text admin-success-text">
                            <span className="material-symbols-outlined">check_circle</span>
                            Готово!
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* ── Tab: Nontarget Queries (LLM-classified) ── */}
            {tab === "nontarget" && (
              <div>
                {/* Period selector + stats */}
                <div className="admin-card">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Нецелевые запросы</h3>
                      <span className="admin-card-badge">{nontargetStats.total}</span>
                    </div>
                    <div className="admin-card-actions">
                      {[1, 7, 30, 90].map((d) => (
                        <button
                          key={d}
                          className={`admin-btn-secondary ${nontargetDays === d ? "admin-btn-active" : ""}`}
                          onClick={() => setNontargetDays(d)}
                        >
                          {d === 1 ? "Сегодня" : `${d} дн`}
                        </button>
                      ))}
                      <button className="admin-btn-secondary" onClick={loadNontarget} disabled={nontargetLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                      </button>
                    </div>
                  </div>

                  {/* Category breakdown */}
                  {Object.keys(nontargetStats.by_category).length > 0 && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 16px 16px" }}>
                      {Object.entries(nontargetStats.by_category)
                        .sort(([, a], [, b]) => b - a)
                        .map(([cat, count]) => (
                          <span key={cat} className="admin-code-badge" style={{ fontSize: 12 }}>
                            {CATEGORY_LABELS[cat] ?? cat}: {count}
                          </span>
                        ))}
                    </div>
                  )}
                </div>

                {/* Queries list */}
                <div className="admin-card admin-card-table">
                  {selectedNontargetIds.size > 0 && (
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border, #E2E8F0)", display: "flex", alignItems: "center", gap: 12 }}>
                      <button
                        className="admin-btn-danger"
                        onClick={deleteSelectedNontarget}
                        disabled={deletingNontarget}
                      >
                        <span className="material-symbols-outlined">delete</span>
                        {deletingNontarget ? "Удаление..." : `Удалить (${selectedNontargetIds.size})`}
                      </button>
                    </div>
                  )}
                  {nontargetLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : nontargetQueries.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>block</span>
                      <p>Нет нецелевых запросов за этот период</p>
                    </div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>
                              <input
                                type="checkbox"
                                checked={selectedNontargetIds.size === nontargetQueries.length && nontargetQueries.length > 0}
                                onChange={toggleAllNontarget}
                              />
                            </th>
                            <th style={{ width: "13%" }}>ФИО</th>
                            <th style={{ width: "12%" }}>Организация</th>
                            <th style={{ width: "15%" }}>Категория</th>
                            <th>Запрос</th>
                            <th style={{ width: "10%" }}>Время</th>
                            <th style={{ width: 60, textAlign: "right" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {nontargetQueries.map((q) => (
                            <tr key={q.id} className={selectedNontargetIds.has(q.id) ? "admin-row-selected" : ""}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedNontargetIds.has(q.id)}
                                  onChange={() => toggleNontargetSelection(q.id)}
                                />
                              </td>
                              <td className="admin-cell-name">{q.user_name}</td>
                              <td>{q.organization || <span className="admin-text-muted">—</span>}</td>
                              <td>
                                <span className="admin-code-badge" style={{ fontSize: 11 }}>
                                  {CATEGORY_LABELS[q.category] ?? q.category}
                                </span>
                              </td>
                              <td className="admin-cell-message">{q.query_text}</td>
                              <td className="admin-cell-date">{formatDateTime(q.created_at)}</td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="admin-btn-icon-danger"
                                  onClick={() => deleteNontargetQuery(q.id)}
                                  title="Удалить"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Support ── */}
            {tab === "support" && (
              <div>
                {/* Stats cards */}
                <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                  {[
                    { label: "Открытые", value: supportStats.open, color: "#e67700" },
                    { label: "Отвечено", value: supportStats.answered, color: "#2f9e44" },
                    { label: "Закрытые", value: supportStats.closed, color: "#868e96" },
                  ].map((s) => (
                    <div key={s.label} className="admin-card" style={{ flex: 1, textAlign: "center", padding: 16 }}>
                      <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Обращения</h3>
                    </div>
                    <div className="admin-card-actions">
                      {["", "open", "answered", "closed"].map((f) => (
                        <button
                          key={f}
                          className={`admin-btn-secondary ${supportFilter === f ? "admin-btn-active" : ""}`}
                          onClick={() => setSupportFilter(f)}
                        >
                          {f === "" ? "Все" : f === "open" ? "Открытые" : f === "answered" ? "Отвечено" : "Закрытые"}
                        </button>
                      ))}
                      <button className="admin-btn-secondary" onClick={loadSupport} disabled={supportLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                      </button>
                    </div>
                  </div>

                  {supportLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : supportMessages.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>headset_mic</span>
                      <p>Нет обращений</p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
                      {supportMessages.map((m) => (
                        <div key={m.id} className="admin-card" style={{ padding: 16 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                            <div>
                              <strong>{m.user_name}</strong>
                              {m.organization && <span className="admin-text-muted"> · {m.organization}</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span className={`admin-status ${m.status === "open" ? "active" : m.status === "answered" ? "" : "inactive"}`}>
                                {m.status === "open" ? "Открыто" : m.status === "answered" ? "Отвечено" : "Закрыто"}
                              </span>
                              <span className="admin-cell-date">{formatDateTime(m.created_at)}</span>
                            </div>
                          </div>
                          <div style={{ background: "var(--bg-secondary, #f5f5f5)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                            {m.message}
                          </div>
                          {m.admin_reply && (
                            <div style={{ background: "#e8f4fd", borderRadius: 8, padding: 12, marginBottom: 8, borderLeft: "3px solid #1976d2" }}>
                              <div style={{ fontSize: 12, color: "#1976d2", marginBottom: 4 }}>
                                Ответ администратора {m.admin_number ?? ""} · {m.replied_at ? formatDateTime(m.replied_at) : ""}
                              </div>
                              {m.admin_reply}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            {!m.admin_reply && replyingTo !== m.id && (
                              <button className="admin-btn-primary" onClick={() => { setReplyingTo(m.id); setReplyText(""); }}>
                                Ответить
                              </button>
                            )}
                            {replyingTo === m.id && (
                              <div style={{ flex: 1 }}>
                                <textarea
                                  className="admin-textarea"
                                  value={replyText}
                                  onChange={(e) => setReplyText(e.target.value)}
                                  placeholder="Введите ответ..."
                                  rows={3}
                                  style={{ width: "100%", marginBottom: 8 }}
                                />
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button className="admin-btn-primary" onClick={() => replySupportMessage(m.id)} disabled={replySending || !replyText.trim()}>
                                    {replySending ? "Отправка..." : "Отправить"}
                                  </button>
                                  <button className="admin-btn-secondary" onClick={() => setReplyingTo(null)}>Отмена</button>
                                </div>
                              </div>
                            )}
                            <button
                              className="admin-action-link admin-action-danger"
                              onClick={() => deleteSupportMessage(m.id)}
                              title="Удалить"
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Errors ── */}
            {tab === "errors" && (
              <div>
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Ошибки</h3>
                      <span className="admin-card-badge">{errorLogs.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      {[1, 7, 30, 90].map((d) => (
                        <button
                          key={d}
                          className={`admin-btn-secondary ${errorsDays === d ? "admin-btn-active" : ""}`}
                          onClick={() => setErrorsDays(d)}
                        >
                          {d === 1 ? "Сегодня" : `${d} дн`}
                        </button>
                      ))}
                      <span style={{ width: 1, background: "var(--border-color, #e0e0e0)", alignSelf: "stretch" }} />
                      {["all", "chat", "parse", "ingest", "client"].map((t) => (
                        <button
                          key={t}
                          className={`admin-btn-secondary ${errorTypeFilter === t ? "admin-btn-active" : ""}`}
                          onClick={() => setErrorTypeFilter(t)}
                        >
                          {t === "all" ? "Все" : ERROR_TYPE_LABELS[t] ?? t}
                        </button>
                      ))}
                      <button className="admin-btn-secondary" onClick={loadErrors} disabled={errorsLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                      </button>
                    </div>
                  </div>

                  {errorsLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : errorLogs.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>check_circle</span>
                      <p>Нет ошибок за этот период</p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
                      {errorLogs.map((e) => (
                        <div key={e.id} className="admin-card" style={{ padding: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span className="admin-code-badge" style={{
                                fontSize: 11,
                                background: e.error_type === "chat" ? "#fff3bf" : e.error_type === "client" ? "#ffe8cc" : e.error_type === "parse" ? "#d3f9d8" : "#e7f5ff",
                              }}>
                                {ERROR_TYPE_LABELS[e.error_type] ?? e.error_type}
                              </span>
                              {e.user_name && <span style={{ fontSize: 13 }}>{e.user_name}</span>}
                              {e.endpoint && <span className="admin-text-muted" style={{ fontSize: 12 }}>{e.endpoint}</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span className="admin-cell-date">{formatDateTime(e.created_at)}</span>
                              <button
                                className="admin-action-link admin-action-danger"
                                onClick={() => deleteError(e.id)}
                                title="Удалить"
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                              </button>
                            </div>
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              color: "var(--text-secondary)",
                              cursor: "pointer",
                              whiteSpace: expandedErrors.has(e.id) ? "pre-wrap" : "nowrap",
                              overflow: expandedErrors.has(e.id) ? "visible" : "hidden",
                              textOverflow: "ellipsis",
                            }}
                            onClick={() => setExpandedErrors((prev) => {
                              const next = new Set(prev);
                              if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                              return next;
                            })}
                          >
                            {e.error_message}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: User Messages ── */}
            {tab === "messages" && (
              <div>
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Сообщения пользователей</h3>
                      <span className="admin-card-badge">{userMessages.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      {selectedMsgIds.size > 0 && (
                        <button
                          className="admin-btn-danger"
                          onClick={deleteSelectedMessages}
                          disabled={deletingMsgs}
                        >
                          <span className="material-symbols-outlined">delete</span>
                          {deletingMsgs ? "Удаление..." : `Удалить (${selectedMsgIds.size})`}
                        </button>
                      )}
                      <button className="admin-btn-secondary" onClick={loadUserMessages} disabled={messagesLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
                  </div>

                  {messagesLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : userMessages.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>forum</span>
                      <p>Нет сообщений</p>
                    </div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>
                              <input
                                type="checkbox"
                                checked={selectedMsgIds.size === userMessages.length && userMessages.length > 0}
                                onChange={toggleAllMsgs}
                              />
                            </th>
                            <th style={{ width: "15%" }}>ФИО</th>
                            <th style={{ width: "15%" }}>Организация</th>
                            <th>Сообщение</th>
                            <th style={{ width: "12%", textAlign: "right" }}>Время</th>
                            <th style={{ width: 60, textAlign: "right" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {userMessages.map((m) => (
                            <tr key={m.id} className={selectedMsgIds.has(m.id) ? "admin-row-selected" : ""}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedMsgIds.has(m.id)}
                                  onChange={() => toggleMsgSelection(m.id)}
                                />
                              </td>
                              <td className="admin-cell-name">{m.user_name}</td>
                              <td>
                                {m.organization || <span className="admin-text-muted">—</span>}
                              </td>
                              <td className="admin-cell-message">{m.content}</td>
                              <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(m.created_at)}</td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="admin-btn-icon-danger"
                                  onClick={() => deleteSingleMessage(m.id)}
                                  title="Удалить сообщение"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {editingCode && (
        <div className="admin-modal-overlay" onClick={() => setEditingCode(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Редактирование: {editingCode.code}</h3>
              <button onClick={() => setEditingCode(null)} className="admin-modal-close">&times;</button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-form-group">
                <label>ФИО</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="admin-form-group">
                <label>Организация</label>
                <input
                  value={editOrg}
                  onChange={(e) => setEditOrg(e.target.value)}
                  placeholder="напр. ООО «Компания»"
                />
              </div>
              <div className="admin-form-group">
                <label>Лимит запросов в чат</label>
                <input
                  value={editChatLimit}
                  onChange={(e) => setEditChatLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="Пусто = безлимит"
                />
              </div>
              <div className="admin-form-group">
                <label>Лимит инфографики</label>
                <input
                  value={editInfographicLimit}
                  onChange={(e) => setEditInfographicLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="Пусто = безлимит"
                />
              </div>
              <div className="admin-form-group">
                <label>Лимит устройств</label>
                <input
                  value={editDeviceLimit}
                  onChange={(e) => setEditDeviceLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="Пусто = безлимит"
                />
              </div>
              <div className="admin-modal-actions">
                <button className="admin-btn-secondary" onClick={() => setEditingCode(null)}>Отмена</button>
                <button className="admin-btn-primary" onClick={saveEdit}>Сохранить</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {viewingSource && (
        <DocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}
    </div>
  );
}
