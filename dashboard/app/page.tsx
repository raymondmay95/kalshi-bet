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
    predictedDirection: "HIGH" | "LOW";
    highProbability: number;
    lowProbability: number;
    highEdge: number;
    lowEdge: number;
    confidence: number;
    reasons: string[];
    warnings: string[];
  } | null;
  updatedAt: number;
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

type SignalFilter = "ALL" | "ACTIONABLE" | "HIGH" | "LOW" | "NO_BET";

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const strikeSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [performance, setPerformance] = useState<PerformanceSummary | null>(null);
  const [signalFilter, setSignalFilter] = useState<SignalFilter>("ACTIONABLE");

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
        if (!liveRes.ok || !histRes.ok || !perfRes.ok) {
          throw new Error("Dashboard API request failed");
        }
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
        // Keep last known dashboard state if the API briefly fails.
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
  const priceSide: "HIGH" | "LOW" | "SAME" | null = market
    ? Math.abs(market.btcPrice - market.threshold) < 0.01
      ? "SAME"
      : market.btcPrice > market.threshold
        ? "HIGH"
        : "LOW"
    : null;
  const signal = rec?.recommendation ?? null;
  const signalColor =
    signal === "HIGH" ? "#22c55e" : signal === "LOW" ? "#ef4444" : "#94a3b8";
  const filteredHistory = history.filter((row) => {
    if (signalFilter === "ALL") return true;
    if (signalFilter === "ACTIONABLE") {
      return row.recommendation === "HIGH" || row.recommendation === "LOW";
    }
    return row.recommendation === signalFilter;
  });

  return (
    <main className="dashboard-main">
      <h1 className="dashboard-title">Kalshi BTC 15m Prediction Engine</h1>
      <p className="dashboard-subtitle">
        Advisory signals only — records every guess and outcome for model refinement
      </p>

      <div className="grid-top">
        <section className="card">
          <h2 className="card-heading">BTC vs Strike</h2>
          <div ref={chartRef} />
        </section>

        <section className="card">
          <div className="card-heading-row">
            <h2 className="card-heading">Signal</h2>
            {priceSide ? (
              <span className={`status-badge status-${priceSide.toLowerCase()}`}>
                <DirectionArrow side={priceSide} size={12} />
                {priceSide}
              </span>
            ) : null}
          </div>
          {rec ? (
            <>
              <div className="signal-value" style={{ color: signalColor }}>
                {signal === "HIGH" || signal === "LOW" ? (
                  <>
                    <DirectionArrow side={signal} size={28} />
                    {signal}
                  </>
                ) : (
                  signal
                )}
              </div>
              <Metric label="P(HIGH)" value={`${(rec.highProbability * 100).toFixed(1)}%`} />
              <Metric label="HIGH edge" value={rec.highEdge.toFixed(3)} />
              <Metric label="LOW edge" value={rec.lowEdge.toFixed(3)} />
              <Metric label="Confidence" value={rec.confidence.toFixed(2)} />
              <ul className="reasons-list">
                {rec.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {rec.warnings.map((warning) => (
                <p key={warning} className="warning-text">
                  {warning}
                </p>
              ))}
            </>
          ) : (
            <p>Waiting for engine...</p>
          )}
        </section>
      </div>

      <div className="grid-middle">
        <section className="card">
          <h2 className="card-heading">Market State</h2>
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

        <section className="card">
          <h2 className="card-heading">Track Record</h2>
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

      <section className="card history-section">
        <div className="card-heading-row">
          <h2 className="card-heading">Prediction History</h2>
          <label className="history-filter">
            <span className="history-filter-label">Signal</span>
            <select
              value={signalFilter}
              onChange={(event) =>
                setSignalFilter(event.target.value as SignalFilter)
              }
            >
              <option value="ACTIONABLE">HIGH / LOW</option>
              <option value="ALL">All</option>
              <option value="HIGH">HIGH</option>
              <option value="LOW">LOW</option>
              <option value="NO_BET">NO_BET</option>
            </select>
          </label>
        </div>
        <div className="table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Signal</th>
                <th>P(HIGH)</th>
                <th>Conf</th>
                <th>Outcome</th>
                <th>Correct?</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={6} className="history-empty">
                    No predictions match this filter
                  </td>
                </tr>
              ) : (
                filteredHistory.slice(0, 20).map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
                    <td>{row.recommendation}</td>
                    <td>{(row.predictedHigh * 100).toFixed(1)}%</td>
                    <td>{row.confidence.toFixed(2)}</td>
                    <td>{formatOutcome(row.finalResult)}</td>
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-row">
      <span className="metric-label">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function formatOutcome(finalResult: string | null): string {
  if (finalResult === "yes") return "HIGH";
  if (finalResult === "no") return "LOW";
  return "pending";
}

function DirectionArrow({
  side,
  size = 14,
}: {
  side: "HIGH" | "LOW" | "SAME";
  size?: number;
}) {
  return (
    <svg
      className="direction-arrow"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {side === "HIGH" ? (
        <path d="M8 3.5 13 10H3L8 3.5Z" fill="currentColor" />
      ) : side === "LOW" ? (
        <path d="M8 12.5 3 6h10L8 12.5Z" fill="currentColor" />
      ) : (
        <>
          <path d="M6.5 4.5 2 8l4.5 3.5V4.5Z" fill="currentColor" />
          <path d="M9.5 4.5v7L14 8 9.5 4.5Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
