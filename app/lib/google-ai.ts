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

export async function withGoogleApiLimit<T>(fn: () => Promise<T>): Promise<T> {
  await googleApiSemaphore.acquire();
  try {
    return await fn();
  } finally {
    googleApiSemaphore.release();
  }
}
