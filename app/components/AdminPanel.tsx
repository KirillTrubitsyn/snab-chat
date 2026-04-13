"use client";

import { useState } from "react";
import {
  CodesTab,
  ActivityTab,
  DocumentsTab,
  NontargetTab,
  SupportTab,
  ErrorsTab,
  SettingsTab,
  OnlineTab,
} from "./admin";

interface AdminPanelProps {
  adminCode: string;
  userName: string;
  isDocAdmin: boolean;
  canDeleteCodes: boolean;
  onLogout: () => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type TabKey = "codes" | "activity" | "online" | "documents" | "nontarget" | "support" | "errors" | "settings";

const navItems: { key: TabKey; label: string; icon: string }[] = [
  { key: "activity", label: "Активность", icon: "monitoring" },
  { key: "online", label: "Онлайн", icon: "group" },
  { key: "codes", label: "Инвайт-коды", icon: "key" },
  { key: "documents", label: "База знаний", icon: "menu_book" },
  { key: "nontarget", label: "Нецелевые запросы", icon: "block" },
  { key: "support", label: "Поддержка", icon: "headset_mic" },
  { key: "errors", label: "Ошибки", icon: "error" },
];

export default function AdminPanel({ adminCode, userName, isDocAdmin, canDeleteCodes, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<TabKey>("activity");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isPrimaryAdmin = typeof window !== "undefined" && sessionStorage.getItem("snabchat_is_primary_admin") === "true";

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
        {(isPrimaryAdmin || canDeleteCodes) && (
          <div className="admin-sidebar-bottom">
            <button
              className={`admin-sidebar-nav-item${tab === "settings" ? " active" : ""}`}
              onClick={() => { setTab("settings"); setSidebarOpen(false); }}
            >
              <span className="material-symbols-outlined">settings</span>
              <span>Настройки</span>
            </button>
          </div>
        )}
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
            {tab === "codes" && <CodesTab adminCode={adminCode} canDeleteCodes={canDeleteCodes} />}
            {tab === "activity" && <ActivityTab adminCode={adminCode} />}
            {tab === "online" && <OnlineTab adminCode={adminCode} />}
            {tab === "documents" && <DocumentsTab adminCode={adminCode} isDocAdmin={isDocAdmin} />}
            {tab === "nontarget" && <NontargetTab adminCode={adminCode} />}
            {tab === "support" && <SupportTab adminCode={adminCode} />}
            {tab === "errors" && <ErrorsTab adminCode={adminCode} />}
            {tab === "settings" && <SettingsTab adminCode={adminCode} />}
          </div>
        </div>
      </div>
    </div>
  );
}
