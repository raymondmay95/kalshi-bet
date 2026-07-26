export interface BinanceAggTrade {
  e: "aggTrade";
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

export interface BinanceBookTicker {
  u: number;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

export interface BinanceDepthUpdate {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface BinanceKline {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
  x: boolean;
  q: string;
}

export interface BinanceMarketState {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  lastTradeTime: number;
  updatedAt: number;
  bidDepth: number;
  askDepth: number;
  microprice: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

export interface TradeRecord {
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface CandleRecord {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}
