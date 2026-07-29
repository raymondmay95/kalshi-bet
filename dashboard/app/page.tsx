"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { STAT_INFO, type StatKey } from "./stat-definitions";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

type SignalStrength = "STRONG" | "MODERATE" | "LEAN" | "PASS";

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
    tradeRecommendation: "BET_HIGH" | "BET_LOW" | "NO_BET";
    strength: SignalStrength;
    directionCertainty: number;
    edgeCertainty: number;
    highProbability: number;
    lowProbability: number;
    probabilityStdError: number;
    highEdge: number;
    lowEdge: number;
    bestEdge: number;
    bestCost: number;
    effectiveYesCost: number;
    effectiveNoCost: number;
    marketImpliedHigh: number;
    modelDisagreement: number;
    stakeFraction: number;
    highAsk: number;
    lowAsk: number;
    blockers: string[];
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
  strength?: string;
  directionCertainty?: number;
}

type SignalFilter = "ALL" | "ACTIONABLE" | "HIGH" | "LOW" | "NO_BET";

const STRENGTH_LABEL: Record<SignalStrength, string> = {
  STRONG: "Strong bet",
  MODERATE: "Moderate bet",
  LEAN: "Small lean",
  PASS: "No bet",
};

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
      height: 300,
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
  const direction = rec?.predictedDirection ?? null;
  const strength = rec?.strength ?? "PASS";
  const isBetting = strength !== "PASS";
  const directionColor =
    direction === "HIGH" ? "#22c55e" : direction === "LOW" ? "#ef4444" : "#94a3b8";

  useEffect(() => {
    document.body.dataset.theme = isBetting ? "active-bet" : "no-bet";
    document.body.dataset.signal =
      isBetting && direction ? direction.toLowerCase() : "none";
    return () => {
      delete document.body.dataset.theme;
      delete document.body.dataset.signal;
    };
  }, [isBetting, direction]);

  useEffect(() => {
    chartApi.current?.applyOptions({
      layout: {
        background: { color: isBetting ? "#17122a" : "#121826" },
        textColor: isBetting ? "#e9e5ff" : "#d1d5db",
      },
      grid: {
        vertLines: { color: isBetting ? "#30284d" : "#1f2937" },
        horzLines: { color: isBetting ? "#30284d" : "#1f2937" },
      },
    });
    priceSeries.current?.applyOptions({ color: isBetting ? directionColor : "#22c55e" });
    strikeSeries.current?.applyOptions({ color: isBetting ? "#a78bfa" : "#f59e0b" });
  }, [isBetting, directionColor]);

  const filteredHistory = history.filter((row) => {
    if (signalFilter === "ALL") return true;
    if (signalFilter === "ACTIONABLE") {
      return row.recommendation === "HIGH" || row.recommendation === "LOW";
    }
    return row.recommendation === signalFilter;
  });

  const spread = market
    ? Math.max(
        market.kalshiYesAsk - market.kalshiYesBid,
        market.kalshiNoAsk - market.kalshiNoBid,
      )
    : null;

  return (
    <main className="dashboard-main">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Kalshi BTC 15m Prediction Engine</h1>
        <p className="dashboard-subtitle">
          Advisory signals only — every call and outcome is recorded for model refinement
        </p>
      </header>

      {rec && direction ? (
        <VerdictCard
          direction={direction}
          strength={strength}
          rec={rec}
          market={market ?? null}
        />
      ) : (
        <section className="card verdict-card">
          <p className="verdict-waiting">Waiting for the engine to price a market…</p>
        </section>
      )}

      <div className="grid-top">
        <section className="card">
          <h2 className="card-heading">BTC vs Strike</h2>
          <div ref={chartRef} />
        </section>

        <section className="card">
          <h2 className="card-heading">Why</h2>
          {rec ? (
            <>
              <Metric
                label="Model says HIGH"
                info="modelProbability"
                value={`${(rec.highProbability * 100).toFixed(1)}%`}
              />
              <Metric
                label="Market says HIGH"
                info="marketProbability"
                value={`${(rec.marketImpliedHigh * 100).toFixed(1)}%`}
              />
              <Metric
                label="Disagreement"
                info="disagreement"
                value={`${rec.modelDisagreement >= 0 ? "+" : ""}${(rec.modelDisagreement * 100).toFixed(1)} pts`}
                tone={Math.abs(rec.modelDisagreement) >= 0.04 ? "good" : "neutral"}
              />
              <Metric
                label="Estimate precision"
                info="standardError"
                value={`±${(rec.probabilityStdError * 100).toFixed(1)} pts`}
              />
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
            <p className="muted">Waiting for engine…</p>
          )}
        </section>
      </div>

      <div className="grid-middle">
        <section className="card">
          <h2 className="card-heading">Market State</h2>
          {market ? (
            <>
              <Metric label="Ticker" info="ticker" value={market.kalshiTicker} />
              <Metric label="BTC price" info="btcPrice" value={`$${market.btcPrice.toFixed(2)}`} />
              <Metric label="Strike" info="strike" value={`$${market.threshold.toFixed(2)}`} />
              <Metric
                label="Distance to strike"
                info="distance"
                value={`${market.distanceToThresholdBps >= 0 ? "+" : ""}${market.distanceToThresholdBps.toFixed(1)} bps`}
              />
              <Metric label="Time left" info="timeLeft" value={formatClock(market.secondsRemaining)} />
              <Metric
                label="YES bid / ask"
                info="quotes"
                value={`${toCents(market.kalshiYesBid)} / ${toCents(market.kalshiYesAsk)}`}
              />
              <Metric
                label="NO bid / ask"
                info="quotes"
                value={`${toCents(market.kalshiNoBid)} / ${toCents(market.kalshiNoAsk)}`}
              />
              {spread != null ? (
                <Metric label="Spread" info="spread" value={toCents(spread)} />
              ) : null}
            </>
          ) : (
            <p className="muted">No active market</p>
          )}
        </section>

        <section className="card">
          <h2 className="card-heading">Track Record</h2>
          <Metric
            label="Predictions logged"
            info="predictionsLogged"
            value={String(performance?.totalPredictions ?? 0)}
          />
          <Metric
            label="Settled"
            info="evaluated"
            value={String(performance?.evaluatedPredictions ?? 0)}
          />
          <Metric
            label="Bets recommended"
            info="actionableSignals"
            value={String(performance?.actionableSignals ?? 0)}
          />
          <Metric
            label="Bet accuracy"
            info="signalAccuracy"
            value={
              performance?.accuracy != null
                ? `${(performance.accuracy * 100).toFixed(1)}%`
                : "Not enough data"
            }
          />
          <Metric
            label="Brier score"
            info="brier"
            value={
              performance?.averageBrier != null
                ? performance.averageBrier.toFixed(4)
                : "Not enough data"
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
              <option value="ACTIONABLE">Bets only</option>
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
                <th>
                  Signal <InfoTip info="historySignal" />
                </th>
                <th>
                  Certainty <InfoTip info="certainty" />
                </th>
                <th>
                  Edge conf. <InfoTip info="edgeCertainty" />
                </th>
                <th>
                  Outcome <InfoTip info="outcome" />
                </th>
                <th>Result</th>
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
                    <td>
                      <span className={`pill pill-${row.recommendation.toLowerCase()}`}>
                        {row.recommendation === "NO_BET" ? "PASS" : row.recommendation}
                      </span>
                    </td>
                    <td>
                      {(
                        (row.directionCertainty ??
                          Math.max(row.predictedHigh, 1 - row.predictedHigh)) * 100
                      ).toFixed(0)}
                      %
                    </td>
                    <td>{(row.confidence * 100).toFixed(0)}%</td>
                    <td>{formatOutcome(row.finalResult)}</td>
                    <td>
                      {row.correct == null ? (
                        <span className="muted">
                          {row.recommendation === "NO_BET" ? "—" : "pending"}
                        </span>
                      ) : (
                        <span className={row.correct ? "result-win" : "result-loss"}>
                          {row.correct ? "won" : "lost"}
                        </span>
                      )}
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

function VerdictCard({
  direction,
  strength,
  rec,
  market,
}: {
  direction: "HIGH" | "LOW";
  strength: SignalStrength;
  rec: NonNullable<LiveState["recommendation"]>;
  market: LiveState["marketState"];
}) {
  const betSide = rec.tradeRecommendation === "BET_LOW" ? "LOW" : "HIGH";
  const isBetting = strength !== "PASS";

  return (
    <section className="card verdict-card" data-strength={strength.toLowerCase()}>
      <div className="verdict-primary">
        <div className="verdict-call">
          <span className="verdict-label">
            Call <InfoTip info="direction" />
          </span>
          <span className={`verdict-direction verdict-${direction.toLowerCase()}`}>
            <DirectionArrow side={direction} size={36} />
            {direction}
          </span>
        </div>

        <div className="verdict-certainty">
          <span className="verdict-label">
            Certainty <InfoTip info="certainty" />
          </span>
          <span className="verdict-percent">
            {(rec.directionCertainty * 100).toFixed(0)}
            <span className="verdict-percent-sign">%</span>
          </span>
          <CertaintyBar value={rec.directionCertainty} direction={direction} />
        </div>

        <div className="verdict-strength">
          <span className="verdict-label">
            Conviction <InfoTip info="strength" />
          </span>
          <span className={`strength-badge strength-${strength.toLowerCase()}`}>
            {STRENGTH_LABEL[strength]}
          </span>
        </div>
      </div>

      <div className="verdict-action">
        <span className="verdict-label">
          What to do <InfoTip info="action" />
        </span>
        <p className="verdict-action-text">
          {isBetting
            ? `Buy ${betSide === "HIGH" ? "YES" : "NO"} at ${toCents(betSide === "HIGH" ? rec.highAsk : rec.lowAsk)} — all-in ${toCents(rec.bestCost)} per contract, staking ${(rec.stakeFraction * 100).toFixed(2)}% of bankroll.`
            : rec.blockers.length > 0
              ? `Stand aside — ${rec.warnings[0] ?? "cannot execute right now"}. Best guess is still ${direction} at ${(rec.directionCertainty * 100).toFixed(0)}% certainty.`
              : `Stand aside — the market is priced fairly (best edge ${formatEdge(rec.bestEdge)}). Best guess is still ${direction} at ${(rec.directionCertainty * 100).toFixed(0)}% certainty.`}
        </p>
      </div>

      <div className="verdict-stats">
        <Stat
          label="Edge"
          info="edge"
          value={formatEdge(rec.bestEdge)}
          tone={rec.bestEdge > 0 ? "good" : "bad"}
        />
        <Stat
          label="Edge confidence"
          info="edgeCertainty"
          value={`${(rec.edgeCertainty * 100).toFixed(0)}%`}
          tone={rec.edgeCertainty >= 0.65 ? "good" : rec.edgeCertainty >= 0.55 ? "neutral" : "bad"}
        />
        <Stat
          label="All-in cost"
          info="effectiveCost"
          value={toCents(rec.bestCost)}
        />
        <Stat
          label="Stake"
          info="stake"
          value={isBetting ? `${(rec.stakeFraction * 100).toFixed(2)}%` : "—"}
        />
        <Stat
          label="Time left"
          info="timeLeft"
          value={market ? formatClock(market.secondsRemaining) : "—"}
        />
      </div>
    </section>
  );
}

function CertaintyBar({
  value,
  direction,
}: {
  value: number;
  direction: "HIGH" | "LOW";
}) {
  // The bar starts at the 50% coin-flip point, so it shows information gained
  // over a guess rather than an impressive-looking bar for a toss-up.
  const filled = Math.max(0, Math.min(1, (value - 0.5) * 2));
  return (
    <div
      className="certainty-bar"
      role="img"
      aria-label={`${(value * 100).toFixed(0)} percent certainty on ${direction}`}
    >
      <div
        className={`certainty-bar-fill certainty-${direction.toLowerCase()}`}
        style={{ width: `${filled * 100}%` }}
      />
      <span className="certainty-bar-tick" />
    </div>
  );
}

function InfoTip({ info }: { info: StatKey }) {
  const ref = useRef<HTMLSpanElement>(null);

  // Labels sit at the edges of cards, where a centred bubble would hang off
  // screen, so nudge it back inside the viewport once it is laid out.
  const clampIntoView = () => {
    const bubble = ref.current?.querySelector<HTMLElement>(".infotip-bubble");
    if (!bubble) return;

    bubble.style.setProperty("--tip-shift", "0px");

    // The bubble is display:none until the hover styles land, so force a
    // hidden layout pass when it has no box yet rather than measuring zeroes.
    const needsLayout = bubble.offsetWidth === 0;
    if (needsLayout) {
      bubble.style.display = "block";
      bubble.style.visibility = "hidden";
    }
    const rect = bubble.getBoundingClientRect();
    if (needsLayout) {
      bubble.style.display = "";
      bubble.style.visibility = "";
    }

    const margin = 8;
    const overflowLeft = margin - rect.left;
    const overflowRight = rect.right - (window.innerWidth - margin);
    const shift =
      overflowLeft > 0 ? overflowLeft : overflowRight > 0 ? -overflowRight : 0;
    bubble.style.setProperty("--tip-shift", `${Math.round(shift)}px`);
  };

  return (
    <span
      ref={ref}
      className="infotip"
      tabIndex={0}
      role="note"
      aria-label={STAT_INFO[info]}
      onMouseEnter={clampIntoView}
      onFocus={clampIntoView}
    >
      <span aria-hidden="true" className="infotip-icon">
        i
      </span>
      <span className="infotip-bubble">{STAT_INFO[info]}</span>
    </span>
  );
}

function Metric({
  label,
  value,
  info,
  tone = "neutral",
}: {
  label: string;
  value: string;
  info?: StatKey;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="metric-row">
      <span className="metric-label">
        {label}
        {info ? <InfoTip info={info} /> : null}
      </span>
      <span className={`metric-value tone-${tone}`}>{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  info,
  tone = "neutral",
}: {
  label: string;
  value: string;
  info: StatKey;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="stat-tile">
      <span className="stat-label">
        {label}
        <InfoTip info={info} />
      </span>
      <span className={`stat-value tone-${tone}`}>{value}</span>
    </div>
  );
}

function toCents(price: number): string {
  return `${(price * 100).toFixed(1)}\u00A2`;
}

function formatEdge(edge: number): string {
  return `${edge >= 0 ? "+" : "\u2212"}${Math.abs(edge * 100).toFixed(1)}\u00A2`;
}

function formatClock(seconds: number): string {
  if (seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
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
