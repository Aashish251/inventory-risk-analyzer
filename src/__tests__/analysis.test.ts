import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../analysis.js';
import type { BusinessParams, InventoryEvent, Product } from '../types.js';

const params: BusinessParams = {
  reorderLeadTimeDays: 14,
  weeklyRevenueTarget: 50000,
  velocityWindowDays: 30,
};

const ASOF = new Date('2025-08-30T23:59:59Z');

/** Generates one sale event per day, `qtyPerDay` units, for `days` days ending on ASOF. */
function dailySales(sku: string, channel: string, qtyPerDay: number, days: number): InventoryEvent[] {
  const out: InventoryEvent[] = [];
  for (let i = 0; i < days; i++) {
    const t = new Date(ASOF.getTime() - i * 24 * 60 * 60 * 1000);
    out.push({ sku, channel, type: 'sale', quantity: qtyPerDay, timestamp: t.toISOString() });
  }
  return out;
}

function product(sku: string, overrides: Partial<Product> = {}): Product {
  return { sku, primaryChannel: 'Shopify', unitCost: 25, startingInventory: 0, ...overrides };
}

describe('runAnalysis - risk classification', () => {
  it('flags a SKU with sufficient inventory as OK and excludes it from recommendations', () => {
    // 5/day for 30 days = 150 sold; plenty of stock left relative to the 14-day lead time.
    const events = dailySales('SKU-OK', 'Amazon', 5, 30);
    const products = [product('SKU-OK', { startingInventory: 400 })];

    const result = runAnalysis(events, products, params, ASOF);
    const analysis = result.skuAnalyses[0];

    expect(analysis.riskLevel).toBe('OK');
    expect(analysis.currentStock).toBe(250);
    expect(result.recommendations.map((r) => r.sku)).not.toContain('SKU-OK');
  });

  it('flags a SKU nearing its stockout point as MODERATE', () => {
    // avg velocity 5/day; stock left gives ~16 days of cover vs a 14-day lead time
    // (inside the buffer, but thin enough to be worth watching).
    const events = dailySales('SKU-NEAR', 'Shopify', 5, 30);
    const products = [product('SKU-NEAR', { startingInventory: 230 })];

    const result = runAnalysis(events, products, params, ASOF);
    const analysis = result.skuAnalyses[0];

    expect(analysis.currentStock).toBe(80);
    expect(analysis.daysOfStockRemaining).toBeCloseTo(16, 1);
    expect(analysis.riskLevel).toBe('MODERATE');
    expect(analysis.reasoning.join(' ')).toContain('outlast the reorder lead time');
    expect(result.recommendations.map((r) => r.sku)).toContain('SKU-NEAR');
  });

  it('flags a SKU already at risk of stockout as HIGH (will run out before replenishment arrives)', () => {
    // ~10 days of cover vs a 14-day lead time.
    const events = dailySales('SKU-RISK', 'Amazon', 5, 30);
    const products = [product('SKU-RISK', { startingInventory: 200 })];

    const result = runAnalysis(events, products, params, ASOF);
    const analysis = result.skuAnalyses[0];

    expect(analysis.currentStock).toBe(50);
    expect(analysis.daysOfStockRemaining).toBeCloseTo(10, 1);
    expect(analysis.riskLevel).toBe('HIGH');
    expect(analysis.urgencyGapDays).toBeCloseTo(4, 1);
  });

  it('flags a SKU that has already stocked out as CRITICAL', () => {
    const events = dailySales('SKU-OUT', 'Shopify', 8, 20); // 160 units sold
    const products = [product('SKU-OUT', { startingInventory: 100 })]; // oversold -> clamped to 0

    const result = runAnalysis(events, products, params, ASOF);
    const analysis = result.skuAnalyses[0];

    expect(analysis.currentStock).toBe(0);
    expect(analysis.riskLevel).toBe('CRITICAL');
    expect(result.recommendations[0].sku).toBe('SKU-OUT');
  });

  it('handles a SKU with multiple mixed inventory events and computes the right position', () => {
    const events: InventoryEvent[] = [
      { sku: 'SKU-MIX', channel: 'Shopify', type: 'restock', quantity: 50, timestamp: '2025-08-01T00:00:00Z' },
      { sku: 'SKU-MIX', channel: 'Shopify', type: 'sale', quantity: 10, timestamp: '2025-08-05T00:00:00Z' },
      { sku: 'SKU-MIX', channel: 'Shopify', type: 'return', quantity: 3, timestamp: '2025-08-06T00:00:00Z' },
      { sku: 'SKU-MIX', channel: 'Shopify', type: 'sale', quantity: 8, timestamp: '2025-08-10T00:00:00Z' },
    ];
    const products = [product('SKU-MIX', { startingInventory: 60 })];

    const result = runAnalysis(events, products, params, ASOF);
    // 60 + 50 - 10 + 3 - 8 = 95
    expect(result.skuAnalyses[0].currentStock).toBe(95);
  });

  it('handles a SKU sold across multiple channels and reports a per-channel breakdown', () => {
    const events: InventoryEvent[] = [
      ...dailySales('SKU-MULTI', 'Shopify', 3, 10),
      ...dailySales('SKU-MULTI', 'Amazon', 2, 10),
    ];
    const products = [product('SKU-MULTI', { startingInventory: 500 })];

    const result = runAnalysis(events, products, params, ASOF);
    const analysis = result.skuAnalyses[0];

    expect(analysis.channelBreakdown).toHaveLength(2);
    const shopify = analysis.channelBreakdown.find((c) => c.channel === 'Shopify');
    const amazon = analysis.channelBreakdown.find((c) => c.channel === 'Amazon');
    expect(shopify?.totalUnitsSold).toBe(30);
    expect(amazon?.totalUnitsSold).toBe(20);
  });

  it('correctly applies a return event to increase available stock', () => {
    const events: InventoryEvent[] = [
      { sku: 'SKU-RET', channel: 'Shopify', type: 'sale', quantity: 20, timestamp: '2025-08-01T00:00:00Z' },
      { sku: 'SKU-RET', channel: 'Shopify', type: 'return', quantity: 7, timestamp: '2025-08-02T00:00:00Z' },
    ];
    const products = [product('SKU-RET', { startingInventory: 100 })];

    const result = runAnalysis(events, products, params, ASOF);
    expect(result.skuAnalyses[0].currentStock).toBe(87); // 100 - 20 + 7
  });

  it('correctly applies a restock event to increase available stock', () => {
    const events: InventoryEvent[] = [
      { sku: 'SKU-RESTOCK', channel: 'Shopify', type: 'sale', quantity: 20, timestamp: '2025-08-01T00:00:00Z' },
      { sku: 'SKU-RESTOCK', channel: 'Shopify', type: 'restock', quantity: 40, timestamp: '2025-08-02T00:00:00Z' },
    ];
    const products = [product('SKU-RESTOCK', { startingInventory: 100 })];

    const result = runAnalysis(events, products, params, ASOF);
    expect(result.skuAnalyses[0].currentStock).toBe(120); // 100 - 20 + 40
  });

  it('produces the same result regardless of the order events appear in the input array', () => {
    const chronological: InventoryEvent[] = [
      { sku: 'SKU-ORDER', channel: 'Shopify', type: 'restock', quantity: 50, timestamp: '2025-08-01T00:00:00Z' },
      { sku: 'SKU-ORDER', channel: 'Shopify', type: 'sale', quantity: 60, timestamp: '2025-08-10T00:00:00Z' },
      { sku: 'SKU-ORDER', channel: 'Shopify', type: 'restock', quantity: 30, timestamp: '2025-08-20T00:00:00Z' },
    ];
    const shuffled = [chronological[2], chronological[0], chronological[1]];
    const products = [product('SKU-ORDER', { startingInventory: 20 })];

    const inOrderResult = runAnalysis(chronological, products, params, ASOF);
    const shuffledResult = runAnalysis(shuffled, products, params, ASOF);

    // 20 + 50 - 60 + 30 = 40, and it must match regardless of array order
    expect(inOrderResult.skuAnalyses[0].currentStock).toBe(40);
    expect(shuffledResult.skuAnalyses[0].currentStock).toBe(40);
    expect(shuffledResult.skuAnalyses[0].currentStock).toBe(inOrderResult.skuAnalyses[0].currentStock);
  });

  it('ranks recommendations most-urgent-first across multiple SKUs', () => {
    const critical = dailySales('SKU-A-CRIT', 'Shopify', 10, 20); // will be clamped to 0 stock
    const high = dailySales('SKU-B-HIGH', 'Amazon', 5, 30); // ~10 days cover
    const ok = dailySales('SKU-C-OK', 'Amazon', 5, 30); // ~50 days cover

    const products = [
      product('SKU-A-CRIT', { startingInventory: 100 }),
      product('SKU-B-HIGH', { startingInventory: 200 }),
      product('SKU-C-OK', { startingInventory: 400 }),
    ];

    const result = runAnalysis([...critical, ...high, ...ok], products, params, ASOF);

    expect(result.recommendations.map((r) => r.sku)).toEqual(['SKU-A-CRIT', 'SKU-B-HIGH']);
    expect(result.recommendations[0].riskLevel).toBe('CRITICAL');
    expect(result.recommendations[1].riskLevel).toBe('HIGH');
  });

  it('ignores duplicate events so they do not double-count stock movements', () => {
    const saleEvent: InventoryEvent = {
      sku: 'SKU-DUP',
      channel: 'Shopify',
      type: 'sale',
      quantity: 10,
      timestamp: '2025-08-01T00:00:00Z',
    };
    const products = [product('SKU-DUP', { startingInventory: 100 })];

    const result = runAnalysis([saleEvent, { ...saleEvent }], products, params, ASOF);

    expect(result.skuAnalyses[0].currentStock).toBe(90); // only one sale counted, not two
    expect(result.globalWarnings.some((w) => w.includes('Duplicate'))).toBe(true);
  });

  it('surfaces malformed events as warnings rather than crashing', () => {
    const badEvents: unknown[] = [{ sku: 'SKU-BAD', type: 'not-a-real-type', quantity: 5, timestamp: '2025-08-01T00:00:00Z' }];
    const products = [product('SKU-BAD', { startingInventory: 10 })];

    const result = runAnalysis(badEvents, products, params, ASOF);

    expect(result.skuAnalyses[0].currentStock).toBe(10); // event was skipped, starting stock unchanged
    expect(result.globalWarnings.length).toBeGreaterThan(0);
  });
});
