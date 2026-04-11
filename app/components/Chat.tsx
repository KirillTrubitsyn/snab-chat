"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import InviteGate from "./InviteGate";
import { containsMarkdownTable } from "@/app/lib/markdown-tables";
import KBSearchBar from "@/app/components/KBSearchBar";
import { formatDateRelative } from "@/app/lib/date-utils";
import { apiUrl } from "@/app/lib/api";
import { AVATAR_COLORS } from "@/app/lib/avatarColors";
import {
  VoiceButton,
  CameraButton,
  MessageBubble,
  EmptyState,
  ChatDocumentViewer,
  SpektrIcon,
  MenuIcon,
  ArrowUpIcon,
  HistoryIcon,
  InfographicIcon,
} from "./chat";
import type { Source } from "./chat/types";
import {
  useAuth,
  useClickOutside,
  useConversations,
  useExport,
  useFileAttachments,
  useInfographics,
  useSources,
  useStreaming,
  useSupport,
} from "@/app/hooks";

/* ── Helpers ── */

const formatDate = formatDateRelative;

function TypingBubble() {
  return (
    <div className="message message-ai" style={{ padding: "12px 18px" }}>
      <div className="typing-indicator">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Main Chat component — sub-components extracted to ./chat/
   ═══════════════════════════════════════════════ */

export default function Chat() {
  /* ── Hooks ── */
  const auth = useAuth();
  const {
    isAuthenticated, inviteCode, inviteCodeRef, userName, userInitials,
    avatarColor, setAvatarColor, authLoading, isAdmin, isDocAdmin,
    handleAuthSuccess, handleLogout,
  } = auth;

  /* ── UI State (not extracted — purely local) ── */
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(userMenuRef, userMenuOpen, () => setUserMenuOpen(false));
  useClickOutside(mobileMenuRef, mobileMenuOpen, () => setMobileMenuOpen(false));

  const conv = useConversations(inviteCode, inviteCodeRef, handleLogout);
  const {
    conversations, activeConvId, setActiveConvId, convIdRef, pendingSubmitRef,
    chatKey, setChatKey, hasSummary, setHasSummary, messages, setMessages,
    input, setInput, isLoading, handleInputChange, loadConversations,
    createConversation, deleteConversation, switchConversation, startNewChat,
    deleteSelectedConversations, deleteAllConversations,
    selectedConvIds, setSelectedConvIds, convBulkMode, setConvBulkMode,
    renamingId, setRenamingId, renameValue, setRenameValue, startRename,
    submitRenameConversation, reloadMessagesFromServer, CONV_LIMIT,
  } = conv;

  const {
    sources, allSourcesForMatching, selectedSourceIds, setSelectedSourceIds,
    bulkSelectMode, setBulkSelectMode, deleteSelectedSources,
  } = useSources(inviteCodeRef);

  const fileAttach = useFileAttachments(inviteCodeRef);
  const {
    chatFiles, setChatFiles, chatPhotos, setChatPhotos, sessionDocsRef,
    chatFileInputRef, handleChatFileSelect, handlePhotoCapture,
    removeChatFile, removeChatPhoto, docFormatModal, setDocFormatModal,
    MAX_CHAT_PHOTOS, ACCEPTED_CHAT_TYPES,
  } = fileAttach;

  const { handleExportDocx, handleExportExcel } = useExport();

  const support = useSupport(inviteCode, inviteCodeRef);
  const {
    showSupportModal, setShowSupportModal, supportModalTab, setSupportModalTab,
    supportMessage, setSupportMessage, supportSending, supportFiles, setSupportFiles,
    supportHistory, unreadSupportCount, sendSupportMessage, openSupportModal,
  } = support;

  /* ── Local UI state ── */
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [viewingSource, setViewingSource] = useState<Source | null>(null);
  const [activeView, setActiveView] = useState<"chat" | "knowledge-base">("chat");
  const [kbCategoryFilter, setKbCategoryFilter] = useState<string>("all");
  const [kbPage, setKbPage] = useState(1);
  const KB_PAGE_SIZE = 20;
  const [sidebarTab, setSidebarTab] = useState<"chats" | "infographics">("chats");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const streaming = useStreaming({
    inviteCodeRef, convIdRef, pendingSubmitRef, sessionDocsRef,
    input, setInput, isLoading, messages, setMessages,
    chatFiles, setChatFiles, chatPhotos, setChatPhotos,
    conversations, createConversation, loadConversations,
    reloadMessagesFromServer, handleLogout, CONV_LIMIT,
  });
  const { handleSubmit, isSending, chatError, setChatError } = streaming;

  const infographicHook = useInfographics(inviteCode, inviteCodeRef, convIdRef, setChatError);
  const {
    infographics, loadInfographics, viewInfographic, viewingInfographic,
    setViewingInfographic, deleteInfographic, deleteSelectedInfographics,
    selectedInfographicIds, setSelectedInfographicIds, infoBulkMode,
    setInfoBulkMode, navigateToInfographic, INFO_LIMIT,
  } = infographicHook;

  /* ── Infographic rename (shares renamingId with conversations) ── */

  const origSwitchConversation = switchConversation;
  const handleSwitchConversation = useCallback((convId: string) => {
    origSwitchConversation(convId);
    setRightOpen(false);
    sessionDocsRef.current = [];
  }, [origSwitchConversation, sessionDocsRef]);

  /* ── Infographic rename (uses shared renamingId from conversations) ── */

  const submitRenameInfographic = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    const trimmed = renameValue.trim();
    await fetch(apiUrl("/api/infographics"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": encodeURIComponent(inviteCodeRef.current),
      },
      body: JSON.stringify({ id: renamingId, topic: trimmed }),
    });
    // Update local state via the infographics array reference
    infographicHook.infographics.splice(0); // force re-render workaround
    loadInfographics();
    setRenamingId(null);
  }, [renamingId, renameValue, inviteCodeRef, loadInfographics, setRenamingId, infographicHook.infographics]);

  /* ── Helper: reset to new chat ── */
  const handleNewChat = useCallback(() => {
    setActiveView("chat");
    startNewChat();
    sessionDocsRef.current = [];
  }, [startNewChat, sessionDocsRef]);

  /* ── Auto-scroll ── */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ── Key handler ── */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // REMOVED: everything from here to Derived was extracted into hooks
  // The following 750+ lines of logic are now in:
  // - useConversations (conversations CRUD, messages, sync, heartbeat)
  // - useStreaming (handleSubmit, streaming)
  // - useFileAttachments (file/photo handling)
  // - useSources (KB sources)
  // - useSupport (support modal)
  // - useInfographics (infographic CRUD)
  // - useExport (DOCX/Excel export)


  /* ── Derived ── */
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]?.role === "user";

  /* ── Render ── */

  // Show loading spinner
  if (authLoading) {
    return <div className="invite-gate"><div className="admin-spinner" /></div>;
  }

  // Show invite gate if not authenticated
  if (!isAuthenticated) {
    return <InviteGate onSuccess={handleAuthSuccess} />;
  }

  return (
    <>
      <div className="app-layout">
        {/* ── Header ── */}
        <header className="app-header">
          <div className="header-brand">
            {/* Mobile: hamburger menu with nav buttons */}
            <div className="mobile-hamburger-wrapper" ref={mobileMenuRef}>
              <button
                className="menu-btn"
                onClick={() => setMobileMenuOpen((o) => !o)}
                title="Меню"
              >
                <MenuIcon />
                {unreadSupportCount > 0 && (
                  <span className="mobile-hamburger-badge">{unreadSupportCount}</span>
                )}
              </button>
              {mobileMenuOpen && (
                <div className="mobile-hamburger-dropdown">
                  <a
                    className="mobile-hamburger-item"
                    href="https://academy.snabchat.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    Обучение
                  </a>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); openSupportModal(); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                    </svg>
                    Поддержка
                    {unreadSupportCount > 0 && (
                      <span className="mobile-hamburger-item-badge">{unreadSupportCount}</span>
                    )}
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); navigateToInfographic(); }}
                  >
                    <InfographicIcon />
                    Инфографика
                  </button>
                  <button
                    className={`mobile-hamburger-item${activeView === "knowledge-base" ? " active" : ""}`}
                    onClick={() => { setMobileMenuOpen(false); setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base"); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                    База знаний
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); setRightOpen((o) => !o); }}
                  >
                    <HistoryIcon />
                    История диалогов
                  </button>
                  {isAdmin && (
                    <a
                      className="mobile-hamburger-item"
                      href="/admin"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      Админ-панель
                    </a>
                  )}
                </div>
              )}
            </div>
            <button
              className="header-logo-btn"
              onClick={handleNewChat}
              title="На главную"
            >
              <SpektrIcon size={36} />
              <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
                <span style={{ color: '#003A7A' }}>Снаб</span><span style={{ color: '#0099CC' }}>Чат</span>
              </span>
            </button>
            <div className="header-divider desktop-only" />
            <span className="header-username desktop-only">
              {userName}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {hasSummary && <span className="memory-pill">Память активна</span>}
            {/* Desktop: nav buttons inline */}
            <a
              className="header-labeled-btn accent desktop-only"
              href="https://academy.snabchat.app/"
              target="_blank"
              rel="noopener noreferrer"
              title="Обучение"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <span className="btn-label">Обучение</span>
            </a>
            <button
              className="header-labeled-btn accent desktop-only"
              onClick={() => openSupportModal()}
              title="Поддержка"
              style={{ position: "relative" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
              </svg>
              <span className="btn-label">Поддержка</span>
              {unreadSupportCount > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -4,
                  background: "#e53935", color: "#fff", borderRadius: "50%",
                  width: 18, height: 18, fontSize: 11, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{unreadSupportCount}</span>
              )}
            </button>
            <button
              className="header-labeled-btn accent desktop-only"
              onClick={() => navigateToInfographic()}
              title="Генератор инфографики"
            >
              <InfographicIcon />
              <span className="btn-label">Инфографика</span>
            </button>
            <button
              className={`header-labeled-btn accent desktop-only${activeView === "knowledge-base" ? " active" : ""}`}
              onClick={() => setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base")}
              title="База знаний"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="btn-label">База знаний</span>
            </button>
            {isAdmin && (
              <a
                className="header-labeled-btn accent desktop-only"
                href="/admin"
                title="Админ-панель"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span className="btn-label">Админ-панель</span>
              </a>
            )}
            <button
              className="header-labeled-btn primary desktop-only"
              onClick={handleNewChat}
              title="Новый чат"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              <span className="btn-label">Новый чат</span>
            </button>
            <button
              className="menu-btn"
              onClick={handleNewChat}
              title="Новый чат"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            {/* User avatar with dropdown menu (desktop + mobile) */}
            <div className="user-menu-wrapper" ref={userMenuRef}>
              <button
                className="user-menu-btn"
                onClick={() => setUserMenuOpen((o) => !o)}
                title={userName}
                style={{ background: avatarColor }}
              >
                {userInitials}
              </button>
              {userMenuOpen && (
                <div className="user-menu-dropdown">
                  <div className="user-menu-header">
                    <div className="user-menu-header-info">
                      <div className="user-menu-name">{userName}</div>
                      <div className="user-menu-role">
                        {isAdmin ? "Администратор" : "Пользователь"}
                      </div>
                    </div>
                    <div className="user-menu-header-avatar" style={{ background: avatarColor }}>
                      {userInitials}
                    </div>
                  </div>
                  <div className="user-menu-divider" />

                  {/* Цвет аватара */}
                  <div className="user-menu-color-section">
                    <span className="user-menu-color-label">Цвет аватара</span>
                    <div className="user-menu-color-swatches">
                      {AVATAR_COLORS.map(color => (
                        <button
                          key={color}
                          className="user-menu-color-swatch"
                          style={{
                            background: color,
                            outline: avatarColor === color ? `2px solid ${color}` : "none",
                            outlineOffset: 2,
                            boxShadow: avatarColor === color ? "0 0 0 1px #fff inset" : "none",
                          }}
                          onClick={() => setAvatarColor(color)}
                          title={color}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="user-menu-divider" />

                  {/* Пароль */}
                  <a className="user-menu-item" href="/settings">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Сменить пароль
                  </a>

                  {/* 2FA */}
                  {!isAdmin && (
                    <a className="user-menu-item" href="/settings">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="M9 12l2 2 4-4" />
                      </svg>
                      Двухфакторная аутентификация
                    </a>
                  )}

                  {isAdmin && (
                    <a className="user-menu-item" href="/admin">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      Админ-панель
                    </a>
                  )}

                  {/* Выйти */}
                  <button className="user-menu-item user-menu-item--danger" onClick={handleLogout}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Выйти
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ── Body ── */}
        <div className="app-body">
          {/* Sidebar overlay (mobile) */}
          {rightOpen && (
            <div className="sidebar-overlay" onClick={() => setRightOpen(false)} />
          )}

          {/* ── Main ── */}
          {activeView === "knowledge-base" ? (
            <main className="main-area">
              <div className="kb-view">
                <div className="kb-header">
                  <h2 className="kb-title">База знаний</h2>
                  <span className="kb-badge">{sources.length}</span>
                  {isDocAdmin && sources.length > 0 && (
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {!bulkSelectMode ? (
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 12, padding: "5px 12px" }}
                          onClick={() => setBulkSelectMode(true)}
                        >
                          Выбрать
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => {
                              const filtered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "other") === kbCategoryFilter);
                              if (selectedSourceIds.size === filtered.length && filtered.every((s) => selectedSourceIds.has(s.id))) {
                                setSelectedSourceIds(new Set());
                              } else {
                                setSelectedSourceIds(new Set(filtered.map((s) => s.id)));
                              }
                            }}
                          >
                            {(() => {
                              const filtered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "other") === kbCategoryFilter);
                              return selectedSourceIds.size === filtered.length && filtered.every((s) => selectedSourceIds.has(s.id)) ? "Снять всё" : "Выбрать все";
                            })()}
                          </button>
                          <button
                            className="btn-secondary"
                            style={{
                              fontSize: 12,
                              padding: "5px 12px",
                              color: selectedSourceIds.size > 0 ? "var(--error)" : undefined,
                            }}
                            disabled={selectedSourceIds.size === 0}
                            onClick={deleteSelectedSources}
                          >
                            Удалить ({selectedSourceIds.size})
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => { setSelectedSourceIds(new Set()); setBulkSelectMode(false); }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="kb-pills">
                  <button
                    className={`kb-pill ${kbCategoryFilter === "all" ? "active" : ""}`}
                    onClick={() => { setKbCategoryFilter("all"); setKbPage(1); }}
                  >
                    Все ({sources.length})
                  </button>
                  {[
                    { key: "npa", label: "НПА" },
                    { key: "standards", label: "Стандарты и Положения" },
                    { key: "forms", label: "Формы и Шаблоны" },
                    { key: "schemas", label: "Схемы процессов" },
                    { key: "instructions", label: "Инструкции и Методики" },
                    { key: "pricing", label: "Ценообразование" },
                    { key: "references", label: "Справочники и Реестры" },
                    { key: "contractor-cards", label: "Карточки контрагентов" },
                    { key: "contracts", label: "Договоры" },
                  ].map((cat) => {
                    const count = sources.filter((s) => (s.folder_path || "standards") === cat.key).length;
                    return (
                      <button
                        key={cat.key}
                        className={`kb-pill ${kbCategoryFilter === cat.key ? "active" : ""}`}
                        onClick={() => { setKbCategoryFilter(cat.key); setKbPage(1); }}
                      >
                        {cat.label} ({count})
                      </button>
                    );
                  })}
                </div>

                {sources.length === 0 ? (
                  <div className="kb-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 12 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <p>Нет загруженных документов</p>
                  </div>
                ) : (<>
                <KBSearchBar
                  inviteCode={inviteCode}
                  folder={kbCategoryFilter === "all" ? undefined : kbCategoryFilter}
                  mode="chat"
                  onOpenDocument={(sourceId, filename) => {
                    const src = sources.find(s => String(s.id) === String(sourceId));
                    if (src) setViewingSource(src);
                  }}
                  onDownload={(sourceId, filename) => {
                    const isMd = filename?.endsWith(".md");
                    const endpoint = isMd ? "/api/sources/download-docx" : "/api/sources/download";
                    window.open(apiUrl(endpoint + "?id=" + sourceId + "&action=download&token=" + encodeURIComponent(inviteCodeRef.current)), "_blank");
                  }}
                />
                  {(() => {
                    const kbFiltered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "standards") === kbCategoryFilter);
                    const kbTotalPages = Math.max(1, Math.ceil(kbFiltered.length / KB_PAGE_SIZE));
                    const kbSafePage = Math.min(kbPage, kbTotalPages);
                    const kbPaginated = kbFiltered.slice((kbSafePage - 1) * KB_PAGE_SIZE, kbSafePage * KB_PAGE_SIZE);
                    return (<>
                  <div className="kb-list">
                    {kbPaginated.map((doc) => {
                        const ext = doc.mime_type?.includes("x-denormalized") || doc.filename.endsWith(".md") ? "md"
                          : doc.mime_type?.includes("pdf") ? "pdf"
                          : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx"
                          : doc.mime_type?.includes("presentationml") || doc.filename.endsWith(".pptx") ? "pptx"
                          : doc.mime_type?.includes("html") || doc.filename.endsWith(".html") ? "html"
                          : "docx";
                        const catLabel = [
                          { key: "npa", label: "НПА" },
                          { key: "standards", label: "Стандарты и Положения" },
                          { key: "forms", label: "Формы и Шаблоны" },
                          { key: "schemas", label: "Схемы процессов" },
                          { key: "instructions", label: "Инструкции и Методики" },
                          { key: "pricing", label: "Ценообразование" },
                          { key: "references", label: "Справочники и Реестры" },
                          { key: "contractor-cards", label: "Карточки контрагентов" },
                          { key: "contracts", label: "Договоры" },
                        ].find((c) => c.key === (doc.folder_path || "standards"))?.label || "Стандарты и Положения";
                        return (
                          <div
                            key={doc.id}
                            className="kb-row"
                            style={bulkSelectMode ? { cursor: "pointer" } : undefined}
                            onClick={() => {
                              if (bulkSelectMode) {
                                setSelectedSourceIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(doc.id)) next.delete(doc.id);
                                  else next.add(doc.id);
                                  return next;
                                });
                              }
                            }}
                          >
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
                                style={{ flexShrink: 0 }}
                              />
                            )}
                            <div className={`kb-row-icon ${ext}`}>
                              {ext === "pdf" ? "PDF" : ext === "xlsx" ? "XLS" : ext === "pptx" ? "PPT" : ext === "html" ? "HTML" : ext === "md" ? "MD" : "DOC"}
                            </div>
                            <div className="kb-row-info">
                              <div className="kb-row-name">{doc.filename}</div>
                              <div className="kb-row-meta">
                                <span className="kb-row-cat">{catLabel}</span>
                                <span>&middot;</span>
                                <span>{new Date(doc.created_at).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" })}</span>
                                {doc.tags && doc.tags.length > 0 && (
                                  <>
                                    <span>&middot;</span>
                                    <span>{doc.tags.length} тегов</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="kb-row-actions">
                              <button
                                className="kb-action-btn"
                                onClick={() => setViewingSource(doc)}
                                title="Просмотр"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              </button>
                              <a
                                className="kb-action-btn"
                                href={apiUrl(`/api/sources/${ext === "md" ? "download-docx" : "download"}?id=${doc.id}&action=download&token=${encodeURIComponent(inviteCodeRef.current)}`)}
                                title="Скачать"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                              </a>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  {kbTotalPages > 1 && (
                    <div className="kb-pagination">
                      <button className="kb-pagination-btn" disabled={kbSafePage <= 1} onClick={() => setKbPage(kbSafePage - 1)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                      </button>
                      {Array.from({ length: kbTotalPages }, (_, i) => i + 1)
                        .filter((p) => p === 1 || p === kbTotalPages || Math.abs(p - kbSafePage) <= 2)
                        .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                          if (idx > 0 && p - arr[idx - 1] > 1) acc.push("...");
                          acc.push(p);
                          return acc;
                        }, [])
                        .map((p, i) =>
                          p === "..." ? (
                            <span key={`dots-${i}`} className="kb-pagination-dots">&hellip;</span>
                          ) : (
                            <button key={p} className={`kb-pagination-btn${p === kbSafePage ? " active" : ""}`} onClick={() => setKbPage(p as number)}>{p}</button>
                          )
                        )}
                      <button className="kb-pagination-btn" disabled={kbSafePage >= kbTotalPages} onClick={() => setKbPage(kbSafePage + 1)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                      </button>
                      <span className="kb-pagination-info">{(kbSafePage - 1) * KB_PAGE_SIZE + 1}–{Math.min(kbSafePage * KB_PAGE_SIZE, kbFiltered.length)} из {kbFiltered.length}</span>
                    </div>
                  )}
                  </>);
                  })()}
                </>
                )}
              </div>
            </main>
          ) : (
          <main className="main-area">
            <div className="chat-column">
              <div className="messages-area" ref={scrollRef}>
                {hasSummary && (
                  <div className="summary-notice">ℹ Ранние сообщения сжаты в резюме</div>
                )}
                {messages.length === 0 && !hasSummary && <EmptyState onChipClick={(text) => handleSubmit(undefined, text)} />}
                {messages.map((m, idx) => {
                  const prevUserMsg = m.role === "assistant"
                    ? [...messages].slice(0, idx).reverse().find((pm) => pm.role === "user")
                    : undefined;
                  return (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      allSources={allSourcesForMatching}
                      onViewSource={setViewingSource}
                      onCreateInfographic={m.role === "assistant" ? navigateToInfographic : undefined}
                      onExportDocx={m.role === "assistant" ? (content: string) => handleExportDocx(content, prevUserMsg?.content || "Запрос") : undefined}
                      onExportExcel={m.role === "assistant" && containsMarkdownTable(m.content) ? (content: string) => handleExportExcel(content, prevUserMsg?.content || "Запрос") : undefined}
                      onFollowUpClick={m.role === "assistant" ? (text: string) => handleSubmit(undefined, text) : undefined}
                    />
                  );
                })}
                {isSending && <TypingBubble />}
                {chatError && (
                  <div className="message message-error" style={{ background: "var(--error-bg, #fef2f2)", border: "1px solid var(--error-border, #fecaca)", borderRadius: 12, padding: "12px 18px", margin: "8px 0", color: "var(--error-text, #991b1b)", fontSize: 14 }}>
                    {chatError}
                    <button onClick={() => setChatError(null)} style={{ marginLeft: 12, background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: 600 }}>×</button>
                  </div>
                )}
              </div>

              <form className="input-area" onSubmit={handleSubmit}>
                {/* Photo previews */}
                {chatPhotos.length > 0 && (
                  <div className="photo-preview-bar">
                    <div className="photo-preview-header">
                      <span className="photo-preview-count">Фото: {chatPhotos.length}/{MAX_CHAT_PHOTOS}</span>
                      {chatPhotos.some((p) => p.parsing) && <span className="photo-preview-processing">Распознавание...</span>}
                    </div>
                    <div className="photo-preview-grid">
                      {chatPhotos.map((p) => (
                        <div key={p.id} className="photo-preview-item">
                          <img src={p.preview} alt="Фото" className="photo-preview-img" />
                          {p.parsing && (
                            <div className="photo-preview-overlay">
                              <div className="chip-spinner" />
                            </div>
                          )}
                          {!p.parsing && !p.error && p.markdown && (
                            <div className="photo-preview-badge photo-preview-success">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </div>
                          )}
                          {p.error && (
                            <div className="photo-preview-badge photo-preview-error">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </div>
                          )}
                          <button type="button" className="photo-preview-remove" onClick={() => removeChatPhoto(p.id)} title="Удалить">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Chat file chips */}
                {chatFiles.length > 0 && (
                  <div className="chat-files-bar">
                    {chatFiles.map((f) => (
                      <div key={f.id} className={`chat-file-chip ${f.parsing ? "parsing" : ""} ${f.error ? "error" : ""}`}>
                        {f.parsing ? (
                          <div className="chip-spinner" />
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        )}
                        <span className="chip-name" title={f.filename}>{f.filename}</span>
                        <span className="chip-size">{(f.file.size / 1024 / 1024).toFixed(1)} МБ</span>
                        <button type="button" className="chip-remove" onClick={() => removeChatFile(f.id)} title="Удалить">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="input-wrapper">
                  {/* Attach file button */}
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept={ACCEPTED_CHAT_TYPES}
                    multiple
                    onChange={(e) => {
                      if (e.target.files) handleChatFileSelect(e.target.files);
                      e.target.value = "";
                    }}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    className="attach-btn"
                    onClick={() => chatFileInputRef.current?.click()}
                    disabled={isSending}
                    title="Прикрепить файл или фото"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  {/* Camera button (mobile only) */}
                  <CameraButton
                    onCapture={handlePhotoCapture}
                    disabled={isSending}
                    maxPhotos={MAX_CHAT_PHOTOS}
                    currentPhotoCount={chatPhotos.length}
                  />
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    placeholder={chatFiles.length > 0 || chatPhotos.length > 0 ? "Опишите что проверить или нажмите отправить..." : "Задайте вопрос..."}
                    rows={1}
                    className="chat-input"
                    style={{ maxHeight: 160 }}
                    onInput={(e) => {
                      const t = e.currentTarget;
                      t.style.height = "auto";
                      t.style.height = Math.min(t.scrollHeight, 160) + "px";
                    }}
                  />
                  {/* Voice input button */}
                  <VoiceButton
                    onTranscript={(text) => setInput((prev) => (prev ? prev + " " + text : text))}
                    disabled={isSending}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || isSending || (!input.trim() && chatFiles.filter((f) => !f.parsing && !f.error && f.markdown).length === 0 && chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown).length === 0)}
                    className="send-btn"
                  >
                    <ArrowUpIcon />
                  </button>
                </div>
              </form>
            </div>
          </main>
          )}

          {/* ── Right sidebar: Dialogs ── */}
          <aside className={`sidebar-panel right ${rightOpen ? "open" : ""} ${rightCollapsed ? "collapsed" : ""}`}>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setRightCollapsed((c) => !c)}
            >
              {rightCollapsed ? "Диалоги" : "Свернуть"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={rightCollapsed ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
              </svg>
            </button>
            <div className="sidebar-content">
              {/* Tab toggle: Чаты | Инфографика */}
              <div className="sidebar-tab-toggle">
                <button
                  className={`sidebar-tab-btn ${sidebarTab === "chats" ? "active" : ""}`}
                  onClick={() => setSidebarTab("chats")}
                >
                  Чаты
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === "infographics" ? "active" : ""}`}
                  onClick={() => { setSidebarTab("infographics"); loadInfographics(); }}
                >
                  Инфографика
                  {infographics.length > 0 && (
                    <span className="sidebar-tab-badge">{infographics.length}</span>
                  )}
                </button>
              </div>

              {sidebarTab === "chats" ? (
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ДИАЛОГИ</span>
                  <button
                    onClick={() => {
                      if (conversations.length >= CONV_LIMIT) return;
                      handleNewChat();
                    }}
                    title={conversations.length >= CONV_LIMIT ? "Лимит диалогов достигнут" : "Новый диалог"}
                    style={{ fontSize: 16, color: conversations.length >= CONV_LIMIT ? "var(--error)" : "var(--text-secondary)", lineHeight: 1 }}
                    disabled={conversations.length >= CONV_LIMIT}
                  >
                    +
                  </button>
                </div>
                {/* Limit indicator */}
                <div style={{ padding: "0 12px 6px", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, (conversations.length / CONV_LIMIT) * 100)}%`, background: conversations.length >= CONV_LIMIT ? "var(--error)" : conversations.length >= CONV_LIMIT * 0.8 ? "var(--warning)" : "var(--accent)", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: conversations.length >= CONV_LIMIT ? "var(--error)" : "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {conversations.length}/{CONV_LIMIT}
                  </span>
                </div>
                {conversations.length >= CONV_LIMIT && (
                  <div style={{ margin: "0 12px 8px", padding: "6px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 8, fontSize: 11, color: "var(--error)", fontWeight: 500 }}>
                    Лимит достигнут. Удалите старые диалоги.
                  </div>
                )}
                {conversations.length > 0 && (
                  <div style={{ display: "flex", gap: 4, padding: "0 12px 8px" }}>
                    {!convBulkMode ? (
                      <button
                        className="btn-secondary"
                        style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                        onClick={() => setConvBulkMode(true)}
                      >
                        Выбрать
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                          onClick={() => {
                            if (selectedConvIds.size === conversations.length) {
                              setSelectedConvIds(new Set());
                            } else {
                              setSelectedConvIds(new Set(conversations.map((c) => c.id)));
                            }
                          }}
                        >
                          {selectedConvIds.size === conversations.length ? "Снять всё" : "Выбрать все"}
                        </button>
                        <button
                          className="btn-secondary"
                          style={{
                            flex: 1,
                            fontSize: 11,
                            padding: "4px 8px",
                            color: selectedConvIds.size > 0 ? "var(--error)" : undefined,
                          }}
                          disabled={selectedConvIds.size === 0}
                          onClick={selectedConvIds.size === conversations.length ? deleteAllConversations : deleteSelectedConversations}
                        >
                          Удалить ({selectedConvIds.size})
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => { setSelectedConvIds(new Set()); setConvBulkMode(false); }}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="sidebar-list">
                  {conversations.map((c) => (
                    <div
                      className={`sidebar-item ${c.id === activeConvId ? "active" : ""}`}
                      onClick={() => {
                        if (convBulkMode) {
                          setSelectedConvIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                          return;
                        }
                        handleSwitchConversation(c.id);
                      }}
                      key={c.id}
                    >
                      {convBulkMode && (
                        <input
                          type="checkbox"
                          checked={selectedConvIds.has(c.id)}
                          onChange={() => {
                            setSelectedConvIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) next.delete(c.id);
                              else next.add(c.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renamingId === c.id ? (
                          <input
                            className="sidebar-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={submitRenameConversation}
                            onKeyDown={(e) => { if (e.key === "Enter") submitRenameConversation(); if (e.key === "Escape") setRenamingId(null); }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          onDoubleClick={(e) => startRename(c.id, c.title, e)}
                        >
                          {c.title}
                        </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {formatDate(c.updated_at)}
                        </div>
                      </div>
                      {!convBulkMode && renamingId !== c.id && (
                        <div className="sidebar-item-actions">
                          <button
                            className="doc-delete-btn"
                            onClick={(e) => startRename(c.id, c.title, e)}
                            title="Переименовать"
                            style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            className="doc-delete-btn"
                            onClick={(e) => deleteConversation(c.id, e)}
                            title="Удалить диалог"
                            style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              ) : (
              /* ── Infographics tab ── */
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ИНФОГРАФИКА</span>
                  <button
                    onClick={() => navigateToInfographic()}
                    title="Создать инфографику"
                    style={{ fontSize: 16, color: infographics.length >= INFO_LIMIT ? "var(--error)" : "var(--text-secondary)", lineHeight: 1 }}
                    disabled={infographics.length >= INFO_LIMIT}
                  >
                    +
                  </button>
                </div>
                {/* Limit indicator */}
                <div style={{ padding: "0 12px 6px", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, (infographics.length / INFO_LIMIT) * 100)}%`, background: infographics.length >= INFO_LIMIT ? "var(--error)" : infographics.length >= INFO_LIMIT * 0.8 ? "var(--warning)" : "var(--accent)", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: infographics.length >= INFO_LIMIT ? "var(--error)" : "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {infographics.length}/{INFO_LIMIT}
                  </span>
                </div>
                {infographics.length >= INFO_LIMIT && (
                  <div style={{ margin: "0 12px 8px", padding: "6px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 8, fontSize: 11, color: "var(--error)", fontWeight: 500 }}>
                    Лимит достигнут. Удалите старые инфографики.
                  </div>
                )}
                {infographics.length > 0 && (
                  <div style={{ display: "flex", gap: 4, padding: "0 12px 8px" }}>
                    {!infoBulkMode ? (
                      <button
                        className="btn-secondary"
                        style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                        onClick={() => setInfoBulkMode(true)}
                      >
                        Выбрать
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                          onClick={() => {
                            if (selectedInfographicIds.size === infographics.length) {
                              setSelectedInfographicIds(new Set());
                            } else {
                              setSelectedInfographicIds(new Set(infographics.map((i) => i.id)));
                            }
                          }}
                        >
                          {selectedInfographicIds.size === infographics.length ? "Снять всё" : "Выбрать все"}
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px", color: selectedInfographicIds.size > 0 ? "var(--error)" : undefined }}
                          disabled={selectedInfographicIds.size === 0}
                          onClick={deleteSelectedInfographics}
                        >
                          Удалить ({selectedInfographicIds.size})
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => { setSelectedInfographicIds(new Set()); setInfoBulkMode(false); }}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                )}
                {infographics.length === 0 ? (
                  <div style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    Нет сохранённых инфографик
                  </div>
                ) : (
                <div className="sidebar-list">
                  {infographics.map((ig) => (
                    <div
                      className="sidebar-item infographic-card-item"
                      onClick={() => {
                        if (infoBulkMode) {
                          setSelectedInfographicIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(ig.id)) next.delete(ig.id); else next.add(ig.id);
                            return next;
                          });
                          return;
                        }
                        viewInfographic(ig.id);
                      }}
                      key={ig.id}
                    >
                      {infoBulkMode && (
                        <input
                          type="checkbox"
                          checked={selectedInfographicIds.has(ig.id)}
                          onChange={() => {
                            setSelectedInfographicIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(ig.id)) next.delete(ig.id); else next.add(ig.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      {!infoBulkMode && (
                        <div className="infographic-card-icon">
                          <InfographicIcon size={16} />
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renamingId === ig.id ? (
                          <input
                            className="sidebar-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={submitRenameInfographic}
                            onKeyDown={(e) => { if (e.key === "Enter") submitRenameInfographic(); if (e.key === "Escape") setRenamingId(null); }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          onDoubleClick={(e) => startRename(ig.id, ig.topic || "", e)}
                        >
                          {ig.topic || "Без темы"}
                        </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {formatDate(ig.created_at)}
                        </div>
                      </div>
                      {!infoBulkMode && renamingId !== ig.id && (
                      <div className="sidebar-item-actions">
                        <button
                          className="doc-delete-btn"
                          onClick={(e) => startRename(ig.id, ig.topic || "", e)}
                          title="Переименовать"
                          style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          className="doc-delete-btn"
                          onClick={(e) => deleteInfographic(ig.id, e)}
                          title="Удалить инфографику"
                          style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                      )}
                    </div>
                  ))}
                </div>
                )}
              </div>
              )}
            </div>

          </aside>
        </div>

        {/* ── Footer ── */}
        <footer className="app-footer">
          <span className="footer-text">
            <span className="footer-full">СнабЧат · Дирекция по закупкам · 2026 · </span>
            Разработка @Кирилл Трубицын
          </span>
        </footer>
      </div>

      {viewingSource && (
        <ChatDocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
          inviteCode={inviteCodeRef.current}
        />
      )}

      {/* ── Infographic Viewer Modal ── */}
      {viewingInfographic && (
        <div className="modal-overlay" style={{ zIndex: 9998 }} onClick={() => setViewingInfographic(null)}>
          <div className="infographic-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="infographic-viewer-close"
              onClick={() => setViewingInfographic(null)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="infographic-viewer-header">
              <InfographicIcon size={18} />
              <span>{viewingInfographic.topic || "Инфографика"}</span>
              <span className="infographic-viewer-date">{formatDate(viewingInfographic.created_at)}</span>
            </div>
            <img
              src={viewingInfographic.image_base64}
              alt={viewingInfographic.topic || "Инфографика"}
              className="infographic-viewer-image"
            />
            {viewingInfographic.description && (
              <p className="infographic-viewer-desc">{viewingInfographic.description}</p>
            )}
            <div className="infographic-viewer-actions">
              <button
                className="infographic-btn primary"
                onClick={() => {
                  const link = document.createElement("a");
                  link.href = viewingInfographic.image_base64;
                  link.download = `infographic-${Date.now()}.png`;
                  link.click();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Скачать PNG
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Support Modal ── */}
      {/* .doc / .xls format warning modal */}
      {docFormatModal.show && (
        <div className="modal-overlay" style={{ zIndex: 9999 }} onClick={() => setDocFormatModal({ show: false, fileName: "", type: "doc" })}>
          <div className="modal-card doc-format-modal" onClick={(e) => e.stopPropagation()}>
            <div className="doc-format-modal-icon">⚠️</div>
            <h3 className="doc-format-modal-title">Устаревший формат файла</h3>
            <p className="doc-format-modal-filename">{docFormatModal.fileName}</p>
            {docFormatModal.type === "xls" ? (
              <>
                <p className="doc-format-modal-text">
                  Этот файл сохранён в формате <strong>.xls</strong> (Excel 97–2003), который не поддерживается чатом.
                  Пересохраните его в современном формате <strong>.xlsx</strong>:
                </p>
                <ol className="doc-format-modal-steps">
                  <li>Откройте файл в Microsoft Excel</li>
                  <li>Нажмите <strong>Файл → Сохранить как</strong></li>
                  <li>В поле «Тип файла» выберите <strong>Книга Excel (.xlsx)</strong></li>
                  <li>Нажмите <strong>Сохранить</strong> и загрузите новый файл в чат</li>
                </ol>
              </>
            ) : (
              <>
                <p className="doc-format-modal-text">
                  Этот файл сохранён в формате <strong>.doc</strong> (Word 97–2003), который не поддерживается чатом.
                  Пересохраните его в современном формате <strong>.docx</strong>:
                </p>
                <ol className="doc-format-modal-steps">
                  <li>Откройте файл в Microsoft Word</li>
                  <li>Нажмите <strong>Файл → Сохранить как</strong></li>
                  <li>В поле «Тип файла» выберите <strong>Документ Word (.docx)</strong></li>
                  <li>Нажмите <strong>Сохранить</strong> и загрузите новый файл в чат</li>
                </ol>
              </>
            )}
            <button
              className="doc-format-modal-btn"
              onClick={() => setDocFormatModal({ show: false, fileName: "", type: "doc" })}
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {showSupportModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.5)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 16,
          }}
          onClick={() => setShowSupportModal(false)}
        >
          <div
            style={{
              background: "var(--bg-primary, #fff)", borderRadius: 16,
              width: "100%", maxWidth: 600,
              height: supportModalTab === "help" ? "88vh" : "auto",
              maxHeight: "88vh",
              display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: "14px 16px 0", borderBottom: "1px solid var(--border, #eee)",
              display: "flex", flexDirection: "column", gap: 0, flexShrink: 0,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 17 }}>Помощь</span>
                <button onClick={() => setShowSupportModal(false)} style={{
                  background: "none", border: "none", fontSize: 22, cursor: "pointer",
                  color: "var(--text-muted)", padding: 4, lineHeight: 1,
                }}>&times;</button>
              </div>
              {/* Tabs */}
              <div style={{ display: "flex", gap: 0 }}>
                {([
                  { key: "help", label: "Инструкция", icon: (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  )},
                  { key: "support", label: "Написать в поддержку", icon: (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  )},
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setSupportModalTab(tab.key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px", fontSize: 13, fontWeight: supportModalTab === tab.key ? 700 : 500,
                      background: "none", border: "none", cursor: "pointer",
                      borderBottom: supportModalTab === tab.key ? "2px solid var(--accent, #2563EB)" : "2px solid transparent",
                      color: supportModalTab === tab.key ? "var(--accent, #2563EB)" : "var(--text-secondary)",
                      transition: "color 0.15s",
                      position: "relative", top: 1,
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.key === "support" && unreadSupportCount > 0 && (
                      <span style={{
                        background: "#e53935", color: "#fff", borderRadius: "50%",
                        width: 16, height: 16, fontSize: 10, fontWeight: 700,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                      }}>{unreadSupportCount}</span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => window.open("https://disk.yandex.ru/i/B0aYz0_6pakpMw", "_blank")}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 14px", fontSize: 13, fontWeight: 500,
                    background: "none", border: "none", cursor: "pointer",
                    borderBottom: "2px solid transparent",
                    color: "var(--text-secondary)",
                    transition: "color 0.15s",
                    position: "relative", top: 1,
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  Видео-презентация
                </button>
              </div>
            </div>

            {/* Tab content */}
            {supportModalTab === "help" ? (
              <iframe
                src="/help?embedded=1"
                style={{ flex: 1, border: "none", borderRadius: "0 0 16px 16px", minHeight: 0 }}
                title="Инструкция"
              />
            ) : (
              <>
                {/* Presentation link */}
                <div style={{ padding: "10px 16px 0", flexShrink: 0 }}>
                  <a
                    href="https://disk.yandex.ru/i/B0aYz0_6pakpMw"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10,
                      background: "var(--bg-secondary, #F5F5F5)", boxSizing: "border-box",
                      border: "1px solid var(--border, #E2E8F0)", borderRadius: 10, padding: "10px 14px",
                      color: "var(--text-primary, #333)", cursor: "pointer", textDecoration: "none",
                    }}
                  >
                    <span style={{
                      width: 32, height: 32, borderRadius: 10, background: "#EFF6FF",
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      color: "#2563EB",
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                      </svg>
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>Презентация СнабЧата</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted, #94A3B8)" }}>Обзор системы · ~5 мин</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #94A3B8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                  </a>
                </div>

                {/* Messages history */}
                <div style={{
                  flex: 1, overflowY: "auto", padding: 16,
                  display: "flex", flexDirection: "column", gap: 12,
                }}>
                  {supportHistory.length === 0 && (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 24, fontSize: 14 }}>
                      <div style={{ marginBottom: 8 }}>Здесь будут ваши обращения в поддержку</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Обратная связь помогает сделать систему лучше — пишите смело!</div>
                    </div>
                  )}
                  {supportHistory.map((m) => (
                    <div key={m.id}>
                      <div style={{
                        background: "var(--bg-secondary, #f5f5f5)", borderRadius: 12,
                        padding: 12, marginBottom: m.admin_reply ? 8 : 0, fontSize: 14,
                      }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                          {new Date(m.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}
                        </div>
                        {m.message}
                      </div>
                      {m.admin_reply && (
                        <div style={{
                          background: "#e8f4fd", borderRadius: 12, padding: 12,
                          borderLeft: "3px solid #1976d2", fontSize: 14, marginLeft: 24,
                        }}>
                          <div style={{ fontSize: 11, color: "#1976d2", marginBottom: 4 }}>
                            Администратор {m.admin_number ?? ""} · {m.replied_at ? new Date(m.replied_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : ""}
                          </div>
                          {m.admin_reply}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {/* Input */}
                <div style={{ padding: 16, borderTop: "1px solid var(--border, #eee)", flexShrink: 0 }}>
                  <textarea
                    value={supportMessage}
                    onChange={(e) => setSupportMessage(e.target.value)}
                    placeholder="Опишите проблему или идею по улучшению..."
                    rows={3}
                    style={{
                      width: "100%", borderRadius: 10, border: "1px solid var(--border, #ddd)",
                      padding: 12, fontSize: 14, resize: "none", fontFamily: "inherit",
                      background: "var(--bg-primary, #fff)", color: "var(--text-primary, #333)",
                      boxSizing: "border-box",
                    }}
                  />
                  {/* File attachments */}
                  {supportFiles.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 4px" }}>
                      {supportFiles.map((f, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "center", gap: 4,
                          background: "var(--bg-secondary, #f5f5f5)", borderRadius: 8,
                          padding: "3px 8px 3px 6px", fontSize: 12, color: "var(--text-secondary)",
                          border: "1px solid var(--border, #ddd)", maxWidth: 160,
                        }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                          <button
                            onClick={() => setSupportFiles((prev) => prev.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, lineHeight: 1, flexShrink: 0 }}
                          >×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <label style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                      border: "1px solid var(--border, #ddd)", cursor: "pointer",
                      color: "var(--text-secondary)", background: "var(--bg-primary, #fff)",
                      whiteSpace: "nowrap",
                    }} title="Прикрепить файл (скриншот, PDF, DOCX, XLSX)">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                      </svg>
                      Файл
                      <input
                        type="file"
                        multiple
                        accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.docx,.xlsx"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []).slice(0, 5);
                          setSupportFiles((prev) => [...prev, ...files].slice(0, 5));
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      onClick={sendSupportMessage}
                      disabled={supportSending || !supportMessage.trim()}
                      style={{
                        flex: 1, padding: "10px 16px",
                        borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
                        background: supportSending || !supportMessage.trim() ? "#ccc" : "#1976d2",
                        color: "#fff", cursor: supportSending ? "wait" : "pointer",
                      }}
                    >
                      {supportSending ? "Отправка..." : "Отправить"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </>
  );
}
