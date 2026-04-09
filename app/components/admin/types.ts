export interface InviteCode {
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
  // Password & 2FA
  password_hash: string | null;
  telegram_chat_id: string | null;
  phone_number: string | null;
  totp_secret: string | null;
}

export interface ActivityItem {
  id: string;
  type: "chat" | "infographic";
  user_name: string;
  organization: string | null;
  content: string;
  model: string | null;
  created_at: string;
}

export interface Source {
  id: number;
  filename: string;
  mime_type: string;
  tags: string[];
  storage_path: string | null;
  folder_path: string | null;
  created_at: string;
}

export interface ParsedFile {
  filename: string;
  mimeType: string;
  markdown: string;
  tags: string[];
  images: Array<{ base64: string; mimeType: string; marker: string }>;
  storagePath?: string;
  chunks: { index: number; preview: string; length: number; imageCount: number }[];
  totalChunks: number;
  totalImages: number;
}

export interface NontargetItem {
  id: string;
  user_name: string;
  organization: string | null;
  category: string;
  query_text: string;
  created_at: string;
}

export interface SupportItem {
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

export interface UserMessageItem {
  id: string;
  user_name: string;
  organization: string | null;
  content: string;
  model: string | null;
  created_at: string;
}

export interface ErrorItem {
  id: string;
  error_type: string;
  error_message: string;
  endpoint: string | null;
  user_name: string | null;
  organization: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
