---
title: vault 76 — building a fallout 76 themed trading arsenal with a wheel strategy
---

A full day on the personal trading project. The headline is a new options income strategy called The Scavenger, but the more interesting thread is what happened when we named everything after Fallout 76.

## why theming matters

The trading system had accumulated a regime classifier, a signal scanner, a paper portfolio, and a backtest runner — all in a flat directory with names like `trend_scanner.py` and `backtest_combo.py`. Functional, but no coherent identity.

Renaming everything with Fallout 76 terminology wasn't cosmetic. It forced a cleaner architecture because the theme has a built-in hierarchy: The Overseer runs the Vault, Dwellers carry Perk Cards, and you only deploy certain cards in certain conditions. That maps directly onto "classifier decides which strategies to run."

The full glossary is in `vault76/GLOSSARY.md`. Key terms:

| Trading concept | Fallout 76 term |
|---|---|
| Overall system | Vault 76 |
| Market regime classifier | The Overseer |
| Bull market | Reclamation Day |
| Bear / sideways | The Wasteland |
| Crash (VIX ≥ 30) | Nuked Zone |
| Individual strategy | Perk Card |
| P&L report | Pip-Boy |

## the overseer

`vault76/overseer.py` classifies the market into one of three regimes each morning:

```python
def classify(self, spy_df, vix=20.0) -> str:
    if vix >= 30:
        return self.NUKED_ZONE

    ind  = compute_indicators(spy_df).dropna()
    last = ind.iloc[-1]
    prev = ind.iloc[-6]

    above_ema50  = last["close"] > last["ema50"]
    ema50_rising = last["ema50"] > prev["ema50"]

    if above_ema50 and ema50_rising:
        return self.RECLAMATION
    return self.WASTELAND
```

Today's reading: **Reclamation Day** — SPY above its EMA50, VIX at 18.4.

The `recommend_perk_cards()` method maps regimes to strategies. In Nuked Zone, nothing deploys. In the Wasteland, The Scavenger is primary.

## the raider — perk card #001

The pullback-in-trend strategy got renamed from Scavenger to Raider. Raiders are aggressive — they attack when targets show weakness. The logic fits: enter when a strongly trending stock dips, ride the bounce.

Three conditions all required:
1. **Uptrend confirmed**: EMA20 > EMA50, EMA50 rising
2. **Real pullback**: RSI dipped below 47 in last 5 bars (not below 28 — no falling knives), price touched within 4% of EMA20
3. **Bounce entry**: RSI turning up + green candle + above EMA20 + volume returning + ADX > 20

Exit on trend-end (EMA20 crosses below EMA50) or +5×ATR. No fixed stop. Parameters tuned from a sweep over 11 symbols — RSI<47 + ADX>20 gave the best win rate.

## the scavenger — perk card #002

The new card. A wheel strategy for sideways stocks.

The premise: if a stock isn't trending (ADX < 20), The Raider won't fire on it. But you can still earn income by selling options against it.

**Phase 1 — cash-secured put:**

When ADX < 20, RSI is neutral (35–65), and historical vol is at least 20%:

```python
strike  = round(close * 0.95, 0)          # 5% OTM
T       = 30 / 365
premium = black_scholes_put(close, strike, T, 0.05, hv)
```

Sell the put, collect premium (~0.5–2% of stock price), wait 30 trading days. If the stock stays above strike, keep the full premium. If it drops below strike, you get assigned 100 shares at an effective cost of `strike - premium`.

**Phase 2 — covered call:**

Once assigned, sell a call 8% above the reference price (max of current price and cost basis):

```python
reference = max(close, cost_basis)
strike    = round(reference * 1.08, 0)
premium   = black_scholes_call(close, strike, T, 0.05, hv)
```

If the stock gets called away, you profit from the share gain plus all accumulated premiums. If the call expires, sell another one. Repeat until called away.

The `should_deploy()` check blocks the card entirely in Nuked Zone — IV looks attractive during crashes but assignment risk is catastrophic.

## backtesting the scavenger

Walk-forward simulation on 2 years of daily data, 1 contract per symbol:

| Symbol | Wheel P&L | B&H P&L | Edge |
|---|---|---|---|
| META | +$7,308 | -$1,853 | +$9,161 |
| MSFT | +$4,683 | -$4,145 | +$8,828 |
| AMZN | +$4,964 | +$2,560 | +$2,404 |
| AMD | +$7,519 | +$37,648 | -$30,129 |
| GOOGL | +$2,069 | +$16,200 | -$14,131 |

The pattern is clear. The Scavenger wins on stocks that went sideways or down (META lost 3.3% on B&H; the wheel collected $7K in premium). It loses badly on big runners — AMD went up 260% in this period, and the 8% OTM call cap means you get called away early and miss most of the move.

This is expected and structural. The Scavenger is not meant for AMD. That's The Raider's job.

## finding better targets

The key question: which stocks are sideways *most* of the time? Computed the fraction of trading days where ADX < 20 across classic blue chips:

| Symbol | % time sideways | Notes |
|---|---|---|
| MMM | 61% | ADX median 18 — structurally range-bound |
| PG | 61% | Consumer staples, mean-reverting |
| XOM | 55% | Energy, oil-price driven chop |
| VZ | 46% | Telco — boring by design |
| MCD | 45% | Fast food margins are stable |

Added MMM, PG, XOM to the watchlist. Backtest on just these three:

| Symbol | Wheel | B&H | Edge |
|---|---|---|---|
| MMM | +$5,234 | +$3,483 | +$1,751 |
| PG | +$616 | -$2,352 | +$2,968 |
| XOM | +$3,614 | +$2,438 | +$1,176 |

PG is the standout: B&H lost $2,352 while the wheel collected $616 in pure premium — five puts sold, all expired worthless, never even got assigned. The strategy worked exactly as designed.

## one design issue worth noting

The state machine jumps directly to the expiry bar rather than simulating every intermediate day:

```python
state = PUT_OPEN
i     = cycle["put_expiry_i"]   # jump directly to expiry bar
```

This is a European-style approximation — no early assignment, no marking to market. Real brokers can (and sometimes do) assign early on deep ITM puts. In practice this is rare for cash-secured puts since early assignment gives away time value, but it's worth noting the backtest is slightly optimistic on that dimension.

## startup briefing to slack

Added a daily briefing that fires when the scanner starts, printed to terminal and posted to Slack:

```
*VAULT 76 — Daily Briefing* 2026-06-30 09:00:12
*Mode:* 📄 PAPER TRADING
*Regime:* Reclamation Day — bull market, rebuilding in progress
*Active cards:* RAIDER, SCAVENGER
*Watchlist (14):* NVDA AMD AAPL AMZN META MSFT GOOGL IBM INTC IONQ KO MMM PG XOM
*Scan interval:* 5 min | *Budget/trade:* $600
*Cash available:* $10,000.00
```

The regime fetch runs at startup before the market opens, so by the time the first scan fires you already know which cards are active.

## what's next

Paper trading starts Monday. The plan is 4–6 weeks of paper mode before risking real capital — enough time to see how the regime calls hold up in practice and whether the Raider's signal frequency is reasonable. Future perk cards: The Chemist (options volatility plays for Nuked Zone recovery) and The Trader (momentum breakout for full Reclamation runs).
