export type EventType = 'sale' | 'return' | 'restock' | 'stockout' | 'stock_snapshot' | 'adjustment';

export interface InventoryEvent {
  sku: string;
  channel: string;
  type: EventType;
  quantity: number;
  timestamp: string; // ISO 8601
}

export interface Product {
  sku: string;
  primaryChannel: string;
  unitCost: number;
  startingInventory: number;
}

export interface BusinessParams {
  /** Days it takes for a newly placed reorder to arrive. */
  reorderLeadTimeDays: number;
  /** Example business target / context value, echoed in reports. */
  weeklyRevenueTarget: number;
  /** How many trailing days of sales to use when computing daily velocity. */
  velocityWindowDays: number;
}

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'OK';

export interface ChannelVelocity {
  channel: string;
  avgDailySales: number;
  totalUnitsSold: number;
}

export interface SkuAnalysis {
  sku: string;
  currentStock: number;
  avgDailySales: number;
  channelBreakdown: ChannelVelocity[];
  /** Days until stock hits zero at the current sales rate. Null = no sales velocity data. */
  daysOfStockRemaining: number | null;
  expectedDemandDuringLeadTime: number;
  /** reorderLeadTimeDays - daysOfStockRemaining. Positive = will stock out before a reorder placed today could arrive. */
  urgencyGapDays: number;
  /** Estimated lost revenue (unitCost x avgDailySales x days short) if the SKU isn't reordered now. */
  revenueAtRisk: number;
  riskLevel: RiskLevel;
  reasoning: string[];
  warnings: string[];
}
