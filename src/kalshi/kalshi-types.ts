import { z } from "zod";

export interface SettlementDefinition {
  sourceName: string;
  sourceUrl?: string;
  comparison: "above" | "at_or_above" | "below" | "at_or_below";
  threshold: number;
  observationStart: Date;
  observationEnd: Date;
  calculationMethod?: string;
}

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle?: string;
  status: string;
  openTime: Date;
  closeTime: Date;
  floorStrike?: number;
  capStrike?: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  result?: "yes" | "no" | null;
  settlementSource: string;
  settlementRule: string;
}

export interface KalshiOrderBookLevel {
  price: number;
  quantity: number;
}

export interface KalshiOrderBook {
  yes: KalshiOrderBookLevel[];
  no: KalshiOrderBookLevel[];
}

export interface KalshiMarketState {
  market: KalshiMarket;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  yesSpread: number;
  noSpread: number;
  yesLiquidity: number;
  noLiquidity: number;
  updatedAt: number;
}

const marketSchema = z.object({
  ticker: z.string(),
  event_ticker: z.string(),
  title: z.string(),
  subtitle: z.string().optional().nullable(),
  status: z.string(),
  open_time: z.string(),
  close_time: z.string(),
  floor_strike: z.number().optional().nullable(),
  cap_strike: z.number().optional().nullable(),
  yes_bid_dollars: z.string().optional().nullable(),
  yes_ask_dollars: z.string().optional().nullable(),
  no_bid_dollars: z.string().optional().nullable(),
  no_ask_dollars: z.string().optional().nullable(),
  yes_bid: z.number().optional().nullable(),
  yes_ask: z.number().optional().nullable(),
  no_bid: z.number().optional().nullable(),
  no_ask: z.number().optional().nullable(),
  result: z.string().optional().nullable(),
});

const marketsResponseSchema = z.object({
  markets: z.array(marketSchema),
});

const orderbookResponseSchema = z.object({
  orderbook: z
    .object({
      yes: z.array(z.tuple([z.number(), z.number()])).optional(),
      no: z.array(z.tuple([z.number(), z.number()])).optional(),
    })
    .optional(),
  orderbook_fp: z
    .object({
      yes_dollars: z.array(z.tuple([z.string(), z.string()])).optional(),
      no_dollars: z.array(z.tuple([z.string(), z.string()])).optional(),
    })
    .optional(),
});

export function parseMarketsResponse(data: unknown): KalshiMarket[] {
  const parsed = marketsResponseSchema.parse(data);
  return parsed.markets.map(parseMarket);
}

export function parseMarket(raw: z.infer<typeof marketSchema>): KalshiMarket {
  const yesBid = parsePrice(raw.yes_bid_dollars, raw.yes_bid);
  const yesAsk = parsePrice(raw.yes_ask_dollars, raw.yes_ask);
  const noBid = parsePrice(raw.no_bid_dollars, raw.no_bid);
  const noAsk = parsePrice(raw.no_ask_dollars, raw.no_ask);

  return {
    ticker: raw.ticker,
    eventTicker: raw.event_ticker,
    title: raw.title,
    subtitle: raw.subtitle ?? undefined,
    status: raw.status,
    openTime: new Date(raw.open_time),
    closeTime: new Date(raw.close_time),
    floorStrike: raw.floor_strike ?? undefined,
    capStrike: raw.cap_strike ?? undefined,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    result: parseResult(raw.result),
    settlementSource: "CF Benchmarks Bitcoin Real-Time Index (BRTI)",
    settlementRule:
      "60-second average of BRTI sampled once per second over the final minute before close",
  };
}

export function parseOrderBookResponse(data: unknown): KalshiOrderBook {
  const parsed = orderbookResponseSchema.parse(data);

  if (parsed.orderbook_fp) {
    return {
      yes: (parsed.orderbook_fp.yes_dollars ?? []).map(([price, quantity]) => ({
        price: Number(price),
        quantity: Number(quantity),
      })),
      no: (parsed.orderbook_fp.no_dollars ?? []).map(([price, quantity]) => ({
        price: Number(price),
        quantity: Number(quantity),
      })),
    };
  }

  return {
    yes: (parsed.orderbook?.yes ?? []).map(([price, quantity]) => ({
      price: price / 100,
      quantity,
    })),
    no: (parsed.orderbook?.no ?? []).map(([price, quantity]) => ({
      price: price / 100,
      quantity,
    })),
  };
}

function parsePrice(dollars?: string | null, cents?: number | null): number {
  if (dollars != null && dollars !== "") {
    return Number(dollars);
  }
  if (cents != null) {
    return cents / 100;
  }
  return 0;
}

function parseResult(result?: string | null): "yes" | "no" | null {
  if (result === "yes" || result === "no") {
    return result;
  }
  return null;
}

export function deriveAskFromBid(oppositeBid: number): number {
  return Math.max(0, Math.min(1, 1 - oppositeBid));
}

export function buildSettlementDefinition(market: KalshiMarket): SettlementDefinition {
  return {
    sourceName: market.settlementSource,
    comparison: "above",
    threshold: market.floorStrike ?? 0,
    observationStart: market.openTime,
    observationEnd: market.closeTime,
    calculationMethod: market.settlementRule,
  };
}

export { marketSchema, marketsResponseSchema, orderbookResponseSchema };
