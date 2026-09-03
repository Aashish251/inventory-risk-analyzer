import { describe, expect, it } from 'vitest';
import { deduplicateEvents, processSkuLedger, validateEvents } from '../inventoryLedger.js';
import type { InventoryEvent } from '../types.js';

function ev(partial: Partial<InventoryEvent>): InventoryEvent {
  return {
    sku: 'SKU-X',
    channel: 'Shopify',
    type: 'sale',
    quantity: 1,
    timestamp: '2025-08-01T00:00:00.000Z',
    ...partial,
  } as InventoryEvent;
}

describe('validateEvents', () => {
  it('accepts well-formed events and normalizes the timestamp', () => {
    const { events, warnings } = validateEvents([
      { sku: 'SKU-1', channel: 'Shopify', type: 'sale', quantity: 5, timestamp: '2025-08-01T00:00:00Z' },
    ]);
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].sku).toBe('SKU-1');
  });

  it('drops events with missing sku, bad type, bad quantity, or bad timestamp, with a warning each', () => {
    const { events, warnings } = validateEvents([
      { channel: 'Shopify', type: 'sale', quantity: 5, timestamp: '2025-08-01T00:00:00Z' }, // no sku
      { sku: 'SKU-1', channel: 'Shopify', type: 'teleport', quantity: 5, timestamp: '2025-08-01T00:00:00Z' }, // bad type
      { sku: 'SKU-1', channel: 'Shopify', type: 'sale', quantity: 'five', timestamp: '2025-08-01T00:00:00Z' }, // bad quantity
      { sku: 'SKU-1', channel: 'Shopify', type: 'sale', quantity: 5, timestamp: 'not-a-date' }, // bad timestamp
      { sku: 'SKU-1', channel: 'Shopify', type: 'sale', quantity: -5, timestamp: '2025-08-01T00:00:00Z' }, // negative sale qty
    ]);
    expect(events).toHaveLength(0);
    expect(warnings).toHaveLength(5);
  });

  it('defaults a missing channel to "Unknown" rather than dropping the event', () => {
    const { events, warnings } = validateEvents([
      { sku: 'SKU-1', type: 'sale', quantity: 5, timestamp: '2025-08-01T00:00:00Z' },
    ]);
    expect(warnings).toHaveLength(0);
    expect(events[0].channel).toBe('Unknown');
  });

  it('allows negative quantities for adjustment events', () => {
    const { events, warnings } = validateEvents([
      { sku: 'SKU-1', channel: 'Shopify', type: 'adjustment', quantity: -3, timestamp: '2025-08-01T00:00:00Z' },
    ]);
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
  });
});

describe('deduplicateEvents', () => {
  it('drops exact duplicate events but keeps distinct ones', () => {
    const a = ev({ timestamp: '2025-08-01T00:00:00.000Z' });
    const b = { ...a };
    const c = ev({ timestamp: '2025-08-02T00:00:00.000Z' });

    const { events, warnings } = deduplicateEvents([a, b, c]);
    expect(events).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});

describe('processSkuLedger', () => {
  it('handles a restock event by increasing stock', () => {
    const result = processSkuLedger('SKU-1', [ev({ type: 'restock', quantity: 40 })], 60);
    expect(result.currentStock).toBe(100);
  });

  it('handles a return event by increasing stock', () => {
    const result = processSkuLedger('SKU-1', [ev({ type: 'return', quantity: 4 })], 60);
    expect(result.currentStock).toBe(64);
  });

  it('handles a sale event by decreasing stock and recording it for velocity', () => {
    const result = processSkuLedger('SKU-1', [ev({ type: 'sale', quantity: 10, channel: 'Amazon' })], 60);
    expect(result.currentStock).toBe(50);
    expect(result.saleEvents).toEqual([{ channel: 'Amazon', quantity: 10, timestamp: '2025-08-01T00:00:00.000Z' }]);
  });

  it('processes multiple mixed events (sale, return, restock) correctly', () => {
    const events = [
      ev({ type: 'sale', quantity: 20, timestamp: '2025-08-01T00:00:00.000Z' }),
      ev({ type: 'return', quantity: 5, timestamp: '2025-08-02T00:00:00.000Z' }),
      ev({ type: 'restock', quantity: 30, timestamp: '2025-08-03T00:00:00.000Z' }),
      ev({ type: 'sale', quantity: 10, timestamp: '2025-08-04T00:00:00.000Z' }),
    ];
    // 100 - 20 + 5 + 30 - 10 = 105
    const result = processSkuLedger('SKU-1', events, 100);
    expect(result.currentStock).toBe(105);
  });

  it('handles events from multiple channels, tracking each sale with its own channel', () => {
    const events = [
      ev({ type: 'sale', quantity: 10, channel: 'Shopify', timestamp: '2025-08-01T00:00:00.000Z' }),
      ev({ type: 'sale', quantity: 6, channel: 'Amazon', timestamp: '2025-08-02T00:00:00.000Z' }),
      ev({ type: 'sale', quantity: 4, channel: 'Flipkart', timestamp: '2025-08-03T00:00:00.000Z' }),
    ];
    const result = processSkuLedger('SKU-1', events, 100);
    expect(result.currentStock).toBe(80);
    const channels = result.saleEvents.map((s) => s.channel).sort();
    expect(channels).toEqual(['Amazon', 'Flipkart', 'Shopify']);
  });

  it('processes events in chronological order even when the input array is shuffled', () => {
    // Correct order: restock first (+50), then a sale of 60 should be safely covered.
    // If processed in *input* order instead, the sale would be applied before the
    // restock and the ledger would (incorrectly) go negative.
    const outOfOrderInput = [
      ev({ type: 'sale', quantity: 60, timestamp: '2025-08-10T00:00:00.000Z' }),
      ev({ type: 'restock', quantity: 50, timestamp: '2025-08-01T00:00:00.000Z' }),
    ];
    const result = processSkuLedger('SKU-1', outOfOrderInput, 20);
    // 20 + 50 - 60 = 10, and never dips negative along the way
    expect(result.currentStock).toBe(10);
    expect(result.warnings).toHaveLength(0);
  });

  it('treats a "stockout" event as an authoritative checkpoint and warns on mismatch', () => {
    const events = [
      ev({ type: 'sale', quantity: 5, timestamp: '2025-08-01T00:00:00.000Z' }), // 100 -> 95
      ev({ type: 'stockout', quantity: 0, timestamp: '2025-08-02T00:00:00.000Z' }), // checkpoint -> 0
      ev({ type: 'restock', quantity: 20, timestamp: '2025-08-03T00:00:00.000Z' }), // -> 20
    ];
    const result = processSkuLedger('SKU-1', events, 100);
    expect(result.currentStock).toBe(20);
    expect(result.warnings.some((w) => w.includes('stockout'))).toBe(true);
  });

  it('treats a "stock_snapshot" event as an authoritative checkpoint and continues from it', () => {
    const events = [
      ev({ type: 'sale', quantity: 10, timestamp: '2025-08-01T00:00:00.000Z' }),
      ev({ type: 'stock_snapshot', quantity: 50, timestamp: '2025-08-02T00:00:00.000Z' }),
      ev({ type: 'sale', quantity: 5, timestamp: '2025-08-03T00:00:00.000Z' }),
    ];
    const result = processSkuLedger('SKU-1', events, 100);
    expect(result.currentStock).toBe(45);
    expect(result.warnings.some((w) => w.includes('stock snapshot'))).toBe(true);
  });

  it('clamps a negative computed position to 0 and warns about it', () => {
    const events = [ev({ type: 'sale', quantity: 999, timestamp: '2025-08-01T00:00:00.000Z' })];
    const result = processSkuLedger('SKU-1', events, 10);
    expect(result.currentStock).toBe(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes('negative'))).toBe(true);
  });
});
