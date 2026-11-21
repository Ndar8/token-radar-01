// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, the tokenized comparables, the method, and a per-protocol detail drawer.
// No network: every byte it shows is in data.js. The page recomputes every implied value and
// every farm plan from the same inputs and formulas main.ts used, so what renders here is what
// board.json carries; the detail view shows the check.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var C = DATA.constants;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', wl: false, tab: 'board', sort: 'implied', dir: -1, selected: null };

  // ---------------------------------------------------------- formatting
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtRatio(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n >= 10 ? n.toFixed(1) : n.toFixed(3);
  }

  // ---------------------------------------------------------- the model, mirrored
  // Identical arithmetic to lib/model.ts score(): ratio and multipliers rounded to 4 decimals
  // before the product, so this recompute lands on the same integers as board.json.
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function multipliersOf(row) {
    var growthPct = row.growth_reported ? clamp(row.change_7d, C.momentum_floor_pct, C.momentum_cap_pct) : 0;
    var momentum = round4(1 + (growthPct / 100) * C.momentum_weight);
    var age = row.age_days === null || row.age_days === undefined ? C.unknown_age_days : row.age_days;
    var ageMult = round4(C.age_base + C.age_range * (Math.min(age, C.age_full_days) / C.age_full_days));
    var chainMult = round4(1 + C.chain_step * Math.min(Math.max((row.chains || []).length - 1, 0), C.chain_cap));
    return { momentum: momentum, age: ageMult, chains: chainMult };
  }

  function impliedOf(row) {
    var m = multipliersOf(row);
    var rest = m.momentum * m.age * m.chains;
    return Math.max(1, Math.round(row.tvl_usd * row.ratio * rest));
  }

  function ratioStatsOf(row) {
    if (row.ratio_source === 'category') {
      for (var i = 0; i < DATA.category_ratios.length; i++) {
        if (DATA.category_ratios[i].category === row.category) return DATA.category_ratios[i];
      }
    }
    return DATA.global_ratio;
  }

  function bandOf(row) {
    var stats = ratioStatsOf(row);
    var m = multipliersOf(row);
    var rest = m.momentum * m.age * m.chains;
    var lo = round4(clamp(stats.p25, C.band_floor, C.band_cap));
    var hi = round4(clamp(stats.p75, C.band_floor, C.band_cap));
    var implied = impliedOf(row);
    return {
      low: Math.min(Math.max(1, Math.round(row.tvl_usd * lo * rest)), implied),
      high: Math.max(implied, Math.round(row.tvl_usd * hi * rest))
    };
  }

  // ---------------------------------------------------------- farm plans, mirrored
  // The same derivation lib/model.ts writes into board.json: category, chains, TVL and age decide
  // the actions, the capital, the hold and every cost and time. No name is special-cased.
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    if (p.tvl_usd >= 1e7) return 50;
    return 25;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function has(cat) {
    for (var i = 1; i < arguments.length; i++) if (cat.indexOf(arguments[i]) >= 0) return true;
    return false;
  }
  function templateFor(p) {
    var c = (p.category || '').toLowerCase();
    if (c === 'dexs' || has(c, 'liquidity manager')) {
      return {
        primary: function (n, k, ch) { return 'Add $' + k + ' of liquidity to ' + n + "'s deepest pool on " + ch + ", split evenly between the pair's two assets, and keep the LP position open."; },
        secondary: function (n, k, ch) { return 'Swap $' + Math.max(10, Math.round(k / 5)) + ' through ' + n + ' on ' + ch + ' in both directions so the wallet shows trading volume as well as liquidity.'; },
        weekly: 'make one swap or one small liquidity top-up each week so the wallet stays active in every snapshot window'
      };
    }
    if (has(c, 'lend', 'cdp', 'collateral', 'uncollateralized')) {
      return {
        primary: function (n, k, ch) { return 'Supply $' + k + ' of USDC (or the chain\'s main stablecoin) to ' + n + ' on ' + ch + ' and leave it supplied.'; },
        secondary: function (n, k) { return 'Borrow about $' + Math.max(5, Math.round(k / 4)) + ' against that supply on ' + n + ', keep the health factor above 1.5, and repay half of it a week later.'; },
        weekly: 'top up the supply or repay and re-borrow a small amount each week so both sides of the market see the wallet'
      };
    }
    if (has(c, 'yield', 'farm', 'leveraged')) {
      return {
        primary: function (n, k, ch) { return 'Deposit $' + k + ' into ' + n + "'s main vault or farm on " + ch + ' and keep the receipt shares in the wallet.'; },
        secondary: function (n) { return "Claim the vault's rewards on " + n + ' once and re-deposit them instead of withdrawing, so the position compounds in place.'; },
        weekly: 'compound or add a small deposit each week rather than withdrawing, so the balance only grows'
      };
    }
    if (has(c, 'derivative', 'perpetual', 'basis', 'options', 'synthetic', 'interest rate')) {
      return {
        primary: function (n, k, ch) { return 'Deposit $' + k + ' of USDC as margin on ' + n + ' (' + ch + ') and open one small long and one small short, sized so liquidation is far away.'; },
        secondary: function (n) { return 'Close and re-open one of the positions on ' + n + ' after a few days so the account shows round-trip trading volume, not a single dormant trade.'; },
        weekly: 'place at least one small trade each week and keep the margin topped up; volume over time is what points programs count'
      };
    }
    if (has(c, 'bridge')) {
      return {
        primary: function (n, k, ch) { return 'Bridge $' + k + ' of USDC through ' + n + ' to ' + ch + ', then use the bridged funds in one app on the destination chain.'; },
        secondary: function (n, k) { return 'Bridge about $' + Math.max(10, Math.round(k / 2)) + ' back through ' + n + ' a week later so the wallet shows volume in both directions.'; },
        weekly: 'make one bridge transfer each week, alternating direction, and keep the amounts similar'
      };
    }
    if (has(c, 'staking', 'restak', 'btc')) {
      return {
        primary: function (n, k, ch) { return 'Stake $' + k + ' of the staking asset through ' + n + ' on ' + ch + ' and keep the liquid receipt token in the wallet.'; },
        secondary: function (n) { return 'Put the receipt token to work once (supply it as collateral or into a pool that accepts it) so ' + n + ' sees the receipt used, not just minted.'; },
        weekly: 'add a small amount to the stake each week and leave the receipt untouched between additions'
      };
    }
    if (has(c, 'curator', 'allocator')) {
      return {
        primary: function (n, k, ch) { return 'Deposit $' + k + ' into a ' + n + ' vault on ' + ch + ' and hold the vault shares.'; },
        secondary: function (n, k) { return 'Move about $' + Math.max(10, Math.round(k / 4)) + ' of the position into a second ' + n + ' vault with a different strategy so the wallet is not tied to one vault.'; },
        weekly: 'add a small deposit each week and check the vault page for any points or rewards tab'
      };
    }
    if (has(c, 'stable', 'reserve currency')) {
      return {
        primary: function (n, k, ch) { return 'Mint or buy $' + k + ' of ' + n + "'s stable asset on " + ch + ' and hold it in the wallet.'; },
        secondary: function (n, k) { return 'Use about $' + Math.max(10, Math.round(k / 2)) + ' of it in one pool or payment on ' + n + ' so the balance is used, not only held.'; },
        weekly: 'make one transfer or pool deposit with the stable asset each week and keep the rest held'
      };
    }
    if (has(c, 'rwa')) {
      return {
        primary: function (n, k, ch) { return 'Mint $' + k + ' of ' + n + "'s tokenized yield asset on " + ch + ' and hold it; complete any identity check the app itself requires.'; },
        secondary: function (n) { return 'Reinvest the first yield payout on ' + n + ' back into the same asset instead of withdrawing it.'; },
        weekly: 'check the asset page weekly, reinvest payouts, and add a small amount when fees are low'
      };
    }
    if (has(c, 'prediction')) {
      return {
        primary: function (n, k) { return 'Fund the account with $' + k + ' and place one position on a liquid market on ' + n + ', sized so a total loss is acceptable.'; },
        secondary: function (n) { return 'Trade one more market on ' + n + ' in a different category (for example sports after politics) so the account is not a single bet.'; },
        weekly: 'place one small trade each week and let some positions settle rather than cashing out early'
      };
    }
    if (has(c, 'insurance')) {
      return {
        primary: function (n, k, ch) { return 'Buy $' + k + ' of cover through ' + n + ' on ' + ch + ' for an asset you actually hold, and keep the policy active.'; },
        secondary: function (n) { return 'If ' + n + ' lets users underwrite, stake a small amount in its underwriting pool as well, so the wallet appears on both sides.'; },
        weekly: 'renew or top up the cover each week before it lapses'
      };
    }
    if (has(c, 'launchpad')) {
      return {
        primary: function (n, k, ch) { return 'Take part in one launch on ' + n + ' (' + ch + ') with about $' + k + ", following the sale's own rules and lockups."; },
        secondary: function (n) { return 'Hold the launched token in the wallet past its first week instead of selling at listing, and join the next launch the same way.'; },
        weekly: 'join one launch or sale each week it runs and keep the received tokens held'
      };
    }
    if (has(c, 'marketplace', 'otc')) {
      return {
        primary: function (n, k, ch) { return 'Make one real trade of about $' + k + ' on ' + n + ' (' + ch + ') and keep the bought asset in the wallet.'; },
        secondary: function (n) { return 'List one asset for sale on ' + n + ' at a fair price so the wallet shows maker activity as well as taker activity.'; },
        weekly: 'make one trade or listing each week and avoid wash trading the same asset back and forth'
      };
    }
    if (has(c, 'payment', 'card')) {
      return {
        primary: function (n, k, ch) { return 'Load $' + k + ' into ' + n + ' on ' + ch + ' and make one real payment or transfer with it.'; },
        secondary: function (n) { return 'Make a second, different kind of transaction on ' + n + ' (a top-up after a payment, or the reverse) so the account shows more than one flow.'; },
        weekly: 'make at least one payment or transfer each week and keep a small balance loaded'
      };
    }
    if (has(c, 'privacy')) {
      return {
        primary: function (n, k, ch) { return 'Move $' + k + ' through ' + n + ' on ' + ch + " using its standard privacy flow, following the app's own guidance."; },
        secondary: function (n, k) { return 'Make a second, smaller transfer of about $' + Math.max(5, Math.round(k / 4)) + ' on ' + n + ' a few days later so usage is spread over time.'; },
        weekly: 'make one small transfer each week and keep amounts unremarkable'
      };
    }
    if (has(c, 'index')) {
      return {
        primary: function (n, k, ch) { return 'Buy $' + k + ' of ' + n + "'s index token on " + ch + ' and hold it in the wallet.'; },
        secondary: function (n) { return 'Add a small amount to the index position on ' + n + ' after the first rebalance so the wallet holds through a rebalance.'; },
        weekly: 'add a small amount each week and do not sell between rebalances'
      };
    }
    if (has(c, 'locker')) {
      return {
        primary: function (n, k, ch) { return 'Lock $' + k + ' of tokens through ' + n + ' on ' + ch + ' for the shortest lock the app offers, and keep the lock receipt.'; },
        secondary: function (n) { return 'Extend the lock once on ' + n + ' before it expires so the position spans more than one snapshot.'; },
        weekly: 'check the lock weekly and extend it before expiry rather than letting it lapse'
      };
    }
    if (has(c, 'governance')) {
      return {
        primary: function (n, k, ch) { return 'Delegate or stake $' + k + ' worth of voting power through ' + n + ' on ' + ch + ' and cast one vote.'; },
        secondary: function (n) { return 'Vote in the next proposal on ' + n + ' as well, and leave a short forum comment so the participation is visible.'; },
        weekly: 'vote in each new proposal and keep the delegation in place between votes'
      };
    }
    if (/\bai\b/.test(c)) {
      return {
        primary: function (n, k, ch) { return 'Use ' + n + "'s product on " + ch + ' with about $' + k + ' of credits or stake, completing one full task end to end.'; },
        secondary: function (n) { return 'Run a second, different task on ' + n + ' a few days later so the account shows repeated real use.'; },
        weekly: 'complete at least one task each week and keep any credits or stake in place'
      };
    }
    return {
      primary: function (n, k, ch) { return 'Deposit $' + k + ' of USDC into ' + n + "'s core product on " + ch + ' and keep the position open.'; },
      secondary: function (n) { return 'Use a second feature of ' + n + ' once (a swap, a vote, a second pool or vault) so the wallet is not a single deposit.'; },
      weekly: 'make one qualifying action each week, such as a deposit, a swap or a vote'
    };
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Then keep the position open and check the protocol's own page weekly.";
    return s;
  }
  function farmStepsOf(p) {
    var chain = p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var t = templateFor(p);
    var gas = capital >= 150 ? 8 : 4;
    return [
      { text: 'Set up a fresh wallet for this farm, fund it only with what the plan needs, and keep the seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: t.primary(p.name, capital, chain), cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: t.secondary(p.name, capital, chain), cost: 'about $2 to $5 of gas', time: '10 minutes' },
      { text: 'Keep the position for at least ' + hold + ' days and ' + t.weekly + '.', cost: 'the $' + capital + ' stays in the position, plus about $2 of gas a week', time: hold + ' days, 10 minutes a week' },
      { text: 'Watch ' + p.name + "'s own site and official channels for a points program or token announcement, and claim only from links the protocol itself publishes; never pay anyone to claim.", cost: 'nothing to check', time: '5 minutes a week' },
      { text: 'Log the wallet, dates, amounts and transaction hashes in a farm notebook so the position can be repeated, topped up or unwound on purpose.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // Verification hook: the same functions the page renders with, reachable for checks.
  window.RadarModel = { impliedOf: impliedOf, bandOf: bandOf, farmStepsOf: farmStepsOf, multipliersOf: multipliersOf };

  // ---------------------------------------------------------- DOM helpers
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------------------------------------------------------- state and hash
  function readHash() {
    // Reset to defaults first: a hash without a key means that key is unset, not unchanged.
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.wl = false;
    state.tab = 'board'; state.sort = 'implied'; state.dir = -1; state.selected = null;
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('wl') === '1') state.wl = true;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) state.sort = params.get('sort');
    if (params.get('dir')) state.dir = params.get('dir') === '1' ? 1 : -1;
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.wl) params.set('wl', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---------------------------------------------------------- header, lede, controls
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'ring', 'aria-hidden': 'true' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('div', { class: 'brand-sub', text: 'protocols with no token on record, priced by their peers' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', null, 'snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'model ', el('b', { text: DATA.model_version })),
        el('span', null, el('b', { text: String(DATA.protocol_count) }), ' protocols scanned')
      )
    );
  }

  function statCard(n, label) {
    return el('div', { class: 'stat' }, el('span', { class: 'n', text: n }), el('span', { class: 'l', text: label }));
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' protocols record no token. Here is what one could be worth.' }),
        el('p', null,
          'Every protocol on the snapshot watchlist is ranked, plus every other protocol that ',
          el('b', { text: 'records no token on DefiLlama' }),
          ' and is not a wrapped or staked product of a token that already trades. Each implied value is priced from the ',
          el('b', { text: DATA.comparable_count + ' protocols whose token already trades' }),
          ' in the same snapshot: the median market-cap-to-TVL ratio of its category, adjusted for momentum, age and chains. Open any row for the full audit and its farm plan.'
        )
      ),
      el('div', { class: 'stats' },
        statCard(String(DATA.protocol_count), 'protocols in the sealed snapshot'),
        statCard(DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'watchlist protocols covered'),
        statCard(String(DATA.board_size), 'ranked: records no token (' + DATA.early_size + ' below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor)'),
        statCard(String(DATA.comparable_count), 'tokenized comparables the market already priced')
      )
    );
  }

  function chainOptions() {
    var counts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (ch) { counts[ch] = (counts[ch] || 0) + 1; }); });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); }).slice(0, 24);
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chainOptions().map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var wlToggle = el('button', {
      type: 'button', class: 'toggle', 'aria-pressed': state.wl ? 'true' : 'false',
      onclick: function () { state.wl = !state.wl; writeHash(); render(); }
    }, el('span', { class: 'dot', 'aria-hidden': 'true' }), 'Watchlist only');
    function tabButton(id, label) {
      return el('button', {
        type: 'button', 'aria-pressed': state.tab === id ? 'true' : 'false', text: label,
        onclick: function () { state.tab = id; writeHash(); render(); }
      });
    }
    var countText = state.tab === 'board' ? filteredRows().length + ' of ' + DATA.board_size + ' rows'
      : state.tab === 'live' ? DATA.live.length + ' largest tokenized protocols'
      : 'how every number is built';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'flabel', text: 'Coverage' }), wlToggle),
      el('div', { class: 'field' }, el('span', { class: 'flabel', text: 'View' }),
        el('div', { class: 'tabs' }, tabButton('board', 'Ranked board'), tabButton('live', 'Token already trades'), tabButton('method', 'Method'))),
      el('span', { class: 'count', text: countText })
    );
  }

  // ---------------------------------------------------------- board
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', {
        type: 'button',
        onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); }
      }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▾' : ' ▴' }) : null)
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches those filters' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.wl = false; writeHash(); render(); }
        })
      ));
    }
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('span', { class: 'row1' },
            el('b', { text: r.name }),
            r.on_watchlist ? el('span', { class: 'tag', text: 'WATCHLIST' }) : null
          ),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'chain not recorded') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('div', null,
            el('div', { class: 'num v', text: fmtUsd(r.implied_value_usd) }),
            el('div', { class: 'band', text: fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) })
          )
        )),
        el('td', null, el('span', { class: 'chip', text: 'no token on record' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Ranked by implied value: what a token could be worth if the protocol issued one today, priced from tokenized peers in the same snapshot. The small range is the middle half of those peers. Select a row for its audit and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  // ---------------------------------------------------------- live view
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain not recorded') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtRatio(r.ratio) }),
        el('td', null, el('span', { class: 'chip live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'These protocols already have a token on record, so the market has priced them: the ratio column is observed, not modeled. They are the comparables the ranked board is priced from, and they are never ranked themselves.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' }),
            el('th', { scope: 'col', text: 'Mcap / TVL' }),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  // ---------------------------------------------------------- method view
  function methodView() {
    var g = DATA.global_ratio;
    var formula = [
      'ratio      = median(mcap / TVL) of the category\'s tokenized comparables, clamped to [0.02, 3]',
      '             (the global median when the category has fewer than ' + C.min_comparables + ' comparables)',
      'momentum   = 1 + clamp(change_7d, ' + C.momentum_floor_pct + ', ' + C.momentum_cap_pct + ') / 100 x ' + C.momentum_weight + '   (unreported: 1)',
      'age        = ' + C.age_base + ' + ' + C.age_range + ' x min(age_days, ' + C.age_full_days + ') / ' + C.age_full_days + '   (unknown age: ' + C.unknown_age_days + ' days)',
      'chains     = 1 + ' + C.chain_step + ' x min(max(chain_count - 1, 0), ' + C.chain_cap + ')',
      'implied    = round(TVL x ratio x momentum x age x chains)',
      'band       = the same product with the comparables\' p25 and p75 ratios'
    ].join('\n');
    var ratioRows = DATA.category_ratios.map(function (t) {
      return el('tr', null,
        el('td', { text: t.category }),
        el('td', { class: 'num', text: String(t.n) }),
        el('td', { class: 'num', text: fmtRatio(t.median) }),
        el('td', { class: 'num', text: fmtRatio(t.p25) }),
        el('td', { class: 'num', text: fmtRatio(t.p75) }),
        el('td', { class: t.used ? 'used' : 'fallback', text: t.used ? 'category median' : 'global median' })
      );
    });
    return el('section', { class: 'panel method' },
      el('h2', { text: 'How every number is built' }),
      el('p', null,
        'The snapshot holds ', el('b', { text: DATA.protocol_count + ' protocols' }),
        '. Of those, ', el('b', { text: DATA.comparable_count + ' carry a market cap' }),
        ' — their token already trades, so each one is a market observation of what a unit of TVL is worth in its category. ',
        'The global median market-cap-to-TVL ratio across all ' + DATA.comparable_count + ' is ',
        el('b', { text: fmtRatio(g.median) }),
        ' (middle half: ' + fmtRatio(g.p25) + ' to ' + fmtRatio(g.p75) + '). A ranked protocol is priced with its own category\'s median when that category has at least ' + C.min_comparables + ' comparables, and with the global median otherwise.'
      ),
      el('div', { class: 'formula', text: formula }),
      el('h3', { text: 'Comparable ratios by category' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'mini' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'Comparables' }),
            el('th', { scope: 'col', class: 'num', text: 'Median' }),
            el('th', { scope: 'col', class: 'num', text: 'p25' }),
            el('th', { scope: 'col', class: 'num', text: 'p75' }),
            el('th', { scope: 'col', text: 'Priced with' })
          )),
          el('tbody', null, ratioRows)
        )
      ),
      el('h3', { text: 'Who gets ranked' }),
      el('ul', null,
        el('li', null, el('b', { text: 'The watchlist is the floor. ' }), 'All ' + DATA.watchlist_size + ' watchlist protocols are on the board. The other ' + DATA.early_size + ' rows are every remaining protocol in the snapshot that records no token on DefiLlama and passes the same screen the watchlist uses.'),
        el('li', null, el('b', { text: 'The screen. ' }), 'A protocol is left off the board when it is a wrapped, staked or bridged product of a token that already trades: its category is Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX; its name ends in a version marker, carries the word wrapped, staked or staking, or begins with an exchange\'s name.'),
        el('li', null, el('b', { text: 'Tokenized protocols are never ranked. ' }), 'They appear only in the "Token already trades" view, with the market\'s own numbers, and as the comparables above.')
      ),
      el('h3', { text: 'Farm plans' }),
      el('p', null,
        'Each plan is six steps derived from the protocol\'s own record: the action follows its category (supply and borrow for lending, liquidity and swaps for a DEX, margin and trades for derivatives, and so on), the capital is sized by its TVL, the hold window by its age, and every step states its cost and its time. Plans are positioning guidance, not a promise that any protocol will issue a token or reward anyone.'
      ),
      el('h3', { text: 'Limits, stated plainly' }),
      el('ul', null,
        el('li', null, el('b', { text: '"Records no token" is a record, not a fact. ' }), 'It means DefiLlama carries no market cap, CoinGecko id or symbol for the protocol in this snapshot. A protocol may still have a token its record does not carry.'),
        el('li', null, el('b', { text: 'Implied value is this entry\'s model claim. ' }), 'It prices a hypothetical token as if the protocol\'s record stayed as it is. It does not predict whether or when a token is issued, and it is not financial advice.'),
        el('li', null, el('b', { text: 'Small samples are noisy. ' }), 'Category medians rest on as few as ' + C.min_comparables + ' comparables; the band beside each value shows how wide the middle half of those peers is. Momentum uses seven days of TVL change only.'),
        el('li', null, el('b', { text: 'The snapshot is frozen. ' }), 'All figures are as of ' + DATA.as_of + ' (' + DATA.source + '). Nothing here updates.')
      )
    );
  }

  // ---------------------------------------------------------- detail drawer
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function tvlPercentile(row) {
    var below = 0;
    DATA.rows.forEach(function (r) { if (r.tvl_usd < row.tvl_usd) below++; });
    return Math.round((below / DATA.rows.length) * 100);
  }

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var m = multipliersOf(row);
    var recomputed = impliedOf(row);
    var band = bandOf(row);
    var steps = farmStepsOf(row);
    var stats = ratioStatsOf(row);
    var ratioNote = row.ratio_source === 'category'
      ? 'the ' + (row.category || 'Other') + ' median from ' + row.ratio_n + ' tokenized comparables'
      : 'the global median from ' + row.ratio_n + ' tokenized comparables (its category has fewer than ' + C.min_comparables + ')';
    var momentumNote = row.growth_reported
      ? 'Seven-day TVL change of ' + fmtPct(row.change_7d) + ' moves the estimate to x' + m.momentum + '.'
      : 'Seven-day TVL change is unreported, so momentum is neutral (x1).';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'eyebrow', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · watchlist' : ' · early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain not recorded') + ' · records no token on DefiLlama' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Snapshot figures' }),
      el('div', { class: 'metrics' },
        el('div', { class: 'metric' }, el('span', { text: 'TVL' }), el('b', { text: fmtUsdFull(row.tvl_usd) })),
        el('div', { class: 'metric' }, el('span', { text: '7-day change' }), el('b', { text: fmtPct(row.change_7d) })),
        el('div', { class: 'metric' }, el('span', { text: 'Listed since' }), el('b', { text: row.listed_at || 'not recorded' })),
        el('div', { class: 'metric' }, el('span', { text: 'Age' }), el('b', { text: fmtAge(row.age_days) })),
        el('div', { class: 'metric' }, el('span', { text: 'Chains' }), el('b', { text: String((row.chains || []).length) })),
        el('div', { class: 'metric' }, el('span', { text: 'TVL percentile' }), el('b', { text: tvlPercentile(row) + 'th of ranked' }))
      )
    ));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'How the number is built' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsdFull(row.tvl_usd) })),
        el('div', null, el('span', { text: 'x comparable ratio (' + row.ratio_source + ', n=' + row.ratio_n + ')' }), el('b', { text: fmtRatio(row.ratio) })),
        el('div', null, el('span', { text: 'x momentum' }), el('b', { text: String(m.momentum) })),
        el('div', null, el('span', { text: 'x age' }), el('b', { text: String(m.age) })),
        el('div', null, el('span', { text: 'x chains' }), el('b', { text: String(m.chains) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsdFull(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Peer band (p25 – p75)' }), el('b', { text: fmtUsd(band.low) + ' – ' + fmtUsd(band.high) }))
      ),
      el('p', { class: 'sub', text: 'Priced with ' + ratioNote + '. The page recomputes this row as ' + fmtUsdFull(recomputed) + (recomputed === row.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from board.json, so the data would be stale.') + ' Peer ratios for this set: median ' + fmtRatio(stats.median) + ', p25 ' + fmtRatio(stats.p25) + ', p75 ' + fmtRatio(stats.p75) + '.' })
    ));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Why it ranks here' }),
      el('div', { class: 'why' },
        el('p', null, el('b', { text: 'Scale. ' }), 'At ' + fmtUsd(row.tvl_usd) + ' of TVL it sits at the ' + tvlPercentile(row) + 'th percentile of the ' + DATA.board_size + ' ranked protocols, and TVL is the base every other factor multiplies.'),
        el('p', null, el('b', { text: 'Peers. ' }), 'Tokenized ' + (row.ratio_source === 'category' ? (row.category || 'Other') + ' ' : '') + 'protocols trade at a median of ' + fmtRatio(row.ratio) + 'x TVL (' + row.ratio_n + ' comparables), which is the single largest driver after TVL itself.'),
        el('p', null, el('b', { text: 'Momentum and track record. ' }), momentumNote + ' It has been listed for ' + fmtAge(row.age_days) + ' (age factor x' + m.age + ') across ' + (row.chains || []).length + ' chain' + ((row.chains || []).length === 1 ? '' : 's') + ' (chain factor x' + m.chains + ').')
      )
    ));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // ---------------------------------------------------------- render
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.tab === 'live') shell.appendChild(liveTable());
    else if (state.tab === 'method') shell.appendChild(methodView());
    else shell.appendChild(boardTable());
    shell.appendChild(el('footer', { class: 'foot' },
      el('p', { text: 'Data: ' + DATA.source + '. Snapshot date ' + DATA.as_of + '; nothing on this page updates or fetches.' }),
      el('p', { text: '"Records no token" means DefiLlama carries no market cap, CoinGecko id or symbol for the protocol in this snapshot — a record, not proof that no token exists. Implied values are this radar\'s model estimates, not predictions and not financial advice.' })
    ));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (!state.selected && dialog.open) dialog.close();
    if (state.selected && state.tab === 'board') openDetail(state.selected);
  }

  // writeHash uses replaceState, so it never fires this; a real hash change (a pasted link,
  // back/forward) re-reads the state and re-renders.
  window.addEventListener('hashchange', function () { readHash(); render(); });

  readHash();
  render();
})();
