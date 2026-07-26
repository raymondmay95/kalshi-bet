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

interface PerformanceSummary {
  totalPredictions: number;
  evaluatedPredictions: number;
  actionableSignals: number;
  correctSignals: number;
  accuracy: number | null;
  averageBrier: number | null;
}

interface HistoryRow {
  id: number;
  timestamp: string;
  recommendation: string;
  predictedHigh: number;
  confidence: number;
  finalResult: string | null;
  correct: boolean | null;
  secondsRemaining: number | null;
}

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const strikeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [performance, setPerformance] = useState<PerformanceSummary | null>(null);

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
        const [liveRes, histRes, perfRes] = await Promise.all([
          fetch(`${API_BASE}/api/live`),
          fetch(`${API_BASE}/api/history`),
          fetch(`${API_BASE}/api/performance`),
        ]);
        if (!mounted) return;
        const liveData = await liveRes.json();
        const histData = await histRes.json();
        const perfData = await perfRes.json();
        setLive(liveData);
        setHistory(histData);
        setPerformance(perfData);

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
        Advisory signals only — records every guess and outcome for model refinement
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 }}>
        <section style={cardStyle}>
          <h2 style={headingStyle}>BTC vs Strike</h2>
          <div ref={chartRef} />
        </section>

        <section style={cardStyle}>
          <h2 style={headingStyle}>Signal</h2>
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
          <h2 style={headingStyle}>Track Record</h2>
          <Metric label="Predictions logged" value={String(performance?.totalPredictions ?? 0)} />
          <Metric label="Evaluated" value={String(performance?.evaluatedPredictions ?? 0)} />
          <Metric label="HIGH/LOW signals" value={String(performance?.actionableSignals ?? 0)} />
          <Metric
            label="Signal accuracy"
            value={
              performance?.accuracy != null
                ? `${(performance.accuracy * 100).toFixed(1)}%`
                : "N/A"
            }
          />
          <Metric
            label="Avg Brier score"
            value={
              performance?.averageBrier != null
                ? performance.averageBrier.toFixed(4)
                : "N/A"
            }
          />
        </section>
      </div>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={headingStyle}>Prediction History</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#94a3b8" }}>
              <th>Time</th>
              <th>Signal</th>
              <th>P(HIGH)</th>
              <th>Conf</th>
              <th>Outcome</th>
              <th>Correct?</th>
            </tr>
          </thead>
          <tbody>
            {history.slice(0, 20).map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid #1f2937" }}>
                <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
                <td>{row.recommendation}</td>
                <td>{(row.predictedHigh * 100).toFixed(1)}%</td>
                <td>{row.confidence.toFixed(2)}</td>
                <td>{row.finalResult ?? "pending"}</td>
                <td>
                  {row.correct == null
                    ? row.recommendation === "NO_BET"
                      ? "—"
                      : "pending"
                    : row.correct
                      ? "yes"
                      : "no"}
                </td>
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
