import { useState, useEffect, useRef, useCallback } from "react";
import { getAvatarColor, setAvatarColor as saveAvatarColor } from "@/app/lib/avatarColors";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inviteCode, setInviteCode] = useState<string>("");
  const inviteCodeRef = useRef<string>("");
  const [userName, setUserName] = useState<string>("");
  const [avatarColor, setAvatarColor] = useState<string>("#0099CC");
  const [authLoading, setAuthLoading] = useState(true);
  const isAdmin =
    typeof window !== "undefined" &&
    localStorage.getItem("snabchat_is_admin") === "true";
  const isDocAdmin =
    typeof window !== "undefined" &&
    localStorage.getItem("snabchat_is_doc_admin") === "true";

  // Keep inviteCodeRef in sync
  useEffect(() => {
    inviteCodeRef.current = inviteCode;
  }, [inviteCode]);

  // Check existing auth on mount
  useEffect(() => {
    const code = localStorage.getItem("snabchat_invite_code");
    const name = localStorage.getItem("snabchat_user_name");
    if (code && name) {
      setInviteCode(code);
      inviteCodeRef.current = code;
      setUserName(name);
      setAvatarColor(getAvatarColor());
      setIsAuthenticated(true);
    }
    setAuthLoading(false);
  }, []);

  const handleAuthSuccess = useCallback(
    (data: { type: string; code: string; userName: string }) => {
      setInviteCode(data.code);
      inviteCodeRef.current = data.code;
      setUserName(data.userName);
      setAvatarColor(getAvatarColor());
      setIsAuthenticated(true);
    },
    [],
  );

  const handleLogout = useCallback(() => {
    localStorage.removeItem("snabchat_invite_code");
    localStorage.removeItem("snabchat_invite_code_id");
    localStorage.removeItem("snabchat_user_name");
    localStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_admin_code");
    localStorage.removeItem("snabchat_is_doc_admin");
    setIsAuthenticated(false);
    setInviteCode("");
    setUserName("");
  }, []);

  const handleSetAvatarColor = useCallback((color: string) => {
    saveAvatarColor(color);
    setAvatarColor(color);
  }, []);

  // Helper: get initials from full name
  const userInitials = userName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");

  return {
    isAuthenticated,
    inviteCode,
    inviteCodeRef,
    userName,
    userInitials,
    avatarColor,
    setAvatarColor: handleSetAvatarColor,
    authLoading,
    isAdmin,
    isDocAdmin,
    handleAuthSuccess,
    handleLogout,
  };
}
