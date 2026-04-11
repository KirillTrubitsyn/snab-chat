import { useState, useEffect, useCallback, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/app/lib/api";

interface Infographic {
  id: string;
  topic: string;
  style: string;
  aspect_ratio: string;
  description: string;
  created_at: string;
  conversation_id: string | null;
}

interface InfographicDetail {
  id: string;
  topic: string;
  image_base64: string;
  description: string;
  created_at: string;
}

export const INFO_LIMIT = 20;

export function useInfographics(
  inviteCode: string,
  inviteCodeRef: MutableRefObject<string>,
  convIdRef: MutableRefObject<string | null>,
  setChatError: (err: string | null) => void,
) {
  const router = useRouter();
  const [infographics, setInfographics] = useState<Infographic[]>([]);
  const [viewingInfographic, setViewingInfographic] = useState<InfographicDetail | null>(null);
  const [selectedInfographicIds, setSelectedInfographicIds] = useState<Set<string>>(new Set());
  const [infoBulkMode, setInfoBulkMode] = useState(false);

  const loadInfographics = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/infographics"), {
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      const data = await res.json();
      if (data.infographics) setInfographics(data.infographics);
    } catch {
      // ignore
    }
  }, [inviteCode, inviteCodeRef]);

  useEffect(() => {
    loadInfographics();
  }, [loadInfographics]);

  const navigateToInfographic = useCallback(
    (content?: string) => {
      if (infographics.length >= INFO_LIMIT) {
        setChatError(
          `Достигнут лимит инфографик (${INFO_LIMIT}). Удалите старые, чтобы создать новую.`,
        );
        return;
      }
      const ctx: Record<string, string> = {};
      if (content) ctx.documentText = content;
      if (convIdRef.current) ctx.conversationId = convIdRef.current;
      if (Object.keys(ctx).length > 0) {
        sessionStorage.setItem("infographic_context", JSON.stringify(ctx));
      }
      router.push("/infographic");
    },
    [router, infographics.length, setChatError, convIdRef],
  );

  const viewInfographic = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(apiUrl("/api/infographics"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": encodeURIComponent(inviteCodeRef.current),
          },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (data.infographic) setViewingInfographic(data.infographic);
      } catch {
        // ignore
      }
    },
    [inviteCodeRef],
  );

  const deleteInfographic = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      await fetch(apiUrl(`/api/infographics?id=${id}`), {
        method: "DELETE",
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      setInfographics((prev) => prev.filter((i) => i.id !== id));
    },
    [inviteCodeRef],
  );

  const deleteSelectedInfographics = useCallback(async () => {
    if (selectedInfographicIds.size === 0) return;
    const ids = Array.from(selectedInfographicIds);
    await Promise.all(
      ids.map((id) =>
        fetch(apiUrl(`/api/infographics?id=${id}`), {
          method: "DELETE",
          headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        }),
      ),
    );
    setInfographics((prev) => prev.filter((i) => !selectedInfographicIds.has(i.id)));
    setSelectedInfographicIds(new Set());
    setInfoBulkMode(false);
  }, [selectedInfographicIds, inviteCodeRef]);

  return {
    infographics,
    loadInfographics,
    viewInfographic,
    viewingInfographic,
    setViewingInfographic,
    deleteInfographic,
    deleteSelectedInfographics,
    selectedInfographicIds,
    setSelectedInfographicIds,
    infoBulkMode,
    setInfoBulkMode,
    navigateToInfographic,
    INFO_LIMIT,
  };
}
