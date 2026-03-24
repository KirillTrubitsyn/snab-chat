-- Добавить поле для отслеживания "ожидающего ответа" от конкретного админа
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS pending_admin_chat_id TEXT;

CREATE INDEX IF NOT EXISTS idx_support_pending
  ON support_messages(pending_admin_chat_id)
  WHERE pending_admin_chat_id IS NOT NULL AND status = 'open';
