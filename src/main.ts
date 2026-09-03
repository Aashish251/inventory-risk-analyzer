import { readFileSync } from 'node:fs';
import { DEFAULT_PARAMS, runAnalysis, type AnalysisResult } from './analysis.js';
import type { BusinessParams, Product } from './types.js';

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function parseArgs(argv: string[]) {
  const [eventsPath, productsPath, ...rest] = argv;
  const params: BusinessParams = { ...DEFAULT_PARAMS };
  let asOf: Date | undefined;

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--lead-time') params.reorderLeadTimeDays = Number(rest[++i]);
    else if (flag === '--window') params.velocityWindowDays = Number(rest[++i]);
    else if (flag === '--as-of') asOf = new Date(String(rest[++i]));
    else if (flag === '--revenue-target') params.weeklyRevenueTarget = Number(rest[++i]);
  }

  if (!eventsPath || !productsPath) {
    console.error(
      'Usage: npm start -- <events.json> <products.json> [--lead-time N] [--window N] [--as-of ISO_DATE] [--revenue-target N]'
    );
    process.exit(1);
  }

  return { eventsPath, productsPath, params, asOf };
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function printReport(result: AnalysisResult, params: BusinessParams): void {
  const line = '='.repeat(72);
  console.log(line);
  console.log('INVENTORY STOCKOUT RISK REPORT');
  console.log(
    `Reorder lead time: ${params.reorderLeadTimeDays}d | Velocity window: ${params.velocityWindowDays}d | As of: ${result.asOf.toISOString()}`
  );
  console.log(line);

  console.log('\n--- REORDER PRIORITY (most urgent first) ---\n');
  if (result.recommendations.length === 0) {
    console.log('No SKUs are currently at risk. No reorders required right now.\n');
  } else {
    result.recommendations.forEach((a, idx) => {
      const days = a.daysOfStockRemaining === null ? 'unbounded' : a.daysOfStockRemaining.toFixed(1);
      console.log(`${idx + 1}. [${a.riskLevel}] ${a.sku} - ${a.currentStock} units on hand, ~${days} day(s) of cover remaining`);
      console.log(`   Estimated revenue at risk if not reordered now: ${fmtMoney(a.revenueAtRisk)}`);
      for (const r of a.reasoning) console.log(`   - ${r}`);
      console.log('');
    });
  }

  console.log('--- FULL SKU STATUS ---\n');
  for (const a of result.skuAnalyses) {
    const days = a.daysOfStockRemaining === null ? 'unbounded' : a.daysOfStockRemaining.toFixed(1);
    console.log(`${a.sku}: [${a.riskLevel}] stock=${a.currentStock}, velocity=${a.avgDailySales.toFixed(2)}/day, cover=${days}d`);
  }

  if (result.globalWarnings.length > 0) {
    console.log('\n--- DATA QUALITY WARNINGS ---\n');
    for (const w of result.globalWarnings) console.log(`- ${w}`);
  }

  const skuWarnings = result.skuAnalyses.flatMap((a) => a.warnings);
  if (skuWarnings.length > 0) {
    console.log('\n--- LEDGER WARNINGS ---\n');
    for (const w of skuWarnings) console.log(`- ${w}`);
  }
}

function main(): void {
  const { eventsPath, productsPath, params, asOf } = parseArgs(process.argv.slice(2));
  const events = loadJson<unknown[]>(eventsPath);
  const products = loadJson<Product[]>(productsPath);

  const result = runAnalysis(events, products, params, asOf);
  printReport(result, params);
}

main();
