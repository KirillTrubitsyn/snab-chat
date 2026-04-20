// ============================================================
// Knowledge Graph — реестр per-tag онтологий для extraction.
// ============================================================
// Позволяет применять разные промпты / allowlist'ы типов к чанкам
// разных доменов. Например, для договоров основное внимание на
// обязательствах и санкциях, для матриц полномочий — на уровнях
// согласования и эскалациях, для стандартов — на номерах, ссылках
// и supersedes.
//
// Все используемые entity_type / relation_type должны присутствовать
// в глобальных списках (ENTITY_TYPES / RELATION_TYPES в route.ts) —
// это гарантируется пересечением с ALL_ENTITY_TYPES / ALL_RELATION_TYPES
// при применении онтологии.
// ============================================================

export interface DomainOntology {
  /** Отображаемое имя домена для логов / ответа API. */
  readonly name: string;
  /** Приоритет при разрешении: чем выше, тем раньше выберется. */
  readonly priority: number;
  /** Теги чанка, активирующие эту онтологию. */
  readonly tags: readonly string[];
  /** Белый список типов сущностей, которые имеет смысл извлекать в этом домене. */
  readonly entityTypes: readonly string[];
  /** Белый список типов связей для этого домена. */
  readonly relationTypes: readonly string[];
  /**
   * Дополнение к системному промпту: доменные акценты, которые
   * добавляются после общих правил (не заменяют их).
   */
  readonly promptAddendum: string;
}

// ============================================================
// Доменные онтологии
// ============================================================

const STANDARDS_ONTOLOGY: DomainOntology = {
  name: 'standards',
  priority: 40,
  tags: ['стандарт', '223-фз', 'вне 223-фз'],
  entityTypes: [
    'standard', 'regulation', 'document', 'concept',
    'organization', 'role', 'section', 'threshold', 'mtr_type',
  ],
  relationTypes: [
    'defines', 'references', 'requires', 'governs', 'part_of',
    'supersedes', 'amends', 'sets_threshold', 'restricts',
  ],
  promptAddendum: [
    'ДОМЕН: стандарты и нормативные документы.',
    'Особое внимание:',
    '- обязательно указывай ПОЛНЫЙ номер стандарта с годом (ГОСТ 12.1.005-88, СТО СГК 013-2021);',
    '- фиксируй references — каждое упоминание другого документа/стандарта должно дать ребро;',
    '- supersedes/amends: если стандарт заменяет или изменяет другой — связь обязательна;',
    '- section: извлекай конкретные пункты (п. 3.2.1), они станут частями документа через part_of.',
  ].join('\n'),
};

const PROVISIONS_ONTOLOGY: DomainOntology = {
  name: 'provisions',
  priority: 35,
  tags: ['положения', 'методика', 'инструкции'],
  entityTypes: [
    'document', 'section', 'procedure', 'role', 'threshold',
    'concept', 'regulation', 'organization', 'system', 'branch',
  ],
  relationTypes: [
    'defines', 'references', 'requires', 'governs', 'part_of',
    'belongs_to', 'sets_threshold', 'delegates_to', 'requires_approval',
  ],
  promptAddendum: [
    'ДОМЕН: внутренние положения и методики.',
    'Особое внимание:',
    '- извлекай procedure — конкретные процедуры и этапы, на которые регламент налагает правила;',
    '- requires_approval и delegates_to: связи между ролями и процедурами критичны;',
    '- threshold: пороги (сумма, срок, процент), которые положение устанавливает.',
  ].join('\n'),
};

const CONTRACTS_ONTOLOGY: DomainOntology = {
  name: 'contracts',
  priority: 30,
  tags: ['договоры'],
  entityTypes: [
    'contract_party', 'obligation', 'organization', 'role',
    'threshold', 'document', 'section', 'regulation', 'procedure',
  ],
  relationTypes: [
    'party_of', 'obliged_to', 'penalized_by', 'references',
    'requires', 'sets_threshold', 'part_of', 'restricts',
  ],
  promptAddendum: [
    'ДОМЕН: договоры и договорные обязательства.',
    'Особое внимание:',
    '- contract_party: извлекай стороны договора (Заказчик / Исполнитель / Поставщик / Подрядчик) —',
    '  это отдельный тип, не путай с organization. Если конкретная организация выступает стороной,',
    '  добавляй и organization, и contract_party, и связь party_of между ними;',
    '- obligation: каждое обязательство (поставка, оплата, гарантия, соблюдение сроков) — отдельная сущность;',
    '- obliged_to: contract_party → obligation (кто что обязан сделать);',
    '- penalized_by: obligation → threshold (штраф, пени, неустойка за неисполнение);',
    '- threshold с финансовыми санкциями указывай конкретно (0,1% от суммы, 500 000 руб.).',
  ].join('\n'),
};

const AUTHORITY_MATRIX_ONTOLOGY: DomainOntology = {
  name: 'authority_matrix',
  priority: 30,
  tags: ['матрица полномочий'],
  entityTypes: [
    'approval_level', 'role', 'threshold', 'procedure',
    'organization', 'branch', 'document', 'concept',
  ],
  relationTypes: [
    'approves', 'escalates_to', 'delegates_to', 'requires_approval',
    'sets_threshold', 'restricts', 'belongs_to',
  ],
  promptAddendum: [
    'ДОМЕН: матрица полномочий и уровни согласования.',
    'Особое внимание:',
    '- approval_level: каждый уровень согласования — отдельная сущность (1-й уровень, ЦЗК, Правление);',
    '- approves: роль / approval_level → procedure / threshold (кто что согласовывает);',
    '- escalates_to: approval_level → approval_level (эскалация по сумме или сроку);',
    '- threshold: пороги активации уровня (свыше 5 млн руб., срок > 30 дней) — обязательно с конкретным значением;',
    '- delegates_to: если роль делегирует полномочия другой роли.',
    '',
    'ОБЯЗАТЕЛЬНОЕ ПРАВИЛО (B5 recovery plan от 2026-04-20):',
    'Каждый документ типа «матрица полномочий» принадлежит конкретному юрлицу / филиалу. ',
    'Ты ДОЛЖЕН создать узел branch или organization, к которому относится матрица, и связать с ним все роли/пороги/уровни через relation "belongs_to". ',
    'Источник inference: имя файла (например, "НМГРЭС", "КЭ", "СГК-Алт"), перечень филиалов в теле документа, вводная часть приказа. ',
    'Если имя филиала неочевидно, но файл содержит ссылку на приказ конкретной организации — создай узел organization из этой ссылки.',
    'Ни одна роль или approval_level в матрице не должен остаться без связи belongs_to → branch/organization — это критично для graph traversal от запроса «кто согласовывает в X?».',
  ].join('\n'),
};

const REGISTRIES_ONTOLOGY: DomainOntology = {
  name: 'registries',
  priority: 20,
  tags: ['реестр', 'справочники'],
  entityTypes: [
    'organization', 'mtr_type', 'branch', 'document',
    'concept', 'role', 'system',
  ],
  relationTypes: [
    'belongs_to', 'part_of', 'references', 'defines',
  ],
  promptAddendum: [
    'ДОМЕН: реестры и справочники.',
    'Особое внимание:',
    '- belongs_to / part_of — основные связи (подразделение → филиал, МТР → группа);',
    '- не извлекай threshold и procedure: реестры не задают процедур и порогов.',
  ].join('\n'),
};

const LEGISLATION_ONTOLOGY: DomainOntology = {
  name: 'legislation',
  priority: 25,
  tags: ['законодательство'],
  entityTypes: [
    'regulation', 'section', 'document', 'concept',
    'organization', 'role', 'threshold', 'procedure',
  ],
  relationTypes: [
    'defines', 'references', 'requires', 'governs', 'part_of',
    'supersedes', 'amends', 'sets_threshold', 'restricts',
  ],
  promptAddendum: [
    'ДОМЕН: федеральное законодательство.',
    'Особое внимание:',
    '- regulation: полный номер/название ФЗ, постановления, приказа (223-ФЗ, 44-ФЗ, ПП РФ №1352);',
    '- section: статьи, части, пункты закона (ст. 3 ч. 2, п. 4) — извлекай как отдельные сущности с part_of;',
    '- ссылки между НПА через references, иерархия через part_of.',
  ].join('\n'),
};

// ============================================================
// Реестр (упорядочен по priority DESC)
// ============================================================

export const DOMAIN_ONTOLOGIES: readonly DomainOntology[] = [
  STANDARDS_ONTOLOGY,
  PROVISIONS_ONTOLOGY,
  LEGISLATION_ONTOLOGY,
  CONTRACTS_ONTOLOGY,
  AUTHORITY_MATRIX_ONTOLOGY,
  REGISTRIES_ONTOLOGY,
].slice().sort((a, b) => b.priority - a.priority);

// ============================================================
// Разрешение онтологии по тегам чанка
// ============================================================

/**
 * Находит наиболее подходящую онтологию для чанка по его тегам.
 * Возвращает null, если ни одна не подошла — вызывающая сторона
 * должна использовать default (глобальные ENTITY_TYPES / RELATION_TYPES
 * и базовый промпт).
 *
 * Матчинг без учёта регистра; у чанка может быть несколько тегов —
 * берётся первая по priority подходящая онтология.
 */
export function resolveOntologyForTags(tags: string[] | null | undefined): DomainOntology | null {
  if (!tags || tags.length === 0) return null;
  const lower = new Set(tags.map(t => t.toLowerCase().trim()));
  for (const ont of DOMAIN_ONTOLOGIES) {
    for (const tag of ont.tags) {
      if (lower.has(tag)) return ont;
    }
  }
  return null;
}

/**
 * Разрешение онтологии для ПАЧКИ чанков: выбирается онтология с
 * максимальным суммарным priority по всем чанкам батча.
 * Если ни у одного чанка нет совпадений — возвращает null.
 */
export function resolveOntologyForBatch(
  chunksWithTags: Array<{ tags: string[] | null }>,
): DomainOntology | null {
  if (chunksWithTags.length === 0) return null;

  const votes = new Map<string, { ont: DomainOntology; score: number }>();
  for (const c of chunksWithTags) {
    const ont = resolveOntologyForTags(c.tags);
    if (!ont) continue;
    const prev = votes.get(ont.name);
    if (prev) prev.score += ont.priority;
    else votes.set(ont.name, { ont, score: ont.priority });
  }

  if (votes.size === 0) return null;

  let best: { ont: DomainOntology; score: number } | null = null;
  for (const v of votes.values()) {
    if (!best || v.score > best.score) best = v;
  }
  return best?.ont ?? null;
}

/**
 * Собирает доменно-специфичный промпт на базе общего: общий промпт
 * остаётся первым сообщением, а per-domain addendum приклеивается
 * в конец перед блоком с текстом чанков.
 */
export function buildDomainPromptAddendum(ontology: DomainOntology | null): string {
  if (!ontology) return '';
  const allowedEntities = ontology.entityTypes.join(', ');
  const allowedRelations = ontology.relationTypes.join(', ');
  return [
    '',
    '--- ДОМЕННЫЕ УКАЗАНИЯ ---',
    ontology.promptAddendum,
    '',
    `ПРИОРИТЕТНЫЕ ТИПЫ СУЩНОСТЕЙ для этого домена: ${allowedEntities}`,
    `ПРИОРИТЕТНЫЕ ТИПЫ СВЯЗЕЙ для этого домена: ${allowedRelations}`,
    'Типы из общего списка, не вошедшие в приоритетные, допустимы, но извлекай их только при явной необходимости.',
  ].join('\n');
}
