/**
 * Plain-English explanation for every statistic shown on the dashboard, used as
 * the hover text on each label. Kept in one place so the wording stays
 * consistent and every new metric is forced to justify itself.
 */
export const STAT_INFO = {
  direction:
    "Which way the model thinks this 15-minute market settles. HIGH means Bitcoin finishes at or above the strike price, LOW means below it.",
  certainty:
    "The model's probability that the direction above turns out to be right. 50% is a coin flip and 100% would be a certainty; anything under about 55% is barely an opinion.",
  strength:
    "How hard the engine is leaning on this trade. STRONG and MODERATE are real bets, LEAN is a small speculative bet, and NO BET means the price is fair or the trade cannot be executed.",
  action:
    "The concrete order this translates into: which contract to buy, the all-in price per contract, and how much of your bankroll to risk.",
  edge:
    "Expected profit per contract after Kalshi's taker fee and expected slippage, in cents. An edge of 3c means the contract is worth 3 cents more than it costs you all-in. Negative means it is overpriced.",
  edgeCertainty:
    "The chance that the edge above is real rather than an artifact of estimation error. Computed by comparing the edge to how precise the probability estimate is, so a 3c edge on a noisy estimate scores lower than a 3c edge on a sharp one.",
  modelProbability:
    "The model's own probability that Bitcoin settles at or above the strike, from the volatility and drift model plus the Monte Carlo settlement simulation.",
  marketProbability:
    "The probability the market itself implies, taken from the midpoint of the YES and NO quotes. This is the crowd's answer to the same question.",
  disagreement:
    "Model probability minus market probability. This gap is the entire source of profit — if the model agrees with the market there is nothing to bet on, no matter how confident the model is.",
  standardError:
    "How precise the model's probability is, in probability points. It comes from re-pricing the market with the volatility and drift estimates perturbed by realistic amounts. A value of 0.04 means plus or minus about 4 points.",
  stake:
    "Fraction of bankroll to risk on this bet. Derived from quarter-Kelly sizing on the edge after discounting it for estimation error, then capped so no single 15-minute market can do real damage.",
  effectiveCost:
    "All-in cost per contract: the asking price, plus Kalshi's taker fee, plus expected slippage. This is the number the model's probability has to beat.",
  ticker: "The Kalshi market being traded — one specific 15-minute Bitcoin window.",
  btcPrice: "Current Bitcoin spot price from the live exchange feed.",
  strike:
    "The strike price for this window. Settlement above this level pays YES (HIGH); below pays NO (LOW).",
  distance:
    "How far spot is from the strike, in basis points, where 1 basis point is 0.01%. Positive means spot is above the strike.",
  timeLeft:
    "Seconds until this market closes. Kalshi settles on the average price over the final 60 seconds, so the outcome is largely locked in before the clock hits zero.",
  quotes:
    "The best bid and ask on Kalshi. You buy at the ask and sell at the bid; the gap between them is a cost you pay on entry.",
  spread:
    "The gap between the bid and the ask. It is a direct cost of entering, so a wide spread can wipe out an otherwise good edge.",
  predictionsLogged:
    "Total number of predictions recorded, including the ones where no bet was recommended.",
  evaluated:
    "How many of those predictions have had their market settle, so the outcome is known.",
  actionableSignals:
    "How many settled predictions were actual bet recommendations rather than passes.",
  signalAccuracy:
    "Of the settled bet recommendations, the share that won. Above 50% is necessary but not sufficient — the bets also have to have been priced well.",
  brier:
    "Accuracy score for the probability forecasts themselves: the average squared error between the predicted probability and what happened. 0 is perfect, 0.25 is what you would get by always guessing 50%, and lower is better.",
  historySignal:
    "What was recommended at the time: HIGH or LOW to buy that side, NO_BET to stand aside.",
  outcome: "How the market actually settled once the window closed.",
} as const;

export type StatKey = keyof typeof STAT_INFO;
