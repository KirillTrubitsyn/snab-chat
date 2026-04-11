import { useState, useEffect, useCallback, useMemo, type MutableRefObject } from "react";
import { apiUrl } from "@/app/lib/api";
import type { Source } from "@/app/components/chat/types";

export function useSources(inviteCodeRef: MutableRefObject<string>) {
  const [sources, setSources] = useState<Source[]>([]);
  const [hiddenSources, setHiddenSources] = useState<Source[]>([]);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<number>>(new Set());
  const [bulkSelectMode, setBulkSelectMode] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/sources?view=chat"));
      const data = await res.json();
      if (data.sources) setSources(data.sources);
      if (data.denormalized) setHiddenSources(data.denormalized);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  // Combined list for source matching in citations (visible + hidden denormalized)
  const allSourcesForMatching = useMemo(
    () => [...sources, ...hiddenSources],
    [sources, hiddenSources],
  );

  const deleteSelectedSources = useCallback(async () => {
    if (selectedSourceIds.size === 0) return;
    const ids = Array.from(selectedSourceIds);
    try {
      const res = await fetch(apiUrl("/api/sources"), {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-code": encodeURIComponent(inviteCodeRef.current),
        },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) return;
      setSources((prev) => prev.filter((s) => !selectedSourceIds.has(s.id)));
      setSelectedSourceIds(new Set());
      setBulkSelectMode(false);
    } catch (e) {
      console.error("Failed to delete sources:", e);
    }
  }, [selectedSourceIds, inviteCodeRef]);

  return {
    sources,
    hiddenSources,
    allSourcesForMatching,
    loadSources,
    expandedSourceId,
    setExpandedSourceId,
    selectedSourceIds,
    setSelectedSourceIds,
    bulkSelectMode,
    setBulkSelectMode,
    deleteSelectedSources,
  };
}
