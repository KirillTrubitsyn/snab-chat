import { useState, useRef, useCallback, type MutableRefObject } from "react";
import { apiUrl } from "@/app/lib/api";
import type { ChatFile, ChatPhoto } from "@/app/components/chat/types";

const MAX_CHAT_FILES = 10;
const MAX_CHAT_PHOTOS = 10;
const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ACCEPTED_CHAT_TYPES = ".pdf,.doc,.docx,.xlsx,.xls,.pptx,.txt,.md,.mp3,.wav,.jpg,.jpeg,.png,.gif,.bmp,.webp";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024; // 4 MB (Vercel body limit)

interface DocFormatModalState {
  show: boolean;
  fileName: string;
  type: "doc" | "xls";
}

export function useFileAttachments(inviteCodeRef: MutableRefObject<string>) {
  const [chatFiles, setChatFiles] = useState<ChatFile[]>([]);
  const [chatPhotos, setChatPhotos] = useState<ChatPhoto[]>([]);
  const sessionDocsRef = useRef<Array<{ filename: string; markdown: string }>>([]);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [docFormatModal, setDocFormatModal] = useState<DocFormatModalState>({
    show: false,
    fileName: "",
    type: "doc",
  });

  const parseFileViaApi = useCallback(
    async (file: File, fileId: string, isPhoto: boolean) => {
      try {
        const formData = new FormData();

        // Large files: upload to Storage first, then pass storagePath to parse
        if (file.size > LARGE_FILE_THRESHOLD) {
          const urlRes = await fetch(apiUrl("/api/chat-upload-url"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-invite-code": encodeURIComponent(inviteCodeRef.current),
            },
            body: JSON.stringify({ filename: file.name, mimeType: file.type }),
          });
          if (urlRes.ok) {
            const { uploadUrl, storagePath } = await urlRes.json();
            const putRes = await fetch(uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": file.type, "x-upsert": "false" },
              body: file,
            });
            if (putRes.ok) {
              formData.append("storagePath", storagePath);
              formData.append("storageBucket", "chat-uploads");
              formData.append("filename", file.name);
              formData.append("mimeType", file.type);
            } else {
              throw new Error("Storage upload failed");
            }
          } else {
            throw new Error("Failed to get upload URL");
          }
        } else {
          formData.append("file", file);
        }

        const res = await fetch(apiUrl("/api/parse"), {
          method: "POST",
          body: formData,
          headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        });
        if (!res.ok) {
          let serverError = "Parse failed";
          try {
            const errData = await res.json();
            serverError = errData.error || serverError;
          } catch {
            /* ignore */
          }
          throw new Error(serverError);
        }
        const data = await res.json();
        if (isPhoto) {
          setChatPhotos((prev) =>
            prev.map((p) => (p.id === fileId ? { ...p, markdown: data.markdown, parsing: false } : p)),
          );
        } else {
          setChatFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, markdown: data.markdown, parsing: false } : f)),
          );
        }
      } catch (err) {
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        const errMsg = err instanceof Error ? err.message : "";

        // Legacy .doc file -> show resave modal
        if (ext === "doc") {
          setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
          setDocFormatModal({ show: true, fileName: file.name, type: "doc" });
          return;
        }
        // Old binary .xls format
        if (ext === "xls" || errMsg.includes("Excel 97-2003") || errMsg.includes("старый формат")) {
          setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
          setDocFormatModal({ show: true, fileName: file.name, type: "xls" });
          return;
        }
        if (isPhoto) {
          setChatPhotos((prev) =>
            prev.map((p) => (p.id === fileId ? { ...p, parsing: false, error: "Ошибка распознавания" } : p)),
          );
        } else {
          setChatFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, parsing: false, error: "Ошибка обработки" } : f)),
          );
        }
      }
    },
    [inviteCodeRef],
  );

  const handleChatFileSelect = useCallback(
    async (files: FileList) => {
      const newFiles = Array.from(files);

      for (const file of newFiles) {
        if (file.size > MAX_CHAT_FILE_SIZE) {
          alert(`Файл "${file.name}" превышает 50 МБ`);
          continue;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "";

        // Route images to photos
        if (IMAGE_EXTENSIONS.includes(ext)) {
          if (chatPhotos.length >= MAX_CHAT_PHOTOS) {
            alert(`Максимум ${MAX_CHAT_PHOTOS} фото`);
            continue;
          }
          const photoId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const preview = URL.createObjectURL(file);
          setChatPhotos((prev) => {
            if (prev.length >= MAX_CHAT_PHOTOS) return prev;
            return [...prev, { id: photoId, file, preview, markdown: "", parsing: true }];
          });
          parseFileViaApi(file, photoId, true);
          continue;
        }

        // Documents
        if (!["pdf", "doc", "docx", "xlsx", "xls", "pptx", "txt", "md", "mp3", "wav"].includes(ext)) {
          alert(`Формат .${ext} не поддерживается. Допустимые: PDF, DOC, DOCX, XLSX, PPTX, TXT, MD, MP3, WAV, изображения`);
          continue;
        }

        if (chatFiles.length >= MAX_CHAT_FILES) {
          alert(`Макси��ум ${MAX_CHAT_FILES} файлов`);
          break;
        }

        const fileId = `cf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setChatFiles((prev) => {
          if (prev.length >= MAX_CHAT_FILES) return prev;
          return [...prev, { id: fileId, file, filename: file.name, markdown: "", parsing: true }];
        });
        parseFileViaApi(file, fileId, false);
      }
    },
    [chatFiles.length, chatPhotos.length, parseFileViaApi],
  );

  const handlePhotoCapture = useCallback(
    (file: File) => {
      if (chatPhotos.length >= MAX_CHAT_PHOTOS) return;
      const photoId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const preview = URL.createObjectURL(file);
      setChatPhotos((prev) => {
        if (prev.length >= MAX_CHAT_PHOTOS) return prev;
        return [...prev, { id: photoId, file, preview, markdown: "", parsing: true }];
      });
      parseFileViaApi(file, photoId, true);
    },
    [chatPhotos.length, parseFileViaApi],
  );

  const removeChatFile = useCallback((fileId: string) => {
    setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  const removeChatPhoto = useCallback((photoId: string) => {
    setChatPhotos((prev) => {
      const photo = prev.find((p) => p.id === photoId);
      if (photo?.preview) URL.revokeObjectURL(photo.preview);
      return prev.filter((p) => p.id !== photoId);
    });
  }, []);

  return {
    chatFiles,
    setChatFiles,
    chatPhotos,
    setChatPhotos,
    sessionDocsRef,
    chatFileInputRef,
    handleChatFileSelect,
    handlePhotoCapture,
    removeChatFile,
    removeChatPhoto,
    docFormatModal,
    setDocFormatModal,
    MAX_CHAT_FILES,
    MAX_CHAT_PHOTOS,
    ACCEPTED_CHAT_TYPES,
  };
}
