# SOFR / STIR Trading Dashboard

A trader-built cockpit for US short-term interest-rate futures — **SR3** (3-month SOFR), **ZQ** (Fed Funds) and **VX** (VIX) —
combining live prices, years of settlement history, the economic calendar and quantitative models in one browser page.

> **Open the demo:** open `index.html` through any static web server (or the GitHub Pages link of this repo).
> Without the desk's live feed it replays a **recorded market session**. The positions and P&L in the demo are **invented**.

---

## Why it exists

Relative-value trading on the SOFR curve (spreads, butterflies, double flies, multi-leg packages) lives on one question:
*which part of the curve is cheap or rich right now — against its neighbours, its own history and the data calendar?*
No off-the-shelf screen answered that in one place, so I built one. Every trade starts from evidence, has a defined risk,
and can be explained in a few lines.

## What's inside

| Section | Tab | What it does |
|---|---|---|
| **LIVE** | **Curve** | Live 3M-spread curve vs settle, positions decomposed into the 3M spreads they represent, live P&L split by structure |
| | **Opportunities** | Two independent scanners: *range signals* (with an honest walk-forward track record) and *PCA rich/cheap* (curve-model residuals, robustness across settings, out-of-sample backtest, 2022–23 hiking-cycle regime check, cost-adjusted net edge) |
| | **ZQ Meetings** | Live pricing of each FOMC meeting and meeting-vs-meeting structures |
| | **VIX** | VX curve, spreads / flies / double flies / ratio structures, seasonality by days-to-expiry with percentile ranks |
| **ANALYSIS** | **Scenario** | Drag FOMC outcomes, roll / shift / twist the curve, see every structure reprice; *Best Trades* ranks what benefits |
| | **SR3 History** | The whole curve on any two dates, from the settlement database |
| | **T&S History** | Where buying and selling volume concentrated (needs the desk's T&S service; empty in the demo) |
| | **Econ** | Release history (actual vs consensus) and an *Event Playbook*: how every part of the curve moved on hot vs soft prints |
| **TRADING** | **RV Builder** | Build any multi-leg package: contract order, net 3M-spread exposure, fixed-contract history through quarterly rolls, range stats, mean-reversion half-life, delta-neutral finder, same package across the curve |
| | **Trade** | Trade-planning board: scale-in ladders, exits and stops decided before entry |

## How it's built

```
 Excel trading workbook ──(Python, COM, every few s)──► sofr_live.json ─┐
 Markets database (SQLite, self-updating) ──(db_export.py)──► db/*.json ─┼──► index.html (HTML/JS + Chart.js)
 Economic releases ─────────────────────────────────────────────────────┘        served on the office LAN
```

- **`backend/live_feed.py`** — reads live prices, settles, meeting pricing, VIX and the book from the workbook and publishes JSON atomically.
- **`backend/db_export.py`** — exports SR3 / VX settlement history and US economic releases when a new day is published.
- **`backend/serve_dashboard.ps1`** — tiny LAN web server; private files (book, P&L log) are served to the local machine only.
- **Analytics in the browser** — z-scores, ranges, AR(1) half-lives, PCA (Jacobi eigen-decomposition), walk-forward backtests, event studies.
- **Design** — a compact graphite theme for long sessions: dense, no unnecessary scrolling, colour only where it means something.

## Demo mode

On GitHub Pages, with `?demo=1`, or whenever the live feed is missing, the page replays `demo/sofr_live.json` (a recorded session,
timestamp refreshed so the page behaves as if live) and `demo/pnl_history.jsonl`. The book in those files is fictional.

## Repository layout

```
index.html              the dashboard
tradeboard/             trade-planning board (Trade tab)
db/                     settlement history + economic releases (exported JSON)
demo/                   recorded session snapshot + invented book / P&L
backend/                live feed, database export, LAN server
docs/Presentation_Script.txt   narrative overview of the project
```

---
Built and used by a proprietary STIR trader. Not investment advice.
