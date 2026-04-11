/**
 * Centralized magic numbers and configuration constants.
 *
 * Gathered from backend lib/ and routes/ files.
 * All objects use `as const` for literal type inference.
 *
 * NOTE: existing files still have their own local copies of these values.
 *       A follow-up change will update imports to use this module.
 */

/** Retrieval & relevance filtering (lib/retrieval.ts) */
export const RAG = {
  /** Minimum similarity score to consider a chunk relevant */
  SIMILARITY_THRESHOLD: 0.35,
  /** Drop chunk if its score < previous * CLIFF_RATIO (strict mode) */
  CLIFF_RATIO: 0.6,
  /** Drop chunk if its score < best * CLIFF_RATIO_RELAXED (relaxed mode) */
  CLIFF_RATIO_RELAXED: 0.5,
  /** Chunk must be >= this fraction of the best result's score */
  MAX_FROM_BEST_RATIO: 0.4,
  /** Maximum chunks to keep after relevance filtering */
  MAX_CHUNKS: 15,
  /** Minimum chunks before switching to relaxed cliff filtering */
  MIN_CHUNKS_BEFORE_RELAX: 3,

  /** Default match count for hybrid_search RPC */
  DEFAULT_MATCH_COUNT: 20,
  /** Vector similarity weight in hybrid search */
  VECTOR_WEIGHT: 0.7,
  /** Full-text search weight in hybrid search */
  FTS_WEIGHT: 0.3,

  /** Max chunks for section lookup (fetchChunksBySection) */
  SECTION_LOOKUP_MAX_CHUNKS: 6,
  /** Max chunks for document lookup (fetchChunksByDocument) */
  DOCUMENT_LOOKUP_MAX_CHUNKS: 8,
} as const;

/** Chunking parameters (lib/chunking.ts) */
export const CHUNKING = {
  /** Target chunk size in characters (~3000 tokens) */
  TARGET_CHARS: 9000,
  /** Minimum chunk size in characters */
  MIN_CHUNK_CHARS: 500,
  /** Hard limit for very large tables */
  MAX_CHUNK_CHARS: 15000,
  /** Maximum images per chunk (Gemini Embedding 2 limit) */
  MAX_IMAGES_PER_CHUNK: 6,
} as const;

/** Embedding model configuration (lib/embeddings.ts) */
export const EMBEDDING = {
  /** Gemini embedding model name */
  MODEL: "gemini-embedding-2-preview",
  /** Output dimensionality */
  DIMENSIONS: 1536,
  /** Maximum concurrent embedding requests */
  MAX_CONCURRENT: 5,
} as const;

/** Chat route constants (routes/chat.ts) */
export const CHAT = {
  /** Truncation limit for user-uploaded documents */
  MAX_UPLOADED_DOC_CHARS: 50000,
  /** Max images to include per chunk in the prompt */
  MAX_CHUNK_IMAGES: 3,
  /** Max total images in the entire prompt */
  MAX_TOTAL_IMAGES: 12,
  /** Minimum chunks per regime before supplementary search */
  MIN_REGIME_CHUNKS: 3,
} as const;

/** Conversation memory (lib/memory.ts) */
export const MEMORY = {
  /** Token count above which old messages get summarized */
  SUMMARIZE_THRESHOLD: 25000,
  /** Number of recent messages to preserve when summarizing */
  RECENT_MESSAGES_KEEP: 10,
  /** Maximum messages to load from DB per conversation */
  MAX_MESSAGES_LOAD: 50,
} as const;

/** Reranker configuration (lib/reranker.ts) */
export const RERANKER = {
  /** Gemini model used for LLM-based reranking */
  MODEL: "gemini-3.1-flash-lite-preview",
  /** Maximum chunks to send to the reranker */
  MAX_CHUNKS_TO_RERANK: 20,
  /** Max chars of chunk content shown to the reranker */
  MAX_CHUNK_PREVIEW: 1500,
} as const;

/** Agentic RAG loop (lib/agentic-rag.ts) */
export const AGENTIC = {
  /** Gemini model used for the agentic loop */
  MODEL: "gemini-2.5-flash",
  /** Maximum search tool invocations per request */
  MAX_AGENT_SEARCHES: 8,
  /** Default max steps in the agentic search loop */
  DEFAULT_MAX_STEPS: 6,
  /** Max balanced chunks for multi-entity queries */
  MAX_BALANCED_CHUNKS: 12,
} as const;
