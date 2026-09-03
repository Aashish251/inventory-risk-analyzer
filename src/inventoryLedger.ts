import type { InventoryEvent } from './types.js';

export interface ProcessedSku {
  sku: string;
  currentStock: number;
  saleEvents: { channel: string; quantity: number; timestamp: string }[];
  warnings: string[];
}

const VALID_TYPES = new Set(['sale', 'return', 'restock', 'stockout', 'stock_snapshot', 'adjustment']);

/**
 * Validates raw, untrusted event input. Anything malformed is dropped (not thrown),
 * with a human-readable warning explaining what was skipped and why. This keeps the
 * tool robust against the "missing / malformed" events the requirements call out.
 */
export function validateEvents(rawEvents: unknown[]): { events: InventoryEvent[]; warnings: string[] } {
  const events: InventoryEvent[] = [];
  const warnings: string[] = [];

  rawEvents.forEach((raw, i) => {
    const e = raw as Partial<InventoryEvent> | null | undefined;

    if (!e || typeof e !== 'object') {
      warnings.push(`Event at index ${i} is not a valid object; skipped.`);
      return;
    }
    if (!e.sku || typeof e.sku !== 'string') {
      warnings.push(`Event at index ${i} is missing a valid "sku"; skipped.`);
      return;
    }
    if (!e.type || !VALID_TYPES.has(e.type)) {
      warnings.push(`Event at index ${i} (sku ${e.sku}) has an unknown type "${String(e.type)}"; skipped.`);
      return;
    }
    if (typeof e.quantity !== 'number' || Number.isNaN(e.quantity)) {
      warnings.push(`Event at index ${i} (sku ${e.sku}) has an invalid quantity; skipped.`);
      return;
    }
    if (e.type !== 'adjustment' && e.quantity < 0) {
      warnings.push(
        `Event at index ${i} (sku ${e.sku}) has a negative quantity for type "${e.type}"; skipped (use "adjustment" for signed corrections).`
      );
      return;
    }
    if (!e.timestamp || Number.isNaN(Date.parse(e.timestamp))) {
      warnings.push(`Event at index ${i} (sku ${e.sku}) has an invalid/missing timestamp; skipped.`);
      return;
    }

    const channel = typeof e.channel === 'string' && e.channel.trim().length > 0 ? e.channel : 'Unknown';

    events.push({
      sku: e.sku,
      channel,
      type: e.type as InventoryEvent['type'],
      quantity: e.quantity,
      timestamp: new Date(e.timestamp).toISOString(),
    });
  });

  return { events, warnings };
}

/**
 * Drops exact duplicate events (same sku/channel/type/quantity/timestamp). This is the
 * simplest defensible definition of "duplicate" given the requirements don't specify an
 * event id -- see README for the reasoning and its limits.
 */
export function deduplicateEvents(events: InventoryEvent[]): { events: InventoryEvent[]; warnings: string[] } {
  const seen = new Set<string>();
  const out: InventoryEvent[] = [];
  const warnings: string[] = [];

  for (const e of events) {
    const key = `${e.sku}|${e.channel}|${e.type}|${e.quantity}|${e.timestamp}`;
    if (seen.has(key)) {
      warnings.push(`Duplicate event ignored: ${e.sku} ${e.type} ${e.quantity}u on ${e.channel} at ${e.timestamp}.`);
      continue;
    }
    seen.add(key);
    out.push(e);
  }

  return { events: out, warnings };
}

export function groupBySku(events: InventoryEvent[]): Map<string, InventoryEvent[]> {
  const map = new Map<string, InventoryEvent[]>();
  for (const e of events) {
    let list = map.get(e.sku);
    if (!list) {
      list = [];
      map.set(e.sku, list);
    }
    list.push(e);
  }
  return map;
}

// When two events land on the exact same timestamp, apply replenishments before sales.
// This is a deterministic tie-break, not a real ordering signal -- see README.
const TYPE_TIE_BREAK: Record<string, number> = {
  restock: 0,
  return: 1,
  stock_snapshot: 2,
  adjustment: 3,
  sale: 4,
  stockout: 5,
};

function sortChronologically(events: InventoryEvent[]): InventoryEvent[] {
  // Cache parsed timestamps to avoid repeated Date.parse calls during sort comparisons.
  const tsCache = new Map<string, number>();
  const getTs = (iso: string): number => {
    let v = tsCache.get(iso);
    if (v === undefined) {
      v = Date.parse(iso);
      tsCache.set(iso, v);
    }
    return v;
  };

  return [...events].sort((a, b) => {
    const diff = getTs(a.timestamp) - getTs(b.timestamp);
    if (diff !== 0) return diff;
    return (TYPE_TIE_BREAK[a.type] ?? 9) - (TYPE_TIE_BREAK[b.type] ?? 9);
  });
}

/**
 * Replays one SKU's events in chronological order (regardless of input order) and
 * returns the resulting stock position, plus the sale history needed for velocity.
 *
 * "stockout" and "stock_snapshot" events are authoritative checkpoints: whatever
 * the running total was, actual stock matched the checkpoint at that instant. This
 * makes the ledger self-healing against upstream drift (e.g. a missed sale or
 * restock earlier in the log).
 */
export function processSkuLedger(sku: string, events: InventoryEvent[], startingInventory: number): ProcessedSku {
  const warnings: string[] = [];
  const sorted = sortChronologically(events);
  const saleEvents: ProcessedSku['saleEvents'] = [];

  let running = startingInventory;

  for (const e of sorted) {
    switch (e.type) {
      case 'restock':
      case 'return':
      case 'adjustment':
        running += e.quantity;
        break;
      case 'sale':
        running -= e.quantity;
        saleEvents.push({ channel: e.channel, quantity: e.quantity, timestamp: e.timestamp });
        break;
      case 'stockout':
        if (running > 0) {
          warnings.push(
            `"${sku}" had a stockout event at ${e.timestamp} but ${running} units were computed from prior events; ` +
              `treating the stockout as authoritative and resetting stock to 0 at that point.`
          );
        } else if (running < 0) {
          warnings.push(
            `"${sku}" had a stockout event at ${e.timestamp} after prior events computed to ${running} units ` +
              `(more units sold than were ever recorded in stock); treating the stockout as authoritative and resetting stock to 0 at that point.`
          );
        }
        running = 0;
        break;
      case 'stock_snapshot':
        if (running !== e.quantity) {
          warnings.push(
            `"${sku}" had a stock snapshot of ${e.quantity} unit(s) at ${e.timestamp} but ${running} units were computed from prior events; ` +
              `treating the snapshot as authoritative.`
          );
        }
        running = e.quantity;
        break;
    }
  }

  if (running < 0) {
    warnings.push(
      `"${sku}" computed a negative stock position (${running}); this points to oversold or missing restock data. Clamped to 0.`
    );
    running = 0;
  }

  return { sku, currentStock: running, saleEvents, warnings };
}
