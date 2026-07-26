"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

interface LiveState {
  marketState: {
    kalshiTicker: string;
    threshold: number;
    btcPrice: number;
    secondsRemaining: number;
    distanceToThresholdBps: number;
    kalshiYesBid: number;
    kalshiYesAsk: number;
    kalshiNoBid: number;
    kalshiNoAsk: number;
  } | null;
  recommendation: {
    recommendation: "HIGH" | "LOW" | "NO_BET";
    highProbability: number;
    lowProbability: number;
    highEdge: number;
    lowEdge: number;
    confidence: number;
    reasons: string[];
    warnings: string[];
  } | null;
}

interface PredictionRow {
  id: number;
  recommendation: string;
  adjustedHighProbability: number;
  highEdge: number;
  lowEdge: number;
  confidence: number;
  timestamp: string;
}

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const strikeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [predictions, setPredictions] = useState<PredictionRow[]>([]);
  const [performance, setPerformance] = useState<{ totalPnl: number; settledTrades: number } | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth,
      height: 320,
      layout: { background: { color: "#121826" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
    });
    priceSeries.current = chart.addLineSeries({ color: "#22c55e", lineWidth: 2 });
    strikeSeries.current = chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, lineStyle: 2 });
    chartApi.current = chart;

    const onResize = () => {
      if (chartRef.current) {
        chart.applyOptions({ width: chartRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const fetchAll = async () => {
      try {
        const [liveRes, predRes, perfRes] = await Promise.all([
          fetch(`${API_BASE}/api/live`),
          fetch(`${API_BASE}/api/predictions`),
          fetch(`${API_BASE}/api/performance`),
        ]);
        if (!mounted) return;
        const liveData = await liveRes.json();
        const predData = await predRes.json();
        const perfData = await perfRes.json();
        setLive(liveData);
        setPredictions(predData);
        setPerformance({ totalPnl: perfData.totalPnl, settledTrades: perfData.settledTrades });

        if (liveData.marketState && priceSeries.current && strikeSeries.current) {
          const now = Math.floor(Date.now() / 1000) as UTCTimestamp;
          priceSeries.current.update({ time: now, value: liveData.marketState.btcPrice });
          strikeSeries.current.update({ time: now, value: liveData.marketState.threshold });
        }
      } catch {
        // API may be offline during local dev
      }
    };

    fetchAll();
    const timer = setInterval(fetchAll, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const rec = live?.recommendation;
  const market = live?.marketState;
  const recColor =
    rec?.recommendation === "HIGH"
      ? "#22c55e"
      : rec?.recommendation === "LOW"
        ? "#ef4444"
        : "#94a3b8";

  return (
    <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Kalshi BTC 15m Prediction Engine</h1>
      <p style={{ color: "#94a3b8" }}>
        Live Binance signal vs Kalshi KXBTC15M executable prices
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 }}>
        <section style={cardStyle}>
          <h2 style={headingStyle}>BTC vs Strike</h2>
          <div ref={chartRef} />
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}>Recommendation</h2>
          {rec ? (
            <>
              <div style={{ fontSize: 32, fontWeight: 700, color: recColor }}>
                {rec.recommendation}
              </div>
              <Metric label="P(HIGH)" value={`${(rec.highProbability * 100).toFixed(1)}%`} />
              <Metric label="HIGH edge" value={rec.highEdge.toFixed(3)} />
              <Metric label="LOW edge" value={rec.lowEdge.toFixed(3)} />
              <Metric label="Confidence" value={rec.confidence.toFixed(2)} />
              <ul style={{ paddingLeft: 18, color: "#cbd5e1" }}>
                {rec.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {rec.warnings.map((warning) => (
                <p key={warning} style={{ color: "#fbbf24", fontSize: 13 }}>
                  {warning}
                </p>
              ))}
            </>
          ) : (
            <p>Waiting for engine...</p>
          )}
        </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={cardStyle}>
          <h2 style={headingStyle}>Market State</h2>
          {market ? (
            <>
              <Metric label="Ticker" value={market.kalshiTicker} />
              <Metric label="BTC" value={`$${market.btcPrice.toFixed(2)}`} />
              <Metric label="Strike" value={`$${market.threshold.toFixed(2)}`} />
              <Metric label="Distance" value={`${market.distanceToThresholdBps.toFixed(1)} bps`} />
              <Metric label="Time left" value={`${market.secondsRemaining}s`} />
              <Metric label="YES bid/ask" value={`${market.kalshiYesBid.toFixed(2)} / ${market.kalshiYesAsk.toFixed(2)}`} />
              <Metric label="NO bid/ask" value={`${market.kalshiNoBid.toFixed(2)} / ${market.kalshiNoAsk.toFixed(2)}`} />
            </>
          ) : (
            <p>No active market</p>
          )}
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}>Paper Trading</h2>
          <Metric label="Settled trades" value={String(performance?.settledTrades ?? 0)} />
          <Metric
            label="Net P&L"
            value={`$${(performance?.totalPnl ?? 0).toFixed(4)}`}
          />
        </section>
      </div>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={headingStyle}>Recent Predictions</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#94a3b8" }}>
              <th>Time</th>
              <th>Rec</th>
              <th>P(HIGH)</th>
              <th>H edge</th>
              <th>L edge</th>
              <th>Conf</th>
            </tr>
          </thead>
          <tbody>
            {predictions.slice(0, 15).map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid #1f2937" }}>
                <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
                <td>{row.recommendation}</td>
                <td>{(row.adjustedHighProbability * 100).toFixed(1)}%</td>
                <td>{row.highEdge.toFixed(3)}</td>
                <td>{row.lowEdge.toFixed(3)}</td>
                <td>{row.confidence.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#121826",
  border: "1px solid #1f2937",
  borderRadius: 12,
  padding: 16,
};

const headingStyle: React.CSSProperties = {
  marginTop: 0,
  fontSize: 16,
  color: "#cbd5e1",
};
