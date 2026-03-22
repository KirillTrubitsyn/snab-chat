import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "./google-ai";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

const MODEL = "gemini-embedding-2-preview";
const DIMENSIONS = 1536;

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

const MAX_CONCURRENT_EMBEDDINGS = 5;

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);

  // Process embeddings in parallel with concurrency limit
  for (let i = 0; i < texts.length; i += MAX_CONCURRENT_EMBEDDINGS) {
    const batch = texts.slice(i, i + MAX_CONCURRENT_EMBEDDINGS);
    const batchResults = await Promise.all(
      batch.map((text) =>
        withGoogleApiLimit(() =>
          client.models.embedContent({
            model: MODEL,
            contents: text,
            config: {
              taskType: "RETRIEVAL_DOCUMENT",
              outputDimensionality: DIMENSIONS,
            },
          })
        )
      )
    );
    batchResults.forEach((result, j) => {
      results[i + j] = result.embeddings![0].values!;
    });
  }
  return results;
}
