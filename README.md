# Inventory Stockout Risk Analyzer

Identifies which SKUs are likely to run out of stock **before** a reorder
placed today could arrive, and ranks them so a purchasing team knows what to
reorder first - and why.

## Quick start

```bash
npm install
npm test                # run the automated test suite
npm start -- data/inventory_events.json data/products.json
```

`npm start` runs the CLI against the bundled sample dataset (`data/`), which
demonstrates every scenario described below. Point it at your own files the
same way:

```bash
npm start -- path/to/inventory_events.json path/to/products.json
```

Optional flags:

```bash
npm start -- events.json products.json \
  --lead-time 14 \          # reorder_lead_time_days (default 14)
  --window 30 \              # trailing days of sales used for velocity (default 30)
  --revenue-target 50000 \   # weekly_revenue_target, echoed in the report (default 50000)
  --as-of 2025-08-30T00:00:00Z   # analyze "as of" this date instead of the log's latest event
```

## Project layout

```
src/
  types.ts            shared types: events, products, params, analysis output
  inventoryLedger.ts   validation, deduplication, chronological replay per SKU
  riskAnalyzer.ts      sales velocity + stockout risk classification for one SKU
  analysis.ts          orchestration: runs the pipeline, ranks recommendations
  main.ts              CLI entry point (reads JSON, prints the report)
  __tests__/           automated tests (vitest)
data/
  inventory_events.json  sample event log covering every required test scenario
  products.json           sample product master data
```

Business logic (`inventoryLedger.ts`, `riskAnalyzer.ts`, `analysis.ts`) is
kept independent of I/O - `main.ts` is the only file that touches the
filesystem or `process.argv`, so the analysis functions are directly
unit-testable and reusable (e.g. behind a future HTTP endpoint).

## Input format

**`inventory_events.json`** - an array of events:

```json
{
  "sku": "SKU-001",
  "channel": "Shopify",
  "type": "sale",
  "quantity": 10,
  "timestamp": "2025-08-01T10:00:00Z"
}
```

`type` is one of `sale`, `return`, `restock`, `stockout`, `stock_snapshot`, `adjustment`.
- `sale` / `return` / `restock` use a non-negative `quantity`.
- `adjustment` is a **signed delta** (can be negative), for manual stock
  corrections that don't fit the other categories.
- `stockout` means "inventory is known to be zero at this instant" - its
  `quantity` is ignored.
- `stock_snapshot` means "inventory is known to equal `quantity` at this
  instant" and is treated as an authoritative checkpoint.

**`products.json`** - an array of product master records:

```json
{ "sku": "SKU-001", "primaryChannel": "Shopify", "unitCost": 25, "startingInventory": 230 }
```

`startingInventory` is the stock position immediately before the first event
in the log (i.e. the log is a delta stream, not a snapshot).

## Output format

The CLI prints:
1. **Reorder priority** - at-risk SKUs only, most urgent first, each with its
   risk tier, days of stock remaining, estimated revenue at risk, and a
   plain-English explanation.
2. **Full SKU status** - a one-line summary per SKU, including ones that are
   fine (so you can confirm nothing was silently dropped).
3. **Data quality / ledger warnings** - anything skipped, deduplicated, or
   auto-corrected while processing the input (see "Defensive input handling"
   below), so the underlying data problems stay visible instead of failing
   silently.

The same data is available programmatically from `runAnalysis()` in
`src/analysis.ts` if you want to consume it as JSON/objects instead of the
printed report - `main.ts` is just one consumer of it.

## How the risk calculation works

For each SKU:

1. **Replay events chronologically.** Regardless of the order events appear
   in the file, they're sorted by timestamp before being applied, so
   out-of-order input can't corrupt the stock position.
2. **Compute sales velocity.** Average daily sales over the trailing
   `--window` days (default 30) as of the analysis date. If a SKU had no
   sales in that window (e.g. a slow mover), the tool falls back to its full
   sales history rather than reporting a misleading zero velocity.
3. **Project demand during the lead time.**
   `expected_demand = avg_daily_sales x reorder_lead_time_days`
4. **Project days of cover.** `days_of_stock_remaining = current_stock / avg_daily_sales`
5. **Classify risk** by comparing days of cover to the lead time:
   - **CRITICAL** - already out of stock, or will run out at/before half the
     lead time has passed (an order placed today arrives to an empty shelf
     with room to spare).
   - **HIGH** - will run out before the reorder arrives, but after the
     halfway point.
   - **MODERATE** - will just outlast the lead time (within a 25% buffer) -
     worth watching, not yet urgent.
   - **OK** - comfortable buffer beyond the lead time.
6. **Rank recommendations** by risk tier first, then by how many days short
   the SKU will be (`urgency_gap_days = lead_time - days_of_stock_remaining`),
   then by estimated revenue at risk as a tiebreaker
   (`unit_cost x avg_daily_sales x urgency_gap_days`) - so among equally
   urgent SKUs, the more valuable one surfaces first.

I used a **buffer-based tiering** instead of the simple
`current_stock <= expected_demand` rule from the example scenario because a
binary "at risk / not at risk" split doesn't tell a purchasing team *which*
fire to put out first - a SKU with 2 days of cover left and one with 13 days
(both technically "at risk" under a 14-day lead time) need very different
urgency. The tiers, plus the ranked-by-urgency-and-revenue recommendation
list, are meant to directly answer "what do I reorder first," per the
"practicality" evaluation criterion.

## Defensive input handling (assumptions)

The requirements note that events may be duplicated, missing, or out of
order. Concretely, this implementation:

- **Validates every event.** Missing/invalid `sku`, unknown `type`,
  non-numeric `quantity`, negative quantity on a non-adjustment type, or an
  unparseable `timestamp` causes that single event to be skipped (with a
  warning) rather than crashing the whole run. A missing `channel` defaults
  to `"Unknown"` rather than dropping the event, since the channel isn't
  needed to keep the stock math correct.
- **Deduplicates exact repeats.** Two events with identical
  `sku` + `channel` + `type` + `quantity` + `timestamp` are treated as the
  same event logged twice, and only counted once. *Assumption:* the log has
  no event ID, so this is the most defensible definition of "duplicate"
  available. It won't catch a genuinely distinct event that coincidentally
  shares all five fields (e.g. two separate 1-unit sales in the same
   second) - the trade-off is deliberate, since silently dropping a real sale
  would be worse than rarely under-deduplicating.
- **Sorts chronologically before applying.** The input array's order is
  never trusted; events are always replayed by parsed timestamp. When two
  events share an exact timestamp, restocks/returns are applied before sales
  as a deterministic tie-break (this only matters in the rare case of a
  literal tie, and errs toward not over-flagging risk).
- **Treats `stockout` and `stock_snapshot` as authoritative checkpoints.**
  If prior events computed a different position but a checkpoint says
  otherwise, the ledger trusts the checkpoint and emits a warning so the
  discrepancy (a likely missed sale, return, or restock upstream) stays
  visible instead of silently overriding the computed math.
- **Clamps negative positions to 0**, with a warning, if the computed
  position ever goes negative (oversold relative to recorded stock) without
  a `stockout` event to anchor it.
- **Analyzes "as of" the latest event timestamp in the log by default**
  (overridable via `--as-of`), so historical data produces the same,
  deterministic result no matter what day the tool happens to be run on.
- **Treats inventory as one pooled stock position across channels** by
  default - a SKU's `sale` events from Shopify, Amazon, and Flipkart all
  draw down the same `startingInventory` number. This matches a common
  multi-channel setup (one warehouse/3PL fulfilling several storefronts).
  Per-channel sales velocity is still broken out in the reasoning/report
  for visibility, since a SKU selling out on one channel but not another is
  useful purchasing context even when the physical stock pool is shared. If
  a business instead holds **separate, channel-allocated stock**, the model
  would need a per-channel starting inventory in the product data - the
  code is structured so that would be a small, contained change (mainly to
  `processSkuLedger`/`groupBySku`), not a rewrite.

## Why TypeScript + this structure

TypeScript was the preferred option in the brief. Business logic is split
into small, single-responsibility modules (`inventoryLedger.ts` for "what
happened to the stock," `riskAnalyzer.ts` for "is that a problem," `analysis.ts`
for "run it all and rank the results") so each is independently testable and
so `main.ts` stays a thin I/O shell. Dependencies are limited to `typescript`,
`tsx` (run TS directly without a build step), and `vitest` (fast, native TS
test runner) - no runtime dependencies at all, which keeps the submission
easy to install and run anywhere.

## Tests

`npm test` runs 26 tests across two files:

- `src/__tests__/inventoryLedger.test.ts` - validation, deduplication, and
  event-by-event ledger replay (restock, return, sale, adjustment, stockout,
  stock snapshot, out-of-order input, negative-position clamping).
- `src/__tests__/analysis.test.ts` - end-to-end risk classification and
  recommendation ranking, explicitly covering every scenario called out in
  the requirements: a SKU nearing its stockout point, a SKU already at risk,
  a SKU with sufficient inventory that should *not* be flagged, a SKU with
  many mixed events, a SKU sold across multiple channels, a return, a
  restock, out-of-order events producing the same result as in-order events,
  duplicate events being ignored, and malformed events being skipped
  instead of crashing.

All test data uses a fixed `--as-of` date and hand-computed expected values
(documented in code comments) rather than relying on wall-clock time, so runs
are fully deterministic.
