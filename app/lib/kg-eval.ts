// ============================================================
// Knowledge Graph — evaluation helpers.
// ============================================================
// Сравнивает выход extractor'а с золотым датасетом и считает
// precision / recall / F1 по сущностям и связям. Используется
// admin-эндпоинтом /api/admin/kg-eval и может применяться как
// unit-test в будущем.
// ============================================================

/** Нормализация имени для нечувствительного к регистру/пробелам сравнения. */
export function normalizeName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[«»"']/g, '')
    .replace(/\s*[–—-]\s*/g, '-');
}

export interface EvalEntity {
  name: string;
  type: string;
  description?: string;
}

export interface EvalRelation {
  source: string;
  target: string;
  type: string;
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Metrics extends ConfusionCounts {
  precision: number;
  recall: number;
  f1: number;
}

/** Precision = TP / (TP + FP). Пустой предикт с пустым эталоном → 1.0. */
export function precision(c: ConfusionCounts): number {
  const d = c.tp + c.fp;
  return d === 0 ? 1 : c.tp / d;
}

/** Recall = TP / (TP + FN). Пустой эталон с пустым предиктом → 1.0. */
export function recall(c: ConfusionCounts): number {
  const d = c.tp + c.fn;
  return d === 0 ? 1 : c.tp / d;
}

export function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function toMetrics(c: ConfusionCounts): Metrics {
  const p = precision(c);
  const r = recall(c);
  return { ...c, precision: p, recall: r, f1: f1(p, r) };
}

export function addConfusion(a: ConfusionCounts, b: ConfusionCounts): ConfusionCounts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

// ============================================================
// Сравнение сущностей: ключ = `${normalize(name)}::${type}`
// ============================================================

function entityKey(e: EvalEntity): string {
  return `${normalizeName(e.name)}::${e.type}`;
}

export interface EntityEvalResult {
  total: Metrics;
  byType: Record<string, Metrics>;
  missing: EvalEntity[];      // in expected, not in predicted (FN detail)
  spurious: EvalEntity[];     // in predicted, not in expected (FP detail)
}

export function scoreEntities(
  expected: EvalEntity[],
  predicted: EvalEntity[],
): EntityEvalResult {
  const expMap = new Map<string, EvalEntity>();
  for (const e of expected) {
    if (e && e.name && e.type) expMap.set(entityKey(e), e);
  }
  const predMap = new Map<string, EvalEntity>();
  for (const e of predicted) {
    if (e && e.name && e.type) predMap.set(entityKey(e), e);
  }

  const byTypeConf = new Map<string, ConfusionCounts>();
  const bump = (type: string, field: keyof ConfusionCounts) => {
    const cur = byTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
    cur[field] += 1;
    byTypeConf.set(type, cur);
  };

  const missing: EvalEntity[] = [];
  const spurious: EvalEntity[] = [];
  let tp = 0, fp = 0, fn = 0;

  for (const [k, pred] of predMap) {
    if (expMap.has(k)) {
      tp++;
      bump(pred.type, 'tp');
    } else {
      fp++;
      bump(pred.type, 'fp');
      spurious.push(pred);
    }
  }
  for (const [k, exp] of expMap) {
    if (!predMap.has(k)) {
      fn++;
      bump(exp.type, 'fn');
      missing.push(exp);
    }
  }

  const byType: Record<string, Metrics> = {};
  for (const [type, c] of byTypeConf) byType[type] = toMetrics(c);

  return {
    total: toMetrics({ tp, fp, fn }),
    byType,
    missing,
    spurious,
  };
}

// ============================================================
// Сравнение связей: ключ = `${norm(src)}→${norm(tgt)}::${type}`
// ============================================================

function relationKey(r: EvalRelation): string {
  return `${normalizeName(r.source)}→${normalizeName(r.target)}::${r.type}`;
}

export interface RelationEvalResult {
  total: Metrics;
  byType: Record<string, Metrics>;
}

export function scoreRelations(
  expected: EvalRelation[],
  predicted: EvalRelation[],
): RelationEvalResult {
  const expSet = new Set<string>();
  for (const r of expected) {
    if (r && r.source && r.target && r.type) expSet.add(relationKey(r));
  }
  const predSet = new Set<string>();
  const predByKey = new Map<string, EvalRelation>();
  for (const r of predicted) {
    if (r && r.source && r.target && r.type) {
      predSet.add(relationKey(r));
      predByKey.set(relationKey(r), r);
    }
  }

  const byTypeConf = new Map<string, ConfusionCounts>();
  const bump = (type: string, field: keyof ConfusionCounts) => {
    const cur = byTypeConf.get(type) ?? { tp: 0, fp: 0, fn: 0 };
    cur[field] += 1;
    byTypeConf.set(type, cur);
  };

  let tp = 0, fp = 0, fn = 0;
  for (const k of predSet) {
    const type = predByKey.get(k)?.type ?? 'unknown';
    if (expSet.has(k)) { tp++; bump(type, 'tp'); }
    else { fp++; bump(type, 'fp'); }
  }
  for (const r of expected) {
    if (!r || !r.source || !r.target || !r.type) continue;
    if (!predSet.has(relationKey(r))) { fn++; bump(r.type, 'fn'); }
  }

  const byType: Record<string, Metrics> = {};
  for (const [type, c] of byTypeConf) byType[type] = toMetrics(c);

  return { total: toMetrics({ tp, fp, fn }), byType };
}
