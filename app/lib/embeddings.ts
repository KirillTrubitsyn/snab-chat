import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "./google-ai";
import type { ChunkImage } from "./chunking";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

const MODEL = "gemini-embedding-2-preview";
const DIMENSIONS = 1536;

/* ── Text-only query embedding (unchanged) ── */

export async function embedQuery(text: string): Promise<number[]> {
  return withGoogleApiLimit(async () => {
    const result = await client.models.embedContent({
      model: MODEL,
      contents: text,
      config: {
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: DIMENSIONS,
      },
    });
    return result.embeddings![0].values!;
  });
}

/* ── Multimodal document embedding ── */

interface EmbedInput {
  text: string;
  images?: ChunkImage[];
}

const MAX_CONCURRENT_EMBEDDINGS = 5;

/**
 * Embed documents with optional images.
 * When a chunk has images, they are passed as inlineData parts
 * to Gemini Embedding 2, creating a unified multimodal vector.
 *
 * Gemini Embedding 2 supports up to 6 images per request.
 */
export async function embedDocuments(inputs: EmbedInput[]): Promise<number[][]> {
  const results: number[][] = new Array(inputs.length);

  for (let i = 0; i < inputs.length; i += MAX_CONCURRENT_EMBEDDINGS) {
    const batch = inputs.slice(i, i + MAX_CONCURRENT_EMBEDDINGS);
    const batchResults = await Promise.all(
      batch.map((input) =>
        withGoogleApiLimit(async () => {
          // Build multimodal content parts
          const parts: Array<
            { text: string } | { inlineData: { data: string; mimeType: string } }
          > = [{ text: input.text }];

          // Add images if present (max 6 per Gemini Embedding 2 limit)
          if (input.images && input.images.length > 0) {
            for (const img of input.images.slice(0, 6)) {
              parts.push({
                inlineData: {
                  data: img.data.toString("base64"),
                  mimeType: img.mimeType,
                },
              });
            }
          }

          const result = await client.models.embedContent({
            model: MODEL,
            contents: { parts },
            config: {
              taskType: "RETRIEVAL_DOCUMENT",
              outputDimensionality: DIMENSIONS,
            },
          });
          return result;
        })
      )
    );
    batchResults.forEach((result, j) => {
      results[i + j] = result.embeddings![0].values!;
    });
  }
  return results;
}

/* ── Legacy text-only embedding (backward compatible) ── */

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return embedDocuments(texts.map((text) => ({ text })));
}
