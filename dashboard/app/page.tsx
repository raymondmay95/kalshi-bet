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
          <h2 className="card-heading">Signal</h2>
          {rec ? (
            <>
              <div className="signal-value" style={{ color: recColor }}>
                {rec.recommendation}
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
        <h2 className="card-heading">Prediction History</h2>
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
              {history.slice(0, 20).map((row) => (
                <tr key={row.id}>
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
