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

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  // Use batch embedding — one API call for multiple texts
  return withGoogleApiLimit(async () => {
    const result = await client.models.embedContent({
      model: MODEL,
      contents: texts,
      config: {
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIMENSIONS,
      },
    });
    return result.embeddings!.map((e) => e.values!);
  });
}
