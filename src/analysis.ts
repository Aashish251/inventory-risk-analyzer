import { deduplicateEvents, groupBySku, processSkuLedger, validateEvents } from './inventoryLedger.js';
import { analyzeSku } from './riskAnalyzer.js';
import type { BusinessParams, Product, SkuAnalysis } from './types.js';

export const DEFAULT_PARAMS: BusinessParams = {
  reorderLeadTimeDays: 14,
  weeklyRevenueTarget: 50000,
  velocityWindowDays: 30,
};

export interface AnalysisResult {
  skuAnalyses: SkuAnalysis[];
  /** At-risk SKUs only, ordered most-urgent-first: the actionable reorder list. */
  recommendations: SkuAnalysis[];
  globalWarnings: string[];
  asOf: Date;
}

const RISK_RANK: Record<SkuAnalysis['riskLevel'], number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, OK: 3 };

/**
 * Runs the full pipeline: validate -> dedupe -> replay per-SKU ledger -> compute
 * velocity & risk -> rank recommendations.
 *
 * @param asOf Reference "today" for velocity/urgency math. Defaults to the latest
 *   timestamp seen in the event log, which keeps historical data deterministic to
 *   analyze (rather than silently depending on the wall-clock date it's run on).
 */
export function runAnalysis(
  rawEvents: unknown[],
  products: Product[],
  params: BusinessParams = DEFAULT_PARAMS,
  asOf?: Date
): AnalysisResult {
  const { events: validated, warnings: validationWarnings } = validateEvents(rawEvents);
  const { events: deduped, warnings: dedupeWarnings } = deduplicateEvents(validated);
  const bySku = groupBySku(deduped);

  const effectiveAsOf = asOf ?? computeAsOf(deduped);

  const skuAnalyses: SkuAnalysis[] = products.map((product) => {
    const events = bySku.get(product.sku) ?? [];
    const processed = processSkuLedger(product.sku, events, product.startingInventory);
    return analyzeSku(processed, product, params, effectiveAsOf);
  });

  const recommendations = skuAnalyses
    .filter((a) => a.riskLevel !== 'OK')
    .sort((a, b) => {
      const rankDiff = RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
      if (rankDiff !== 0) return rankDiff;
      const gapDiff = b.urgencyGapDays - a.urgencyGapDays;
      if (gapDiff !== 0) return gapDiff;
      return b.revenueAtRisk - a.revenueAtRisk;
    });

  return {
    skuAnalyses,
    recommendations,
    globalWarnings: [...validationWarnings, ...dedupeWarnings],
    asOf: effectiveAsOf,
  };
}

function computeAsOf(events: { timestamp: string }[]): Date {
  if (events.length === 0) return new Date();
  const max = Math.max(...events.map((e) => Date.parse(e.timestamp)));
  return new Date(max);
}
