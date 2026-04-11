import { useState, useCallback, type FormEvent, type MutableRefObject } from "react";
import { apiUrl } from "@/app/lib/api";
import type { ChatFile, ChatPhoto, Conversation } from "@/app/components/chat/types";

interface StreamingDeps {
  inviteCodeRef: MutableRefObject<string>;
  convIdRef: MutableRefObject<string | null>;
  pendingSubmitRef: MutableRefObject<string | null>;
  sessionDocsRef: MutableRefObject<Array<{ filename: string; markdown: string }>>;
  input: string;
  setInput: (v: string) => void;
  isLoading: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setMessages: (updater: any[] | ((prev: any[]) => any[])) => void;
  chatFiles: ChatFile[];
  setChatFiles: (files: ChatFile[]) => void;
  chatPhotos: ChatPhoto[];
  setChatPhotos: (photos: ChatPhoto[]) => void;
  conversations: Conversation[];
  createConversation: (title?: string) => Promise<string>;
  loadConversations: () => Promise<void>;
  reloadMessagesFromServer: (convId: string, expectedCount: number) => Promise<void>;
  handleLogout: () => void;
  CONV_LIMIT: number;
}

/** Parse sources and chunk images from stream response headers */
function parseResponseHeaders(res: Response) {
  let sources: string[] = [];
  let chunkImages: { url: string; source: string; chunk: number }[] = [];
  try {
    const srcHeader = res.headers.get("X-Sources");
    if (srcHeader) sources = JSON.parse(decodeURIComponent(srcHeader));
  } catch {
    /* ignore */
  }
  try {
    const imgHeader = res.headers.get("X-Chunk-Images");
    if (imgHeader) chunkImages = JSON.parse(decodeURIComponent(imgHeader));
  } catch {
    /* ignore */
  }
  return { sources, chunkImages };
}

/** Handle error HTTP status codes */
function handleStreamError(
  status: number,
  handleLogout: () => void,
  setChatError: (err: string | null) => void,
) {
  if (status === 401) {
    handleLogout();
  } else if (status === 429) {
    setChatError("Слишком много запросов. Подождите немного и попробуйте снова.");
  } else if (status >= 500) {
    setChatError("Сервер временно недоступен. Попробуйте через несколько секунд.");
  } else {
    setChatError("Не удалось получить ответ от ИИ. Попробуйте ещё раз.");
  }
}

/** Read the SSE stream and update messages */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readStream(body: ReadableStream<Uint8Array>, assistantId: string, setMessages: (updater: (prev: any[]) => any[]) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let assistantText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("0:")) {
        try {
          const parsed = JSON.parse(line.slice(2));
          if (typeof parsed === "string") {
            assistantText += parsed;
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, content: assistantText } : m)),
    );
  }
}

export function useStreaming(deps: StreamingDeps) {
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e?: FormEvent, overrideText?: string) => {
      e?.preventDefault();
      const text = (overrideText ?? deps.input).trim();
      const hasFiles = deps.chatFiles.filter((f) => !f.parsing && !f.error && f.markdown).length > 0;
      const hasPhotos = deps.chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown).length > 0;
      if ((!text && !hasFiles && !hasPhotos) || deps.isLoading || isSending) return;

      // Block new conversations if limit reached
      if (!deps.convIdRef.current && deps.conversations.length >= deps.CONV_LIMIT) {
        setChatError(`Достигнут лимит диалогов (${deps.CONV_LIMIT}). Удалите старые диалоги, чтобы начать новый.`);
        return;
      }

      setIsSending(true);
      setChatError(null);

      // Prepare attached documents from chatFiles + chatPhotos
      const readyFiles = deps.chatFiles.filter((f) => !f.parsing && !f.error && f.markdown);
      const readyPhotos = deps.chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown);
      const attachedDocuments: Array<{ filename: string; markdown: string }> = [
        ...readyFiles.map((f) => ({ filename: f.filename, markdown: f.markdown })),
        ...readyPhotos.map((p, i) => ({ filename: p.file.name || `Фото ${i + 1}`, markdown: p.markdown })),
      ];
      const attachmentNames = [
        ...readyFiles.map((f) => f.filename),
        ...readyPhotos.map((p) => p.file.name || "Фото"),
      ];

      // Auto-detect and fetch URLs from message text
      const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
      const detectedUrls = text ? [...new Set(text.match(urlRegex) || [])] : [];
      if (detectedUrls.length > 0) {
        const urlResults = await Promise.allSettled(
          detectedUrls.slice(0, 5).map(async (url) => {
            const res = await fetch(apiUrl("/api/fetch-url"), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-invite-code": encodeURIComponent(deps.inviteCodeRef.current),
              },
              body: JSON.stringify({ url }),
            });
            if (!res.ok) return null;
            return res.json();
          }),
        );
        for (const result of urlResults) {
          if (result.status === "fulfilled" && result.value) {
            const { title, url: fetchedUrl, markdown } = result.value;
            attachedDocuments.push({ filename: `${title} (${fetchedUrl})`, markdown });
            attachmentNames.push(title || fetchedUrl);
          }
        }
      }
      const messageText =
        text ||
        (attachmentNames.length > 0
          ? `Проверь ${attachmentNames.length === 1 ? "документ" : "документы"}: ${attachmentNames.join(", ")}`
          : "");

      // Save newly attached documents to session for future messages
      if (attachedDocuments.length > 0) {
        deps.sessionDocsRef.current = attachedDocuments.map((d) => ({
          filename: d.filename,
          markdown: d.markdown,
        }));
      }

      // Clear files, photos and input immediately
      deps.setChatFiles([]);
      deps.chatPhotos.forEach((p) => {
        if (p.preview) URL.revokeObjectURL(p.preview);
      });
      deps.setChatPhotos([]);

      /* ── New conversation path ── */
      if (!deps.convIdRef.current) {
        deps.pendingSubmitRef.current = messageText;
        deps.setInput("");
        const title = messageText.slice(0, 50) + (messageText.length > 50 ? "..." : "");
        let newId: string;
        try {
          newId = await deps.createConversation(title);
        } catch (err) {
          console.error("Failed to create conversation:", err);
          const errMsg = err instanceof Error ? err.message : "Не удалось создать диалог";
          if (!errMsg.includes("401")) setChatError(errMsg);
          deps.setInput(messageText);
          deps.pendingSubmitRef.current = null;
          setIsSending(false);
          return;
        }

        deps.setMessages((prev) => [
          ...prev,
          {
            id: `temp-user-${Date.now()}`,
            role: "user",
            content: messageText,
            ...(attachmentNames.length > 0 && { attachments: attachmentNames }),
          },
        ]);

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90000);

          const res = await fetch(apiUrl("/api/chat"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-invite-code": encodeURIComponent(deps.inviteCodeRef.current),
            },
            body: JSON.stringify({
              messages: [{ role: "user", content: messageText }],
              conversationId: newId,
              ...(attachedDocuments.length > 0 && { attachedDocuments }),
              ...(attachedDocuments.length === 0 &&
                deps.sessionDocsRef.current.length > 0 && {
                  sessionDocuments: deps.sessionDocsRef.current,
                }),
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (!res.ok || !res.body) {
            handleStreamError(res.status, deps.handleLogout, setChatError);
            throw new Error(`Stream failed: ${res.status}`);
          }

          const { sources, chunkImages } = parseResponseHeaders(res);
          const assistantId = `temp-assistant-${Date.now()}`;

          deps.setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "",
              sources,
              ...(chunkImages.length > 0 && { chunkImages }),
            },
          ]);

          await readStream(res.body, assistantId, deps.setMessages);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            setChatError("Запрос занял слишком много времени. Попробуйте переформулировать вопрос короче.");
          }
          console.error("Manual stream error:", err);
        }

        deps.pendingSubmitRef.current = null;
        setIsSending(false);
        deps.reloadMessagesFromServer(newId, 2);
        deps.loadConversations();
        return;
      }

      /* ── Existing conversation path ── */
      const currentMessages = [
        ...deps.messages,
        {
          id: `temp-user-${Date.now()}`,
          role: "user" as const,
          content: messageText,
          ...(attachmentNames.length > 0 && { attachments: attachmentNames }),
        },
      ];
      deps.setMessages(currentMessages);
      deps.setInput("");

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);

        const res = await fetch(apiUrl("/api/chat"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-invite-code": encodeURIComponent(deps.inviteCodeRef.current),
          },
          body: JSON.stringify({
            messages: currentMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId: deps.convIdRef.current,
            ...(attachedDocuments.length > 0 && { attachedDocuments }),
            ...(attachedDocuments.length === 0 &&
              deps.sessionDocsRef.current.length > 0 && {
                sessionDocuments: deps.sessionDocsRef.current,
              }),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok || !res.body) {
          handleStreamError(res.status, deps.handleLogout, setChatError);
          throw new Error(`Stream failed: ${res.status}`);
        }

        const { sources, chunkImages } = parseResponseHeaders(res);
        const assistantId = `temp-assistant-${Date.now()}`;

        deps.setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            role: "assistant",
            content: "",
            sources,
            ...(chunkImages.length > 0 && { chunkImages }),
          },
        ]);

        await readStream(res.body, assistantId, deps.setMessages);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setChatError("Запрос занял слишком много времени. Попробуйте переформулировать вопрос короче.");
        }
        console.error("Stream error:", err);
      } finally {
        setIsSending(false);
        if (deps.convIdRef.current)
          deps.reloadMessagesFromServer(deps.convIdRef.current, deps.messages.length + 2);
      }
    },
    [deps, isSending],
  );

  return { handleSubmit, isSending, chatError, setChatError };
}
