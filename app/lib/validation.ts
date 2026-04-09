import { z } from "zod";
import { NextResponse } from "next/server";

// ── Reusable helpers ──

const trimmedString = (min = 1, max = 5000) =>
  z.string().min(min).max(max).transform((s) => s.trim());

const uuid = z.string().uuid();

// ── Schema definitions ──

export const loginSchema = z.object({
  code: trimmedString(1, 200),
  password: z.string().optional(),
  device_id: z.string().optional(),
});

export const setPasswordSchema = z.object({
  code: trimmedString(1, 200),
  password: trimmedString(8, 200),
  device_id: z.string().optional(),
});

export const sendOtpSchema = z.object({
  code: trimmedString(1, 200),
});

export const verifyOtpSchema = z.object({
  code: trimmedString(1, 200),
  otp: z.string().min(6).max(6),
  device_id: z.string().optional(),
});

export const setupTotpConfirmSchema = z.object({
  code: trimmedString(1, 200),
  otp: z.string().min(6).max(6),
  secret: trimmedString(1, 200),
});

export const registerSchema = z.object({
  password: trimmedString(8, 200),
  name: trimmedString(1, 200),
  organization: trimmedString(1, 500),
  device_id: z.string().optional(),
});

export const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().min(1).max(50000),
    })
  ).min(1),
  conversationId: z.string().optional().nullable(),
  attachedDocuments: z.array(z.object({
    sourceId: z.string(),
    filename: z.string(),
  })).optional(),
});

export const supportMessageSchema = z.object({
  message: trimmedString(3, 5000),
});

export const supportReplySchema = z.object({
  id: uuid,
  reply: z.string().max(5000).optional(),
  status: z.enum(["open", "answered", "closed"]).optional(),
});

export const searchSchema = z.object({
  query: trimmedString(1, 2000),
  topK: z.number().int().min(1).max(100).optional(),
  tags: z.array(z.string()).nullable().optional(),
});

export const kbSearchSchema = z.object({
  query: trimmedString(1, 2000),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortBy: z.enum(["relevance", "date", "name"]).optional(),
});

export const inviteCodeCreateSchema = z.object({
  code: trimmedString(1, 200),
  name: trimmedString(1, 200),
  organization: z.string().max(500).optional().nullable(),
  chat_limit: z.number().int().min(0).nullable().optional(),
  infographic_limit: z.number().int().min(0).nullable().optional(),
  device_limit: z.number().int().min(1).max(100).optional(),
});

export const errorLogSchema = z.object({
  error_message: trimmedString(1, 5000),
  error_type: z.string().max(100).optional(),
  endpoint: z.string().max(500).optional(),
});

export const infographicSchema = z.object({
  topic: trimmedString(1, 2000),
  style: z.string().max(200).optional(),
  aspectRatio: z.string().max(20).optional(),
  documentText: z.string().max(100000).optional(),
  conversationId: z.string().optional().nullable(),
});

// ── Parse helper ──

/**
 * Parse and validate request body against a Zod schema.
 * Returns `{ data }` on success or `{ error: NextResponse }` on failure.
 */
export function parseBody<T extends z.ZodType>(
  body: unknown,
  schema: T
): { data: z.infer<T>; error?: undefined } | { data?: undefined; error: NextResponse } {
  const result = schema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const field = firstIssue.path.join(".");
    const message = field
      ? `Поле "${field}": ${firstIssue.message}`
      : firstIssue.message;
    return {
      error: NextResponse.json({ error: message }, { status: 400 }),
    };
  }
  return { data: result.data };
}
