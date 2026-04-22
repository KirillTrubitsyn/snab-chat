import { createGoogleGenerativeAI } from "@ai-sdk/google";

export const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

/**
 * Simple concurrency semaphore to prevent one user from monopolizing
 * the Google API while others wait.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

// Allow up to 5 concurrent Google API calls across all users
export const googleApiSemaphore = new Semaphore(5);

/**
 * Check if an error is a quota / rate-limit exhaustion (HTTP 429 or equivalent).
 * Used to decide whether to fall back to a cheaper / less-loaded model.
 */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (/429|too many requests|rate.?limit|quota|resource.?exhausted/i.test(msg)) return true;
  }
  // @google/genai may surface status on the error object
  const status = (err as { status?: number; code?: number } | null | undefined)?.status
    ?? (err as { code?: number } | null | undefined)?.code;
  if (status === 429) return true;
  return false;
}

/**
 * Check if an error is retryable (rate limit or transient server error).
 */
function isRetryableError(err: unknown): boolean {
  if (isQuotaError(err)) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Google API transient server errors (500, 502, 503, 504)
    if (/500|502|503|504|internal|unavailable|bad gateway|overloaded/i.test(msg)) return true;
    if (/econnreset|econnrefused|etimedout|socket hang up|fetch failed/i.test(msg)) return true;
  }
  return false;
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

export async function withGoogleApiLimit<T>(fn: () => Promise<T>): Promise<T> {
  await googleApiSemaphore.acquire();
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryableError(err)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[GoogleAPI] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } finally {
    googleApiSemaphore.release();
  }
}
