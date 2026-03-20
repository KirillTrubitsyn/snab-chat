import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

const MODEL = "gemini-embedding-2-preview";
const DIMENSIONS = 1536;

export async function embedQuery(text: string): Promise<number[]> {
  const result = await client.models.embedContent({
    model: MODEL,
    contents: text,
    config: {
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: DIMENSIONS,
    },
  });
  return result.embeddings![0].values!;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const result = await client.models.embedContent({
      model: MODEL,
      contents: text,
      config: {
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIMENSIONS,
      },
    });
    results.push(result.embeddings![0].values!);
  }
  return results;
}
