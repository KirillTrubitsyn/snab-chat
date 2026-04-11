/**
 * Centralized type re-exports for the backend.
 *
 * All types remain defined in their original modules to avoid circular
 * dependencies.  This file is a convenience aggregation point so
 * consumers can do:
 *
 *   import type { SearchResult, IntentResult, Chunk } from "../types/index.js";
 */

// ── retrieval.ts ──
export type { SearchResult, FilteredSearchResult } from "../lib/retrieval.js";

// ── intent-classifier.ts ──
export type { QueryIntent, FzType, IntentResult } from "../lib/intent-classifier.js";

// ── off-topic-classifier.ts ──
export type { OffTopicCategory, ClassifyResult } from "../lib/off-topic-classifier.js";

// ── parser.ts ──
export type { ExtractedImage, ParseResult } from "../lib/parser.js";

// ── agentic-rag.ts ──
export type { AgenticContext } from "../lib/agentic-rag.js";

// ── chunking.ts ──
export type { ChunkImage, Chunk } from "../lib/chunking.js";

// ── query-analyzer.ts ──
export type {
  SectionReference,
  DocumentReference,
  CatalogQuery,
} from "../lib/query-analyzer.js";

// ── memory.ts ──
// memory.ts does not export named types (Message and ConversationContext
// are module-private interfaces).  Nothing to re-export here yet.

// ── auth.ts ──
export type { InviteCode } from "../lib/auth.js";
