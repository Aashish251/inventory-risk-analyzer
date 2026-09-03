import type { BusinessParams, ChannelVelocity, Product, RiskLevel, SkuAnalysis } from './types.js';
import type { ProcessedSku } from './inventoryLedger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface VelocityResult {
  avgDailySales: number;
  channelBreakdown: ChannelVelocity[];
  usedFallback: boolean;
}

/**
 * Computes average daily sales over a trailing window ending at `asOf`. If there were
 * no sales in that window at all (e.g. a slow-moving SKU), falls back to the SKU's
 * entire sales history so a real seller isn't misreported as having zero velocity.
 */
function computeVelocity(saleEvents: ProcessedSku['saleEvents'], asOf: Date, windowDays: number): VelocityResult {
  const windowStartMs = asOf.getTime() - windowDays * DAY_MS;

  let relevant = saleEvents.filter((s) => {
    const t = new Date(s.timestamp).getTime();
    return t > windowStartMs && t <= asOf.getTime();
  });

  let usedFallback = false;
  let effectiveDays = windowDays;

  if (relevant.length === 0 && saleEvents.length > 0) {
    usedFallback = true;
    relevant = saleEvents;
    const timestamps = relevant.map((s) => new Date(s.timestamp).getTime());
    const spanDays = (Math.max(...timestamps) - Math.min(...timestamps)) / DAY_MS;
    effectiveDays = Math.max(spanDays, 1);
  }

  const totalSold = relevant.reduce((sum, s) => sum + s.quantity, 0);
  const avgDailySales = relevant.length > 0 ? totalSold / effectiveDays : 0;

  const byChannel = new Map<string, number>();
  for (const s of relevant) {
    byChannel.set(s.channel, (byChannel.get(s.channel) ?? 0) + s.quantity);
  }

  const channelBreakdown: ChannelVelocity[] = [...byChannel.entries()].map(([channel, units]) => ({
    channel,
    totalUnitsSold: units,
    avgDailySales: units / effectiveDays,
  }));

  return { avgDailySales, channelBreakdown, usedFallback };
}

/**
 * Risk tiers, in increasing order of safety margin over the reorder lead time:
 *   CRITICAL - already out of stock, OR will run out at/before half the lead time has passed
 *   HIGH     - will run out before the reorder can arrive, but after the halfway point
 *   MODERATE - will *just* outlast the lead time (within a 25% buffer) - worth watching
 *   OK       - comfortable buffer beyond the lead time
 */
function classifyRisk(currentStock: number, daysOfStockRemaining: number | null, leadTimeDays: number): RiskLevel {
  if (currentStock <= 0) return 'CRITICAL';
  if (daysOfStockRemaining === null) return 'OK'; // no sales velocity data to project urgency from
  if (daysOfStockRemaining <= leadTimeDays * 0.5) return 'CRITICAL';
  if (daysOfStockRemaining <= leadTimeDays) return 'HIGH';
  if (daysOfStockRemaining <= leadTimeDays * 1.25) return 'MODERATE';
  return 'OK';
}

export function analyzeSku(processed: ProcessedSku, product: Product, params: BusinessParams, asOf: Date): SkuAnalysis {
  const { avgDailySales, channelBreakdown, usedFallback } = computeVelocity(
    processed.saleEvents,
    asOf,
    params.velocityWindowDays
  );

  const daysOfStockRemaining = avgDailySales > 0 ? processed.currentStock / avgDailySales : null;
  const expectedDemandDuringLeadTime = avgDailySales * params.reorderLeadTimeDays;
  const urgencyGapDays =
    daysOfStockRemaining === null ? -Infinity : params.reorderLeadTimeDays - daysOfStockRemaining;

  const riskLevel = classifyRisk(processed.currentStock, daysOfStockRemaining, params.reorderLeadTimeDays);

  const revenueAtRisk =
    Number.isFinite(urgencyGapDays) && urgencyGapDays > 0 ? product.unitCost * avgDailySales * urgencyGapDays : 0;

  const reasoning: string[] = [];
  reasoning.push(`Current stock is ${processed.currentStock} unit(s) after processing all inventory events.`);

  if (avgDailySales > 0) {
    reasoning.push(
      `Recent sales velocity is ~${avgDailySales.toFixed(2)} units/day` +
        (usedFallback
          ? ` (estimated from the full sales history, since there were no sales in the last ${params.velocityWindowDays} days).`
          : `.`)
    );
    if (channelBreakdown.length > 1) {
      const parts = channelBreakdown
        .slice()
        .sort((a, b) => b.avgDailySales - a.avgDailySales)
        .map((c) => `${c.channel} ~${c.avgDailySales.toFixed(2)}/day`);
      reasoning.push(`This SKU sells across multiple channels: ${parts.join(', ')}.`);
    }
    reasoning.push(
      `At this rate, expected demand over the ${params.reorderLeadTimeDays}-day reorder lead time is ~${expectedDemandDuringLeadTime.toFixed(
        1
      )} units.`
    );
    if (daysOfStockRemaining !== null) {
      reasoning.push(`Current stock covers approximately ${daysOfStockRemaining.toFixed(1)} day(s) of sales.`);
    }
    if (urgencyGapDays > 0) {
      reasoning.push(
        `At the current pace, stock is projected to run out ~${urgencyGapDays.toFixed(
          1
        )} day(s) before a reorder placed today could arrive - this SKU needs attention.`
      );
    } else if (riskLevel === 'MODERATE') {
      reasoning.push(
        `Stock is projected to outlast the reorder lead time, but only by ~${Math.abs(urgencyGapDays).toFixed(
          1
        )} day(s), so it is inside the watch buffer.`
      );
    } else {
      reasoning.push(`Stock comfortably outlasts the reorder lead time, so no action is needed right now.`);
    }
  } else {
    reasoning.push(`No sales history is available for this SKU, so stockout timing can't be projected from velocity.`);
  }

  if (processed.currentStock <= 0) {
    reasoning.unshift(`This SKU is already out of stock.`);
  }

  return {
    sku: processed.sku,
    currentStock: processed.currentStock,
    avgDailySales,
    channelBreakdown,
    daysOfStockRemaining,
    expectedDemandDuringLeadTime,
    urgencyGapDays,
    revenueAtRisk,
    riskLevel,
    reasoning,
    warnings: processed.warnings,
  };
}
