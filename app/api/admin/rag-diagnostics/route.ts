import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";
import { serverError } from "@/app/lib/api-helpers";

// ============================================================
// POST /api/admin/rag-diagnostics
// Диагностика RAG по конкретной организации/запросу: какие сущности
// знает knowledge graph, какие чанки к ним привязаны, какие файлы
// подходят по имени, есть ли рёбра на authority_matrix и т.п.
//
// Body:
//   query: string   — текст запроса или название организации
// ============================================================

interface KgEntity {
  id: number;
  name: string;
  canonical_name: string;
  entity_type: string;
  source_chunk_ids: number[] | null;
  source_ids: number[] | null;
}

interface KgRelationRow {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relation_type: string;
  confidence: number | null;
}

interface ChunkRow {
  id: number;
  source_id: number;
  chunk_index: number;
  tags: string[] | null;
}

interface SourceRow {
  id: number;
  filename: string;
  tags: string[] | null;
  folder_path: string | null;
}

const AUTHORITY_MATRIX_TAGS = ["матрица полномочий", "authority_matrix"];

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => ({}));
    const raw = typeof body.query === "string" ? body.query.trim() : "";
    if (!raw) {
      return NextResponse.json({ error: "query обязателен" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const lower = raw.toLowerCase();

    // 1. kg_entities: ищем по canonical_name / name (ILIKE) — приоритет organization/document.
    const { data: entitiesRaw, error: entErr } = await supabase
      .from("kg_entities")
      .select("id, name, canonical_name, entity_type, source_chunk_ids, source_ids")
      .or(`canonical_name.ilike.%${lower}%,name.ilike.%${raw}%`)
      .limit(30);
    if (entErr) throw entErr;
    const entities = (entitiesRaw || []) as KgEntity[];

    // 2. Детальная информация по первым 10 сущностям: чанки + relations.
    const entityIds = entities.slice(0, 10).map((e) => e.id);
    const allChunkIds = new Set<number>();
    for (const e of entities.slice(0, 10)) {
      for (const cid of e.source_chunk_ids ?? []) allChunkIds.add(cid);
    }

    let chunks: ChunkRow[] = [];
    if (allChunkIds.size > 0) {
      const { data: chunksRaw, error: chErr } = await supabase
        .from("chunks")
        .select("id, source_id, chunk_index, tags")
        .in("id", [...allChunkIds].slice(0, 200));
      if (chErr) throw chErr;
      chunks = (chunksRaw || []) as ChunkRow[];
    }

    // Собираем sources для чанков и для связанных source_ids сущностей.
    const sourceIds = new Set<number>();
    for (const c of chunks) sourceIds.add(c.source_id);
    for (const e of entities.slice(0, 10)) {
      for (const sid of e.source_ids ?? []) sourceIds.add(sid);
    }

    let sources: SourceRow[] = [];
    if (sourceIds.size > 0) {
      const { data: sourcesRaw, error: srcErr } = await supabase
        .from("sources")
        .select("id, filename, tags, folder_path")
        .in("id", [...sourceIds].slice(0, 200));
      if (srcErr) throw srcErr;
      sources = (sourcesRaw || []) as SourceRow[];
    }
    const sourceById = new Map(sources.map((s) => [s.id, s]));

    // 3. Связи (hop=1) исходящие и входящие для выбранных сущностей.
    let relations: KgRelationRow[] = [];
    if (entityIds.length > 0) {
      const { data: relRaw, error: relErr } = await supabase
        .from("kg_relations")
        .select("id, source_entity_id, target_entity_id, relation_type, confidence")
        .or(
          `source_entity_id.in.(${entityIds.join(",")}),target_entity_id.in.(${entityIds.join(",")})`
        )
        .limit(100);
      if (relErr) throw relErr;
      relations = (relRaw || []) as KgRelationRow[];
    }

    // Подтянем имена связанных сущностей.
    const relatedEntityIds = new Set<number>();
    for (const r of relations) {
      relatedEntityIds.add(r.source_entity_id);
      relatedEntityIds.add(r.target_entity_id);
    }
    let relatedEntities: Array<Pick<KgEntity, "id" | "name" | "entity_type">> = [];
    if (relatedEntityIds.size > 0) {
      const { data: relEntRaw, error: relEntErr } = await supabase
        .from("kg_entities")
        .select("id, name, entity_type")
        .in("id", [...relatedEntityIds]);
      if (relEntErr) throw relEntErr;
      relatedEntities = (relEntRaw || []) as Array<
        Pick<KgEntity, "id" | "name" | "entity_type">
      >;
    }
    const entNameById = new Map(relatedEntities.map((e) => [e.id, e]));

    // 4. Отдельно — sources по имени файла (независимо от графа).
    const { data: filenameSourcesRaw, error: fsErr } = await supabase
      .from("sources")
      .select("id, filename, tags, folder_path")
      .ilike("filename", `%${raw}%`)
      .limit(20);
    if (fsErr) throw fsErr;
    const filenameSources = (filenameSourcesRaw || []) as SourceRow[];

    // 5. Формируем ответ per entity.
    const entityReports = entities.slice(0, 10).map((e) => {
      const chunkIds = e.source_chunk_ids ?? [];
      const relatedChunks = chunks.filter((c) => chunkIds.includes(c.id));
      const filesSet = new Set<string>();
      let authorityMatrixChunks = 0;
      for (const c of relatedChunks) {
        const src = sourceById.get(c.source_id);
        if (src) filesSet.add(src.filename);
        const tags = (c.tags ?? []).map((t) => t.toLowerCase());
        if (tags.some((t) => AUTHORITY_MATRIX_TAGS.some((am) => t.includes(am)))) {
          authorityMatrixChunks++;
        }
      }
      const outgoing = relations
        .filter((r) => r.source_entity_id === e.id)
        .map((r) => ({
          type: r.relation_type,
          confidence: r.confidence,
          target: entNameById.get(r.target_entity_id)?.name ?? `#${r.target_entity_id}`,
          targetType: entNameById.get(r.target_entity_id)?.entity_type ?? "?",
        }));
      const incoming = relations
        .filter((r) => r.target_entity_id === e.id)
        .map((r) => ({
          type: r.relation_type,
          confidence: r.confidence,
          source: entNameById.get(r.source_entity_id)?.name ?? `#${r.source_entity_id}`,
          sourceType: entNameById.get(r.source_entity_id)?.entity_type ?? "?",
        }));
      return {
        id: e.id,
        name: e.name,
        canonicalName: e.canonical_name,
        entityType: e.entity_type,
        chunkCount: chunkIds.length,
        linkedFiles: [...filesSet].slice(0, 20),
        authorityMatrixChunks,
        outgoing: outgoing.slice(0, 20),
        incoming: incoming.slice(0, 20),
      };
    });

    const diagnosis: string[] = [];
    if (entities.length === 0) {
      diagnosis.push(
        `Сущность по запросу "${raw}" не найдена в kg_entities. Вероятная причина: документ не проходил extract-entities, либо название не совпадает по токенам.`
      );
    } else {
      const orgEntities = entityReports.filter((e) => e.entityType === "organization");
      if (orgEntities.length > 0) {
        const totalAM = orgEntities.reduce((s, e) => s + e.authorityMatrixChunks, 0);
        if (totalAM === 0) {
          diagnosis.push(
            `Найдены сущности organization, но НИ ОДИН из привязанных чанков не имеет тега "матрица полномочий". Поиск матрицы через граф не будет работать.`
          );
        } else {
          diagnosis.push(
            `Найдено ${totalAM} чанков с тегом "матрица полномочий", привязанных к organization-сущностям. Graph traversal должен их доставать.`
          );
        }
      }
      const hasEmptyChunks = entityReports.some((e) => e.chunkCount === 0);
      if (hasEmptyChunks) {
        diagnosis.push(
          `У некоторых сущностей пустой source_chunk_ids — они могли быть созданы до индексации или потеряны при cross-doc merge.`
        );
      }
    }
    if (filenameSources.length === 0) {
      diagnosis.push(`В sources нет файлов с "${raw}" в имени.`);
    }

    return NextResponse.json({
      query: raw,
      entitiesFound: entities.length,
      entityReports,
      filenameSources: filenameSources.map((s) => ({
        id: s.id,
        filename: s.filename,
        tags: s.tags ?? [],
        folderPath: s.folder_path,
        isAuthorityMatrix: (s.tags ?? [])
          .map((t) => t.toLowerCase())
          .some((t) => AUTHORITY_MATRIX_TAGS.some((am) => t.includes(am))),
      })),
      diagnosis,
    });
  } catch (error: unknown) {
    console.error(
      "rag-diagnostics POST error:",
      error instanceof Error ? error.message : error
    );
    return serverError("Ошибка диагностики");
  }
}
