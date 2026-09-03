// One-off generator for data/inventory_events.json. Not part of the shipped
// application - just used to build a realistic, hand-checkable demo dataset.
import { writeFileSync } from 'node:fs';

const events = [];
const iso = (d) => new Date(d).toISOString();

function dailySales(sku, channel, qtyPerDay, startDay, endDay, month = '2025-08') {
  for (let d = startDay; d <= endDay; d++) {
    events.push({
      sku,
      channel,
      type: 'sale',
      quantity: qtyPerDay,
      timestamp: iso(`${month}-${String(d).padStart(2, '0')}T09:00:00Z`),
    });
  }
}

// SKU-001: steady seller, nearing its stockout point (MODERATE)
// start 230, sells 5/day for all 30 days -> 80 left, ~16 days of cover vs 14-day lead time
dailySales('SKU-001', 'Shopify', 5, 1, 30);

// SKU-002: already at risk of stockout (HIGH)
// start 200, sells 5/day for all 30 days -> 50 left, ~10 days of cover vs 14-day lead time
dailySales('SKU-002', 'Amazon', 5, 1, 30);

// SKU-003: healthy stock, should NOT be flagged (OK)
// start 400, sells 5/day for all 30 days -> 250 left, ~50 days of cover
dailySales('SKU-003', 'Amazon', 5, 1, 30);

// SKU-004: exercises multiple events, a return, a restock, and multiple channels.
// start 60
events.push({ sku: 'SKU-004', channel: 'Flipkart', type: 'restock', quantity: 50, timestamp: iso('2025-08-01T08:00:00Z') }); // -> 110
events.push({ sku: 'SKU-004', channel: 'Flipkart', type: 'sale', quantity: 10, timestamp: iso('2025-08-05T10:00:00Z') }); // -> 100
events.push({ sku: 'SKU-004', channel: 'Flipkart', type: 'return', quantity: 3, timestamp: iso('2025-08-06T11:00:00Z') }); // -> 103
events.push({ sku: 'SKU-004', channel: 'Amazon', type: 'sale', quantity: 8, timestamp: iso('2025-08-10T10:00:00Z') }); // -> 95
events.push({ sku: 'SKU-004', channel: 'Flipkart', type: 'restock', quantity: 20, timestamp: iso('2025-08-15T08:00:00Z') }); // -> 115
events.push({ sku: 'SKU-004', channel: 'Flipkart', type: 'sale', quantity: 15, timestamp: iso('2025-08-20T10:00:00Z') }); // -> 100
events.push({ sku: 'SKU-004', channel: 'Amazon', type: 'sale', quantity: 12, timestamp: iso('2025-08-25T10:00:00Z') }); // -> 88

// SKU-005: already out of stock (CRITICAL), including an oversell that a "stockout"
// event has to correct - exercises the ledger's checkpoint / warning behavior.
// start 100
dailySales('SKU-005', 'Shopify', 8, 1, 12); // 100 - 96 = 4
events.push({ sku: 'SKU-005', channel: 'Shopify', type: 'sale', quantity: 10, timestamp: iso('2025-08-13T09:00:00Z') }); // would be -6
events.push({ sku: 'SKU-005', channel: 'Shopify', type: 'stockout', quantity: 0, timestamp: iso('2025-08-13T12:00:00Z') }); // checkpoint -> 0

// Duplicate events on purpose (identical sku/channel/type/quantity/timestamp) to
// demonstrate defensive deduplication.
events.push({ ...events[0] });
events.push({ sku: 'SKU-002', channel: 'Amazon', type: 'sale', quantity: 5, timestamp: iso('2025-08-10T09:00:00Z') });
events.push({ sku: 'SKU-002', channel: 'Amazon', type: 'sale', quantity: 5, timestamp: iso('2025-08-10T09:00:00Z') });

// Shuffle deterministically so the file also demonstrates out-of-order event handling.
function seededShuffle(arr, seed = 42) {
  const a = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const shuffled = seededShuffle(events);
writeFileSync(new URL('../data/inventory_events.json', import.meta.url), JSON.stringify(shuffled, null, 2) + '\n');
console.log(`Wrote ${shuffled.length} events.`);
