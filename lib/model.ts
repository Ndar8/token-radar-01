// Token Radar model "comps-1": implied value from comparable protocols in the same snapshot.
//
// The snapshot records 758 protocols. 128 of them carry a market cap: their token trades, so the
// market has already priced a protocol of that shape. For each, the ratio mcap / TVL is one
// observation of what a unit of TVL is worth in that category. This model takes the median ratio
// of the candidate's own category (when at least three comparables exist there, else the global
// median over all 128), applies it to the candidate's TVL, and then adjusts for three things the
// snapshot also records: seven-day TVL momentum, how long the protocol has run, and how many
// chains it runs on. The p25 and p75 ratios of the same comparable set give a band around the
// point estimate. Every input is a snapshot field or a stated constant below, and every board row
// carries its inputs so the number can be re-derived by hand.
//
//   ratio      = median(mcap/tvl) of the category's comparables, clamped to [0.02, 3]
//                (global median when the category has fewer than 3 comparables). A thin
//                category's median, p25 and p75 are shrunk toward the global set with
//                weight n/(n+3), so a category priced from three peers cannot claim a
//                wild multiple on three observations; the shrinkage fades as n grows.
//   momentum   = 1 + clamp(change_7d, -50, 100) / 100 * 0.35        (unreported: 1)
//   age        = 0.85 + 0.15 * min(age_days, 1095) / 1095           (unknown age: 365 days)
//   chains     = 1 + 0.03 * min(max(chain_count - 1, 0), 10)
//   implied    = max(1, round(tvl * ratio * momentum * age * chains))
//   band       = the same product with the p25 and p75 ratios in place of the median
//
// The board ranks protocols that record no token on DefiLlama (mcap, gecko_id and symbol all
// null) and are not a wrapped, staked or bridged product of a token that already trades — the
// same screen the snapshot's watchlist uses. The watchlist is included in full, screen or not:
// it is the floor. Protocols whose token already trades are never ranked; they are the
// comparables, and the dashboard shows them apart with the market's own numbers.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'comps-2';

/** The model's stated constants. Everything else is derived from the snapshot at run time. */
export const CONSTANTS = {
  min_comparables: 3, // a category needs this many tokenized protocols before its own median is used
  shrink_k: 3, // pseudo-count: a category's ratios are weighted n/(n+shrink_k) against the global set
  ratio_floor: 0.02,
  ratio_cap: 3,
  band_floor: 0.005,
  band_cap: 5,
  momentum_weight: 0.35,
  momentum_floor_pct: -50,
  momentum_cap_pct: 100,
  age_base: 0.85,
  age_range: 0.15,
  age_full_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.03,
  chain_cap: 10,
  live_rows: 30, // tokenized protocols shown in the dashboard's live view, by market cap
} as const;

export type Constants = typeof CONSTANTS;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Whole days from `listedAt` to `asOf` (UTC), clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Records no token on DefiLlama: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// The watchlist's own screen, restated: a wrapped, staked or bridged product of a token that
// already trades is not a protocol still waiting on a launch of its own.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a no-token-recorded protocol is a launch candidate rather than a product of a traded token. */
export function passesScreen(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

// ---------------------------------------------------------------- comparables

/** One comparable set's ratio statistics. */
export interface RatioStats {
  n: number;
  median: number;
  p25: number;
  p75: number;
}

/** Median of a sorted array (mean of the two middles when even). */
function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile of a sorted array. */
function percentileOf(sorted: number[], q: number): number {
  const idx = clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
}

function statsOf(ratios: number[]): RatioStats {
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: medianOf(sorted),
    p25: percentileOf(sorted, 0.25),
    p75: percentileOf(sorted, 0.75),
  };
}

/** The comparable sets: one global, one per category with at least `min_comparables` members. */
export interface Comparables {
  global: RatioStats;
  byCategory: Map<string, RatioStats>;
  /**
   * Every category that has any comparable, for the methodology table. median/p25/p75 are the
   * ratios actually used for pricing (shrunk toward the global set); raw_median is the
   * category's own unshrunk median, kept so the shrinkage is visible, never hidden.
   */
  table: { category: string; n: number; median: number; p25: number; p75: number; raw_median: number; used: boolean }[];
}

/** One ratio statistic pulled toward the global set by sample size: (n*own + k*global)/(n+k). */
function shrunk(own: RatioStats, global: RatioStats, k: number): RatioStats {
  const blend = (a: number, b: number): number => (own.n * a + k * b) / (own.n + k);
  return { n: own.n, median: blend(own.median, global.median), p25: blend(own.p25, global.p25), p75: blend(own.p75, global.p75) };
}

export function buildComparables(snapshot: Snapshot, c: Constants = CONSTANTS): Comparables {
  const all: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '(none)';
    const list = perCategory.get(key) ?? [];
    list.push(ratio);
    perCategory.set(key, list);
  }
  const global = statsOf(all);
  const byCategory = new Map<string, RatioStats>();
  const table: Comparables['table'] = [];
  for (const [category, ratios] of perCategory) {
    const raw = statsOf(ratios);
    const used = raw.n >= c.min_comparables;
    const stats = used ? shrunk(raw, global, c.shrink_k) : raw;
    if (used) byCategory.set(category, stats);
    table.push({
      category,
      n: raw.n,
      median: round4(stats.median),
      p25: round4(stats.p25),
      p75: round4(stats.p75),
      raw_median: round4(raw.median),
      used,
    });
  }
  table.sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  return { global, byCategory, table };
}

/** The ratio set one candidate is priced with: its category's when it has one, else the global set. */
export function ratioSetFor(p: SnapshotProtocol, comps: Comparables): { stats: RatioStats; source: 'category' | 'global' } {
  const own = p.category === null ? undefined : comps.byCategory.get(p.category);
  return own !== undefined ? { stats: own, source: 'category' } : { stats: comps.global, source: 'global' };
}

// ---------------------------------------------------------------- scoring

export interface Score {
  implied: number;
  low: number;
  high: number;
  ratio: number;
  ratioSource: 'category' | 'global';
  ratioN: number;
  momentumMult: number;
  ageMult: number;
  chainMult: number;
  age: number | null;
  growthReported: boolean;
}

/**
 * One protocol's implied value and band, with every multiplier that produced them. The ratio and
 * multipliers are rounded to 4 decimals before the product, so the dashboard — which receives
 * exactly those rounded figures — recomputes the same integers from the same inputs.
 */
export function score(p: SnapshotProtocol, asOf: string, comps: Comparables, c: Constants = CONSTANTS): Score {
  const { stats, source } = ratioSetFor(p, comps);
  const ratio = round4(clamp(stats.median, c.ratio_floor, c.ratio_cap));
  const ratioLow = round4(clamp(stats.p25, c.band_floor, c.band_cap));
  const ratioHigh = round4(clamp(stats.p75, c.band_floor, c.band_cap));
  const growthReported = p.change_7d !== null && Number.isFinite(p.change_7d);
  const growthPct = growthReported ? clamp(p.change_7d!, c.momentum_floor_pct, c.momentum_cap_pct) : 0;
  const momentumMult = round4(1 + (growthPct / 100) * c.momentum_weight);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? c.unknown_age_days;
  const ageMult = round4(c.age_base + c.age_range * (Math.min(ageForModel, c.age_full_days) / c.age_full_days));
  const chainMult = round4(1 + c.chain_step * Math.min(Math.max(p.chains.length - 1, 0), c.chain_cap));
  const rest = momentumMult * ageMult * chainMult;
  const implied = Math.max(1, Math.round(p.tvl_usd * ratio * rest));
  const low = Math.max(1, Math.round(p.tvl_usd * ratioLow * rest));
  const high = Math.max(implied, Math.round(p.tvl_usd * ratioHigh * rest));
  return {
    implied,
    low: Math.min(low, implied),
    high,
    ratio,
    ratioSource: source,
    ratioN: stats.n,
    momentumMult,
    ageMult,
    chainMult,
    age,
    growthReported,
  };
}

// ---------------------------------------------------------------- farm plans

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One step as a single string inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Then keep the position open and check the protocol's own page weekly.`;
  return s;
}

/** Capital for one farm position, sized by the protocol's own TVL so the position stays a small share. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** Hold window: a younger protocol gets a longer qualifying window before any snapshot is likely. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

interface PlanTemplate {
  primary: (name: string, capital: number, chain: string) => string;
  secondary: (name: string, capital: number, chain: string) => string;
  weekly: string;
}

const has = (cat: string, ...words: string[]): boolean => words.some((w) => cat.includes(w));

/** The category's concrete actions. Category strings are DefiLlama's; matching is by substring. */
function templateFor(p: SnapshotProtocol): PlanTemplate {
  const c = (p.category ?? '').toLowerCase();
  if (c === 'dexs' || has(c, 'liquidity manager')) {
    return {
      primary: (n, k, ch) => `Add $${k} of liquidity to ${n}'s deepest pool on ${ch}, split evenly between the pair's two assets, and keep the LP position open.`,
      secondary: (n, k, ch) => `Swap $${Math.max(10, Math.round(k / 5))} through ${n} on ${ch} in both directions so the wallet shows trading volume as well as liquidity.`,
      weekly: 'make one swap or one small liquidity top-up each week so the wallet stays active in every snapshot window',
    };
  }
  if (has(c, 'lend', 'cdp', 'collateral', 'uncollateralized')) {
    return {
      primary: (n, k, ch) => `Supply $${k} of USDC (or the chain's main stablecoin) to ${n} on ${ch} and leave it supplied.`,
      secondary: (n, k) => `Borrow about $${Math.max(5, Math.round(k / 4))} against that supply on ${n}, keep the health factor above 1.5, and repay half of it a week later.`,
      weekly: 'top up the supply or repay and re-borrow a small amount each week so both sides of the market see the wallet',
    };
  }
  if (has(c, 'yield', 'farm', 'leveraged')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} into ${n}'s main vault or farm on ${ch} and keep the receipt shares in the wallet.`,
      secondary: (n) => `Claim the vault's rewards on ${n} once and re-deposit them instead of withdrawing, so the position compounds in place.`,
      weekly: 'compound or add a small deposit each week rather than withdrawing, so the balance only grows',
    };
  }
  if (has(c, 'derivative', 'perpetual', 'basis', 'options', 'synthetic', 'interest rate')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} of USDC as margin on ${n} (${ch}) and open one small long and one small short, sized so liquidation is far away.`,
      secondary: (n) => `Close and re-open one of the positions on ${n} after a few days so the account shows round-trip trading volume, not a single dormant trade.`,
      weekly: 'place at least one small trade each week and keep the margin topped up; volume over time is what points programs count',
    };
  }
  if (has(c, 'bridge')) {
    return {
      primary: (n, k, ch) => `Bridge $${k} of USDC through ${n} to ${ch}, then use the bridged funds in one app on the destination chain.`,
      secondary: (n, k) => `Bridge about $${Math.max(10, Math.round(k / 2))} back through ${n} a week later so the wallet shows volume in both directions.`,
      weekly: 'make one bridge transfer each week, alternating direction, and keep the amounts similar',
    };
  }
  if (has(c, 'staking', 'restak', 'btc')) {
    return {
      primary: (n, k, ch) => `Stake $${k} of the staking asset through ${n} on ${ch} and keep the liquid receipt token in the wallet.`,
      secondary: (n) => `Put the receipt token to work once (supply it as collateral or into a pool that accepts it) so ${n} sees the receipt used, not just minted.`,
      weekly: 'add a small amount to the stake each week and leave the receipt untouched between additions',
    };
  }
  if (has(c, 'curator', 'allocator')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} into a ${n} vault on ${ch} and hold the vault shares.`,
      secondary: (n, k) => `Move about $${Math.max(10, Math.round(k / 4))} of the position into a second ${n} vault with a different strategy so the wallet is not tied to one vault.`,
      weekly: 'add a small deposit each week and check the vault page for any points or rewards tab',
    };
  }
  if (has(c, 'stable', 'reserve currency')) {
    return {
      primary: (n, k, ch) => `Mint or buy $${k} of ${n}'s stable asset on ${ch} and hold it in the wallet.`,
      secondary: (n, k) => `Use about $${Math.max(10, Math.round(k / 2))} of it in one pool or payment on ${n} so the balance is used, not only held.`,
      weekly: 'make one transfer or pool deposit with the stable asset each week and keep the rest held',
    };
  }
  if (has(c, 'rwa')) {
    return {
      primary: (n, k, ch) => `Mint $${k} of ${n}'s tokenized yield asset on ${ch} and hold it; complete any identity check the app itself requires.`,
      secondary: (n) => `Reinvest the first yield payout on ${n} back into the same asset instead of withdrawing it.`,
      weekly: 'check the asset page weekly, reinvest payouts, and add a small amount when fees are low',
    };
  }
  if (has(c, 'prediction')) {
    return {
      primary: (n, k) => `Fund the account with $${k} and place one position on a liquid market on ${n}, sized so a total loss is acceptable.`,
      secondary: (n) => `Trade one more market on ${n} in a different category (for example sports after politics) so the account is not a single bet.`,
      weekly: 'place one small trade each week and let some positions settle rather than cashing out early',
    };
  }
  if (has(c, 'insurance')) {
    return {
      primary: (n, k, ch) => `Buy $${k} of cover through ${n} on ${ch} for an asset you actually hold, and keep the policy active.`,
      secondary: (n) => `If ${n} lets users underwrite, stake a small amount in its underwriting pool as well, so the wallet appears on both sides.`,
      weekly: 'renew or top up the cover each week before it lapses',
    };
  }
  if (has(c, 'launchpad')) {
    return {
      primary: (n, k, ch) => `Take part in one launch on ${n} (${ch}) with about $${k}, following the sale's own rules and lockups.`,
      secondary: (n) => `Hold the launched token in the wallet past its first week instead of selling at listing, and join the next launch the same way.`,
      weekly: 'join one launch or sale each week it runs and keep the received tokens held',
    };
  }
  if (has(c, 'marketplace', 'otc')) {
    return {
      primary: (n, k, ch) => `Make one real trade of about $${k} on ${n} (${ch}) and keep the bought asset in the wallet.`,
      secondary: (n) => `List one asset for sale on ${n} at a fair price so the wallet shows maker activity as well as taker activity.`,
      weekly: 'make one trade or listing each week and avoid wash trading the same asset back and forth',
    };
  }
  if (has(c, 'payment', 'card')) {
    return {
      primary: (n, k, ch) => `Load $${k} into ${n} on ${ch} and make one real payment or transfer with it.`,
      secondary: (n) => `Make a second, different kind of transaction on ${n} (a top-up after a payment, or the reverse) so the account shows more than one flow.`,
      weekly: 'make at least one payment or transfer each week and keep a small balance loaded',
    };
  }
  if (has(c, 'privacy')) {
    return {
      primary: (n, k, ch) => `Move $${k} through ${n} on ${ch} using its standard privacy flow, following the app's own guidance.`,
      secondary: (n, k) => `Make a second, smaller transfer of about $${Math.max(5, Math.round(k / 4))} on ${n} a few days later so usage is spread over time.`,
      weekly: 'make one small transfer each week and keep amounts unremarkable',
    };
  }
  if (has(c, 'index')) {
    return {
      primary: (n, k, ch) => `Buy $${k} of ${n}'s index token on ${ch} and hold it in the wallet.`,
      secondary: (n) => `Add a small amount to the index position on ${n} after the first rebalance so the wallet holds through a rebalance.`,
      weekly: 'add a small amount each week and do not sell between rebalances',
    };
  }
  if (has(c, 'locker')) {
    return {
      primary: (n, k, ch) => `Lock $${k} of tokens through ${n} on ${ch} for the shortest lock the app offers, and keep the lock receipt.`,
      secondary: (n) => `Extend the lock once on ${n} before it expires so the position spans more than one snapshot.`,
      weekly: 'check the lock weekly and extend it before expiry rather than letting it lapse',
    };
  }
  if (has(c, 'governance')) {
    return {
      primary: (n, k, ch) => `Delegate or stake $${k} worth of voting power through ${n} on ${ch} and cast one vote.`,
      secondary: (n) => `Vote in the next proposal on ${n} as well, and leave a short forum comment so the participation is visible.`,
      weekly: 'vote in each new proposal and keep the delegation in place between votes',
    };
  }
  if (/\bai\b/.test(c)) {
    return {
      primary: (n, k, ch) => `Use ${n}'s product on ${ch} with about $${k} of credits or stake, completing one full task end to end.`,
      secondary: (n) => `Run a second, different task on ${n} a few days later so the account shows repeated real use.`,
      weekly: 'complete at least one task each week and keep any credits or stake in place',
    };
  }
  return {
    primary: (n, k, ch) => `Deposit $${k} of USDC into ${n}'s core product on ${ch} and keep the position open.`,
    secondary: (n) => `Use a second feature of ${n} once (a swap, a vote, a second pool or vault) so the wallet is not a single deposit.`,
    weekly: 'make one qualifying action each week, such as a deposit, a swap or a vote',
  };
}

/**
 * One protocol's farm plan: six concrete steps with a cost and a time each, derived from the
 * protocol's own record (category, chains, TVL, age). No name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const t = templateFor(p);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: 'Set up a fresh wallet for this farm, fund it only with what the plan needs, and keep the seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: t.primary(p.name, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: t.secondary(p.name, capital, chain),
      cost: 'about $2 to $5 of gas',
      time: '10 minutes',
    },
    {
      text: `Keep the position for at least ${hold} days and ${t.weekly}.`,
      cost: `the $${capital} stays in the position, plus about $2 of gas a week`,
      time: `${hold} days, 10 minutes a week`,
    },
    {
      text: `Watch ${p.name}'s own site and official channels for a points program or token announcement, and claim only from links the protocol itself publishes; never pay anyone to claim.`,
      cost: 'nothing to check',
      time: '5 minutes a week',
    },
    {
      text: 'Log the wallet, dates, amounts and transaction hashes in a farm notebook so the position can be repeated, topped up or unwound on purpose.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  model: {
    ratio: number;
    ratio_source: 'category' | 'global';
    ratio_n: number;
    momentum_multiplier: number;
    age_multiplier: number;
    chain_multiplier: number;
    growth_reported: boolean;
  };
  farm_steps: string[];
}

/** The ranked board: the whole watchlist plus every other screened no-token-recorded protocol. */
export function buildBoard(snapshot: Snapshot, comps: Comparables, c: Constants = CONSTANTS): BoardRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter(
    (p) => watchlist.has(p.slug) || (recordsNoToken(p) && passesScreen(p)),
  );
  const scored = chosen.map((p) => ({ p, s: score(p, snapshot.as_of, comps, c) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.age,
    on_watchlist: watchlist.has(p.slug),
    implied_value_usd: s.implied,
    implied_low_usd: s.low,
    implied_high_usd: s.high,
    model: {
      ratio: s.ratio,
      ratio_source: s.ratioSource,
      ratio_n: s.ratioN,
      momentum_multiplier: s.momentumMult,
      age_multiplier: s.ageMult,
      chain_multiplier: s.chainMult,
      growth_reported: s.growthReported,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  }));
}

/** A tokenized protocol for the live view: the market's own numbers, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

export function liveRows(snapshot: Snapshot, c: Constants = CONSTANTS): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, c.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

// ---------------------------------------------------------------- dashboard data

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  ratio: number;
  ratio_source: 'category' | 'global';
  ratio_n: number;
  momentum_multiplier: number;
  age_multiplier: number;
  chain_multiplier: number;
  growth_reported: boolean;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: Constants;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  comparable_count: number;
  global_ratio: RatioStats;
  category_ratios: Comparables['table'];
  rows: RadarRow[];
  live: LiveRow[];
}

export function buildRadar(snapshot: Snapshot, c: Constants = CONSTANTS): { board: BoardRow[]; radar: RadarData } {
  const comps = buildComparables(snapshot, c);
  const board = buildBoard(snapshot, comps, c);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    constants: c,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    comparable_count: comps.global.n,
    global_ratio: {
      n: comps.global.n,
      median: round4(comps.global.median),
      p25: round4(comps.global.p25),
      p75: round4(comps.global.p75),
    },
    category_ratios: comps.table,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      on_watchlist: r.on_watchlist,
      implied_value_usd: r.implied_value_usd,
      implied_low_usd: r.implied_low_usd,
      implied_high_usd: r.implied_high_usd,
      ratio: r.model.ratio,
      ratio_source: r.model.ratio_source,
      ratio_n: r.model.ratio_n,
      momentum_multiplier: r.model.momentum_multiplier,
      age_multiplier: r.model.age_multiplier,
      chain_multiplier: r.model.chain_multiplier,
      growth_reported: r.model.growth_reported,
    })),
    live: liveRows(snapshot, c),
  };
  return { board, radar };
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------- snapshot parsing

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((x): x is string => typeof x === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's board rows. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const slugs = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `row slug ${r.slug} is not a snapshot protocol`;
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
    if (r.name.trim().length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outvalues rank ${i}`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}
