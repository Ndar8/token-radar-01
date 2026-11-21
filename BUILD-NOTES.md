# token-radar-01 — build notes

Entry for the make.fun "token-radar-01" bounty. Built from the kit starter in
`../token-radar-01-kit/starter/`; `vendor/makefun-board.ts` is byte-identical to the kit's.
Not submitted; no repo created; make.fun login untouched.

## Model ("comps-1", lib/model.ts)

- Comparables: the 128 snapshot protocols with a market cap on record. Their observed
  mcap/TVL ratios give a median per category (used when the category has ≥3 comparables)
  and a global median (0.214) otherwise. Ratio clamped to [0.02, 3].
- implied = round(TVL × ratio × momentum × age × chains), where
  momentum = 1 + clamp(change_7d, −50, 100)/100 × 0.35 (unreported → 1),
  age = 0.85 + 0.15 × min(age_days, 1095)/1095 (unknown → 365d),
  chains = 1 + 0.03 × min(chains − 1, 10).
- Band: same product with the comparables' p25/p75 ratios (clamped [0.02, 5]).
- Board: all 40 watchlist protocols + every other protocol that records no token on
  DefiLlama and passes the watchlist's own exclusion screen (wrapped/staked/bridged
  products of traded tokens, versioned names, exchange prefixes) → 198 rows.
- Farm plans: 6 steps per protocol, category templates (DEX swaps/LP, lending
  supply/borrow, yield deposit, perp margin/trades, bridge volume, staking, …),
  capital sized by TVL tier ($25–$250), hold window by age (30/45/60d), every step
  states cost + time. Wording is always "records no token on DefiLlama".
- The dashboard recomputes every implied value, band and farm plan in-page from the
  shipped inputs (model.ts rounds ratio/multipliers to 4dp before the product so the
  recompute is exact) and the detail view shows the match against board.json.

## Run locally

    cd entry && mkdir -p out
    MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

Writes out/board.json, out/data.js, out/dashboard/, out/screenshots/, out/dossier.json.
(`out/` was deleted after verification — it is regenerable build output.)

## Verified 2026-11-21

- board.json: 198 rows, ranks 1..198, implied strictly non-increasing, 40/40 watchlist
  present, farm steps 6 per row, all within 20–600 chars, bands sane.
- Two consecutive runs byte-identical (board.json, data.js, dossier.json md5 match).
- dossier.json 731,688 B (≤1.5MiB); board.json 329,802 B; data.js 102,228 B.
- Dashboard: 3 files, 55,739 B total, zero http(s) references; renders from file://
  with no network.
- Playwright (Chromium 131, headless): in-page recompute matches board.json for all
  198 rows (implied, band, farm steps — 0 mismatches); Dexs filter renders 21 rows;
  no page errors. Screenshots 1440×900, 197–235 KB each (≤512KiB): board, rank-1
  detail (Steakhouse Financial), Dexs-filtered board.
- Screenshot tooling lives OUTSIDE the entry (../shots-tool/, ../pw/) so the entry
  stays lean. Note: /tmp on this VM is a 512MB tmpfs — the first Chromium install
  corrupted itself when /tmp filled; install browsers on the home disk instead.

## Files

- main.ts — entry point (starter structure, paths as the sandbox expects)
- lib/model.ts — comparables, scoring, farm-plan derivation
- dashboard/index.html, app.css, app.js — static dashboard (no network)
- vendor/makefun-board.ts — kit vendor file, untouched
- screenshots/1-board.png, 2-detail.png, 3-filtered.png
- LICENSE — MIT (from starter)
