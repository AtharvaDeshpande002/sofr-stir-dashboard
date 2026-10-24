/* Trade board core — a JavaScript port of Mathur-Git/trade-board (lib/ladder.py, lib/exits.py,
 * lib/cuts.py and scripts/trade_page.py:_trade_setup). The reasoning behind every rule is in that
 * repo's docs/TRADE.md and docs/SCALING.md; names follow the Python so the two can be read side by
 * side. Parity with the Python is checked by trade_check/tb_parity.py (same inputs, every number).
 * Usable in the browser (window.TB) and in node (module.exports).
 */
(function (root) {
"use strict";
const TICK = 0.5;
const DOLLARS_PER_BP = { SR3: 25.0, ZQ: 125.0 / 3.0 };
const PEAK_WIDTHS = { broad: 1 / 2, medium: 1 / 3, narrow: 1 / 5 };
const PROXY_STOP_TICKS = 4, PROXY_TGT_TICKS = 6, EXIT_SPAN_TICKS = 4;

// ---- Python numerics -------------------------------------------------------------
function pyRoundInt(x) {                     // round() to an integer: exact value, ties to even
  const f = Math.floor(x), d = x - f;
  if (d === 0.5) return (f % 2 === 0) ? f : f + 1;
  return d < 0.5 ? f : f + 1;
}
function r6(x) { return Math.round(x * 1e6) / 1e6 + 0; }
function trunc(x) { return x < 0 ? Math.ceil(x) : Math.floor(x); }
const isNum = v => v !== null && v !== undefined && !Number.isNaN(v);
const k6 = p => r6(p).toFixed(6);              // a price as a set key
function g(v) {                                // f"{v:g}"
  if (v === null || v === undefined || Number.isNaN(v)) return "nan";
  if (!isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e < -4 || e >= 6) {
    let s = v.toExponential(5).replace(/\.?0+e/, "e");
    return s.replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(Number(v.toPrecision(6)));
}
function d0(v) {                               // f"{v:,.0f}" with no "-0"
  if (Math.abs(v) < 0.5) v = 0;
  const n = pyRoundInt(v);
  return (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-US");
}
function f3(v) { return v.toFixed(3); }
function px3(v) { return v.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""); }
function commas(n) { return Math.round(n).toLocaleString("en-US"); }

// ---- lib/ladder.py ----------------------------------------------------------------
const sign = side => side === "buy" ? 1.0 : -1.0;
function entry_levels(entry, stop, side, tick = TICK) {
  const sgn = sign(side), steps = pyRoundInt(sgn * (entry - stop) / tick);
  if (steps < 1) return [];
  const out = []; for (let i = 0; i < steps; i++) out.push(r6(entry - sgn * i * tick));
  return out;
}
function risk_per_lot(levels, stop, side) { const s = sign(side); return levels.map(p => s * (p - stop)); }
function equal_risk_weights(risk) { return risk.map(r => r > 0 ? 1.0 / r : 0.0); }
function peak_width(mode, entry, stop) { const sh = PEAK_WIDTHS[mode]; return sh ? sh * Math.abs(entry - stop) : null; }
function peak_weights(levels, risk, peak, width) {
  return levels.map((p, i) => risk[i] > 0 ? Math.pow(2.0, -Math.pow((p - peak) / width, 2)) / risk[i] : 0.0);
}
function ladder_allocate(risk, weights, budget_bp) {
  if (!risk.length) return [];
  let denom = 0; for (let i = 0; i < risk.length; i++) denom += weights[i] * risk[i];
  if (denom <= 0 || budget_bp <= 0) return risk.map(() => 0);
  const k = budget_bp / denom, raw = weights.map(w => k * w), lots = raw.map(x => trunc(x));
  let used = 0; for (let i = 0; i < risk.length; i++) used += lots[i] * risk[i];
  const order = risk.map((_, i) => i).sort((a, b) => (raw[b] - trunc(raw[b])) - (raw[a] - trunc(raw[a])));
  for (const i of order) if (used + risk[i] <= budget_bp + 1e-9) { lots[i] += 1; used += risk[i]; }
  return lots;
}
function depth_table(levels, lots, stop, target, dpb, side, held = 0, held_avg = null, banked_bp = 0.0) {
  const sgn = sign(side), out = [];
  let pos = Math.trunc(held || 0), notional = pos * (held_avg || 0.0);
  let risk_bp = pos * sgn * ((held_avg || 0.0) - stop) - banked_bp;
  if (pos) {
    const loss = risk_bp * dpb, pnl = (pos * sgn * (target - held_avg) + banked_bp) * dpb;
    out.push({ depth: 0, level: held_avg, lots: pos, pos, avg: held_avg, risk_bp, loss, pnl, rr: loss > 0 ? pnl / loss : NaN, held: true });
  }
  for (let d = 1; d <= levels.length; d++) {
    const p = levels[d - 1], q = lots[d - 1];
    pos += q; notional += q * p; risk_bp += q * sgn * (p - stop);
    const avg = pos ? notional / pos : NaN, loss = risk_bp * dpb;
    const pnl = pos ? (pos * sgn * (target - avg) + banked_bp) * dpb : 0.0;
    out.push({ depth: d, level: p, lots: q, pos, avg, risk_bp, loss, pnl, rr: loss > 0 ? pnl / loss : NaN, held: false });
  }
  return out;
}
function blend(map) {                          // {price: lots} -> [lots, avg]
  let lots = 0, s = 0;
  for (const [p, q] of map) { if (q) { lots += q; s += p * q; } }
  return lots ? [lots, s / lots] : [0, null];
}
function ladder_plan(o) {
  const { entry, stop, target, max_loss, side } = o, instrument = o.instrument || "SR3";
  const dpb = DOLLARS_PER_BP[instrument], sgn = sign(side);
  const ref = (o.risk_to === null || o.risk_to === undefined) ? stop : o.risk_to;
  const all_levels = entry_levels(entry, stop, side);
  const excl = new Set((o.excluded || []).map(k6));
  const live = all_levels.filter(p => !excl.has(k6(p)));
  const risk = risk_per_lot(live, ref, side);
  const peak = o.peak, width = o.width;
  const shaped = isNum(peak) && !!width && width > 0;
  const weights = (levels, r) => shaped ? peak_weights(levels, r, peak, width) : equal_risk_weights(r);
  // held per rung (Map price->lots, ordered as given)
  const held_map = new Map();
  for (const [k, v] of (o.held_levels || new Map())) if (v && Math.trunc(v) > 0) held_map.set(r6(k), Math.trunc(v));
  const live_set = new Set(live.map(k6));
  const fills = new Map(), prior = new Map();
  for (const [p, q] of held_map) (live_set.has(k6(p)) ? fills : prior).set(p, q);
  let held_all, havg, prior_n, prior_avg;
  if (o.held_levels && o.held_levels.size) {
    [held_all, havg] = blend(held_map); [prior_n, prior_avg] = blend(prior);
  } else {
    held_all = Math.trunc(o.held || 0);
    havg = held_all && isNum(o.held_avg) ? o.held_avg : null;
    prior_n = held_all; prior_avg = havg;
  }
  let sold_lots = held_all ? Math.min(Math.max(0, Math.trunc(o.sold_lots || 0)), held_all) : 0;
  let sold_bp = o.sold_bp || 0.0;
  if (!sold_lots) sold_bp = 0.0;
  const total_bp = dpb ? max_loss / dpb : 0.0;
  const prior_risk_bp = prior_n ? prior_n * sgn * (prior_avg - ref) : 0.0;
  const budget_bp = Math.max(0.0, total_bp - prior_risk_bp);
  const planned = ladder_allocate(risk, weights(live, risk), budget_bp);
  const fget = p => { for (const [k, v] of fills) if (k6(k) === k6(p)) return v; return 0; };
  const got = live.map(fget);
  let over_bp = 0; for (let i = 0; i < live.length; i++) over_bp += Math.max(got[i] - planned[i], 0) * risk[i];
  if (over_bp > 0) {
    const open_i = got.map((g_, i) => g_ === 0 ? i : -1).filter(i => i >= 0);
    let room = 0; for (const i of open_i) room += planned[i] * risk[i]; room -= over_bp;
    const r_open = open_i.map(i => risk[i]);
    const redo = ladder_allocate(r_open, weights(open_i.map(i => live[i]), r_open), Math.max(0.0, room));
    open_i.forEach((i, j) => { planned[i] = redo[j]; });
  }
  const lots = planned.map((q, i) => Math.max(q - got[i], 0));
  const net = Math.max(0, held_all - sold_lots);
  let held_risk_bp = net && havg !== null ? net * sgn * (havg - ref) : 0.0;
  held_risk_bp -= sold_bp;
  const unsold_bp = held_all && havg !== null ? held_all * sgn * (havg - ref) : 0.0;
  let excess = unsold_bp; for (let i = 0; i < lots.length; i++) excess += lots[i] * risk[i]; excess -= total_bp;
  for (let i = lots.length - 1; i >= 0; i--) {
    if (excess <= 1e-9) break;
    if (lots[i] && risk[i] > 0) {
      const cut = Math.min(lots[i], Math.ceil(excess / risk[i] - 1e-9));
      lots[i] -= cut; excess -= cut * risk[i];
    }
  }
  const target_lots = got.map((g_, i) => g_ + lots[i]);
  const rows = depth_table(live, lots, ref, target, dpb, side, net, havg, sold_bp);
  const cap_rows = depth_table(live, lots, ref, target, dpb, side, held_all, havg);
  const filled = rows.filter(r => r.pos > 0);
  const spent = rows.length ? rows[rows.length - 1].risk_bp * dpb : 0.0;
  const exclSorted = [...excl].map(Number).sort((a, b) => side === "buy" ? b - a : a - b);
  return {
    instrument, side, dollars_per_bp: dpb, tick_value: dpb * TICK, risk_to: ref,
    peak: shaped ? peak : null, width: shaped ? width : null,
    all_levels, levels: live, lots, plan: target_lots, filled: got, fills, prior: prior_n,
    prior_risk: prior_risk_bp * dpb, excluded: exclSorted, risk, rows, cap_rows,
    full: filled.length ? filled[filled.length - 1] : null,
    entry, stop, target, held: net, held_avg: havg, held_risk: held_risk_bp * dpb,
    sold: sold_lots, banked: sold_bp * dpb, held_levels: held_map,
    over_budget: unsold_bp >= total_bp && held_all > 0, over_by: Math.max(0.0, (unsold_bp - total_bp) * dpb),
    new_lots: lots.reduce((a, b) => a + b, 0), max_loss, spent, unspent: max_loss - spent,
    used_pct: max_loss ? 100.0 * spent / max_loss : 0.0,
  };
}

// ---- lib/exits.py -----------------------------------------------------------------
function exit_levels(first, last, side, tick = TICK) {
  const sgn = sign(side), steps = pyRoundInt(sgn * (last - first) / tick);
  if (steps < 1) return [];
  const out = []; for (let i = 0; i < steps; i++) out.push(r6(first + sgn * i * tick));
  return out;
}
function regret_weights(levels, last, side, peak = null, width = null) {
  const sgn = sign(side), shaped = isNum(peak) && !!width && width > 0;
  return levels.map(p => {
    const gap = sgn * (last - p), share = shaped ? Math.pow(2.0, -Math.pow((p - peak) / width, 2)) : 1.0;
    return gap > 0 ? share / gap : 0.0;
  });
}
function regret_at(level, lots, last, side, dpb) { return lots * sign(side) * (last - level) * dpb; }
function exits_allocate(position, levels, last, side, peak = null, width = null) {
  const m = levels.length;
  if (m === 0) return [];
  if (position <= 0) return levels.map(() => 0);
  const w = regret_weights(levels, last, side, peak, width), tot = w.reduce((a, b) => a + b, 0);
  if (tot <= 0) { const each = Math.floor(position / m), extra = position % m; return levels.map((_, i) => each + (i < extra ? 1 : 0)); }
  const raw = w.map(x => position * x / tot), lots = raw.map(x => trunc(x));
  const order = levels.map((_, i) => i).sort((a, b) => (raw[b] - trunc(raw[b])) - (raw[a] - trunc(raw[a])));
  const need = position - lots.reduce((a, b) => a + b, 0);
  for (const i of order.slice(0, Math.max(0, need))) lots[i] += 1;
  return lots;
}
function exits_ahead_levels(levels, sold_map, side) {
  const sold = [...(sold_map || new Map())].filter(([, q]) => q).map(([p]) => p);
  if (!sold.length) return levels.slice();
  const sgn = sign(side), furthest = sgn > 0 ? Math.max(...sold) : Math.min(...sold);
  return levels.filter(p => sgn * (p - furthest) > 1e-9);
}
function breakeven_lots(position, avg, stop, first, side = "buy", carried = 0, banked_bp = 0.0) {
  const sgn = sign(side), span = sgn * (first - stop);
  if (span <= 0 || position <= 0) return 0;
  const q = ((position + carried) * sgn * (avg - stop) - banked_bp) / span;
  if (q <= 0) return 0;
  return Math.min(position, Math.ceil(q - 1e-9));
}
function reversal_table(levels, lots, position, avg, stop, dpb, side, flat = null, carried = 0, sold = 0, banked_bp = 0.0, sold_notional = 0.0) {
  const sgn = sign(side), risk_lot = sgn * (avg - stop);
  flat = flat === null ? (levels.length ? levels[levels.length - 1] : avg) : flat;
  const out = []; let n_sold = Math.trunc(sold), realised_bp = banked_bp, notional = sold_notional;
  const row = (depth, level, q) => {
    const left = position - (n_sold - sold), exposed = left + carried, realised = realised_bp * dpb;
    const at_stop = realised - exposed * risk_lot * dpb;
    return { depth, level, lots: q, sold: n_sold, left, realised, open_risk: exposed * risk_lot * dpb,
      if_stopped: at_stop, if_runs: realised + left * sgn * (flat - avg) * dpb, free: at_stop >= 0,
      avg_out: n_sold ? notional / n_sold : NaN };
  };
  out.push(row(0, avg, 0));
  for (let d = 1; d <= levels.length; d++) {
    const p = levels[d - 1], q = lots[d - 1];
    n_sold += q; notional += q * p; realised_bp += q * sgn * (p - avg);
    out.push(row(d, p, q));
  }
  return out;
}
function exits_plan(o) {
  const { avg, stop, first, last, side } = o, instrument = o.instrument || "SR3";
  const dpb = DOLLARS_PER_BP[instrument], sgn = sign(side);
  const position = Math.max(0, Math.trunc(o.position || 0)), carried = Math.max(0, Math.trunc(o.carried || 0));
  const sold_map = new Map();
  for (const [p, q] of (o.sold_levels || new Map())) if (q && Math.trunc(q) > 0) sold_map.set(r6(p), Math.trunc(q));
  const basis = (o.sold_basis === null || o.sold_basis === undefined) ? avg : o.sold_basis;
  let n_sold = 0, banked_bp = 0, sold_notional = 0;
  for (const [p, q] of sold_map) { n_sold += q; banked_bp += q * sgn * (p - basis); sold_notional += p * q; }
  const all_levels = exit_levels(first, last, side);
  const ahead = exits_ahead_levels(all_levels, sold_map, side);
  const excl = new Set((o.excluded || []).map(k6));
  const live = ahead.filter(p => !excl.has(k6(p)));
  const shaped = isNum(o.peak) && !!o.width && o.width > 0;
  const lots = exits_allocate(position, live, last, side, shaped ? o.peak : null, shaped ? o.width : null);
  const rows = reversal_table(live, lots, position, avg, stop, dpb, side, last, carried, n_sold, banked_bp, sold_notional);
  const full = rows.length ? rows[rows.length - 1] : null;
  const free_now = !!rows.length && rows[0].free && (position + carried) > 0;
  const aheadSet = new Set(ahead.map(k6));
  let free_at = null;
  if (!free_now) { const r = rows.find(x => x.free && x.depth > 0); free_at = r ? r.depth : null; }
  return {
    instrument, side, dollars_per_bp: dpb, tick_value: dpb * TICK, avg, position, stop, first, last,
    peak: shaped ? o.peak : null, width: shaped ? o.width : null,
    all_levels, ahead, passed: all_levels.filter(p => !aheadSet.has(k6(p))), levels: live, lots,
    excluded: [...excl].map(Number).sort((a, b) => side === "buy" ? b - a : a - b), rows,
    sold: n_sold, sold_levels: sold_map, banked: banked_bp * dpb, carried,
    avg_out: full ? full.avg_out : NaN,
    breakeven_lots: live.length ? breakeven_lots(position, avg, stop, live[0], side, carried, banked_bp) : 0,
    open_risk: (position + carried) * sgn * (avg - stop) * dpb,
    max_win: (banked_bp + position * sgn * (last - avg)) * dpb, free_now, free_at,
  };
}

// ---- lib/cuts.py ------------------------------------------------------------------
function cut_levels(stop, out_by, side, tick = TICK) {
  const sgn = sign(side), steps = pyRoundInt(sgn * (stop - out_by) / tick);
  if (steps < 1) return [];
  const out = []; for (let i = 1; i <= steps; i++) out.push(r6(stop - sgn * i * tick));
  return out;
}
function cuts_ahead_levels(levels, sold_map, stop, side) {
  const sgn = sign(side);
  const past = [...(sold_map || new Map())].filter(([p, q]) => q && sgn * (stop - p) > 1e-9).map(([p]) => p);
  if (!past.length) return levels.slice();
  const furthest = sgn > 0 ? Math.min(...past) : Math.max(...past);
  return levels.filter(p => sgn * (furthest - p) > 1e-9);
}
function cut_weights(levels, avg, side) {
  const sgn = sign(side), gaps = levels.map(x => sgn * (avg - x));
  if (!gaps.length || Math.min(...gaps) <= 1e-9) return levels.map(() => 1.0);
  return gaps.map(gp => 1.0 / gp);
}
function cut_average(avg, levels, side) {
  if (!levels.length || avg === null || avg === undefined || Number.isNaN(avg)) return null;
  const w = cut_weights(levels, avg, side);
  let s = 0, t = 0; for (let i = 0; i < levels.length; i++) { s += levels[i] * w[i]; t += w[i]; }
  return s / t;
}
function cut_reference(avg, levels, side, fallback) { const r = cut_average(avg, levels, side); return r === null ? fallback : r; }
function cut_loss_bp(position, avg, levels, side, fallback) {
  if (!position || avg === null || avg === undefined || Number.isNaN(avg)) return 0.0;
  return position * sign(side) * (avg - cut_reference(avg, levels, side, fallback));
}
function cuts_allocate(position, levels, avg, side) {
  const m = levels.length;
  if (m === 0) return [];
  if (position <= 0) return levels.map(() => 0);
  const w = cut_weights(levels, avg, side), tot = w.reduce((a, b) => a + b, 0);
  const lots = w.map(x => trunc(position * x / tot));
  const need = position - lots.reduce((a, b) => a + b, 0);
  for (let i = 0; i < need; i++) lots[i % m] += 1;
  return lots;
}
function cuts_plan(avg, position, stop, out_by, side, instrument = "SR3", sold_map = null) {
  const dpb = DOLLARS_PER_BP[instrument], sgn = sign(side);
  const every = cut_levels(stop, out_by, side), ahead = cuts_ahead_levels(every, sold_map, stop, side);
  position = Math.max(0, Math.trunc(position || 0));
  const live = position > 0 && avg !== null && avg !== undefined && !Number.isNaN(avg);
  const lots = live ? cuts_allocate(position, ahead, avg, side) : ahead.map(() => 0);
  const loss_at = lots.map((q, i) => live ? q * sgn * (avg - ahead[i]) * dpb : 0.0);
  const left = []; let n = position; for (const q of lots) { n -= q; left.push(n); }
  const aheadSet = new Set(ahead.map(k6));
  return { instrument, side, stop, out_by, all_levels: every, levels: ahead,
    passed: every.filter(p => !aheadSet.has(k6(p))), lots, left, loss_at, position, avg,
    avg_cut: live ? cut_average(avg, ahead, side) : null,
    loss: live ? cut_loss_bp(position, avg, ahead, side, out_by) * dpb : 0.0,
    loss_lots: loss_at.reduce((a, b) => a + b, 0) };
}
const _sized = lp => (lp.cap_rows && lp.cap_rows.length) ? lp.cap_rows : (lp.rows || []);
function _full(lp) { const rows = _sized(lp).filter(r => r.pos > 0); return rows.length ? [rows[rows.length - 1].pos, rows[rows.length - 1].avg] : null; }
function fit_in(plan_at, levels, side, max_loss, dpb, banked_bp = 0.0, fallback = null, start = null) {
  let ref = start !== null ? start : fallback;
  let lp = plan_at(ref, max_loss);
  for (let it = 0; it < 12; it++) {
    const book = _full(lp); if (book === null) break;
    const nw = cut_reference(book[1], levels, side, fallback);
    if (Math.abs(nw - ref) < 1e-9) break;
    ref = nw; lp = plan_at(ref, max_loss);
  }
  let budget = max_loss;
  for (let it = 0; it < 24; it++) {
    const book = _full(lp); if (book === null || budget <= 0) break;
    const over = (cut_loss_bp(book[0], book[1], levels, side, fallback) - banked_bp) * dpb - max_loss;
    if (over <= 1e-6) break;
    budget = Math.max(0.0, budget - over - 0.01);
    lp = plan_at(ref, budget);
  }
  const worst_over = p => {
    const rows = _sized(p).filter(r => r.pos > 0);
    let worst = 0.0, any = false;
    for (const r of rows) { const v = (cut_loss_bp(r.pos, r.avg, levels, side, fallback) - banked_bp) * dpb; worst = any ? Math.max(worst, v) : v; any = true; }
    return (any ? worst : 0.0) - max_loss;
  };
  if (worst_over(lp) > 1e-6 && budget > 0) {
    let best = plan_at(ref, 0.0), lo = 0.0, hi = budget;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2, trial = plan_at(ref, mid);
      if (worst_over(trial) <= 1e-6) { best = trial; lo = mid; } else hi = mid;
    }
    lp = best;
  }
  lp.max_loss = max_loss;
  return [lp, ref];
}
function restate(rows, levels, side, dpb, fallback, banked_bp = 0.0) {
  for (const r of rows) {
    r.risk_bp = cut_loss_bp(r.pos, r.avg, levels, side, fallback) - banked_bp;
    r.loss = r.risk_bp * dpb;
    r.rr = r.loss > 0 ? r.pnl / r.loss : NaN;
  }
  return rows;
}

// ---- scripts/trade_page.py helpers -----------------------------------------------------
function _fnum(x) {
  if (x === null || x === undefined) return null;
  const t = String(x).trim().replace(/,/g, "");
  if (!t || ["-", "+", ".", "-.", "+."].includes(t)) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    if (/^[+-]?(inf|infinity|nan)$/i.test(t)) return null;
    return null;
  }
  return parseFloat(t);
}
const _snap = x => x === null ? null : r6(pyRoundInt(x / TICK) * TICK);
const _key = p => pyRoundInt(p * 2);
function _first_profit(avg, side) {
  const k = side === "buy" ? Math.floor(avg / TICK) + 1 : Math.ceil(avg / TICK) - 1;
  return r6(k * TICK);
}
function _window(anchor, side, ticks) {
  const up = side === "buy" ? ticks : ticks - 1, dn = side === "buy" ? ticks - 1 : ticks;
  return [r6(anchor - dn * TICK), r6(anchor + up * TICK)];
}
function _levels_now(entry, stop, side) {
  if (entry === null) return [];
  const sgn = sign(side);
  if (stop === null || sgn * (entry - stop) <= 0) stop = r6(entry - sgn * PROXY_STOP_TICKS * TICK);
  return entry_levels(entry, stop, side);
}
const setOf = (store, key) => new Set(((store || {})[key] || []).map(x => k6(Number(x))));
function _trade_default_in_skips(levels) { return levels.length >= 3 ? new Set([k6(levels[levels.length - 1])]) : new Set(); }
function _trade_effective_in_skips(levels, store) {
  const s = _trade_default_in_skips(levels), off = setOf(store, "off"), on = setOf(store, "on");
  for (const x of off) s.add(x); for (const x of on) s.delete(x);
  return s;                                   // keys (k6)
}
function _effective_out_skips(levels, store) {  // _no_default: nothing pulled by default
  const off = setOf(store, "off"), on = setOf(store, "on"), lv = new Set(levels.map(k6)), s = new Set();
  for (const x of off) if (!on.has(x) && lv.has(x)) s.add(x);
  return s;
}
function _toggle_skip(store, lv, auto) {     // auto: Set of k6
  const off = setOf(store, "off"), on = setOf(store, "on"), k = k6(lv);
  const skipped = (auto.has(k) || off.has(k)) && !on.has(k);
  off.delete(k); on.delete(k);
  if (skipped && auto.has(k)) on.add(k); else if (!skipped && !auto.has(k)) off.add(k);
  const srt = s => [...s].map(Number).sort((a, b) => a - b);
  return { off: srt(off), on: srt(on) };
}
function _filter_skips(store, alive) {      // alive: Set of k6
  store = store || {};
  return { off: (store.off || []).filter(x => alive.has(k6(Number(x)))), on: (store.on || []).filter(x => alive.has(k6(Number(x)))) };
}
function _levels_of(store) {                // {"halfTick": lots} -> Map(price -> lots)
  const m = new Map();
  for (const [k, v] of Object.entries(store || {})) if (v) m.set(parseInt(k, 10) / 2.0, Math.trunc(v));
  return m;
}

// ---- _trade_setup ----------------------------------------------------------------
function _trade_setup(inst, side, mark, entry, held_map, sold_map, stop, first, target, max_loss,
                      excl_in, excl_out, depth, peak = null, shape = "off", peak_out = null,
                      shape_out = "off", out_by = null) {
  mark = _snap(_fnum(mark)); entry = _snap(_fnum(entry)); stop = _snap(_fnum(stop));
  first = _snap(_fnum(first)); target = _snap(_fnum(target)); max_loss = _fnum(max_loss);
  if (mark === null) return null;
  const sgn = sign(side), side_word = side === "buy" ? "long" : "short";
  const problems = []; let sold_note = "";
  if (entry === null) { entry = mark; problems.push(`No entry yet, so the ladder is built from the ${g(mark)} ${side === "buy" ? "bid" : "ask"}.`); }
  const pstop = r6(entry - sgn * PROXY_STOP_TICKS * TICK), ptgt = r6(entry + sgn * PROXY_TGT_TICKS * TICK);
  if (stop === null) { stop = pstop; problems.push(`No stop yet. Working to ${g(stop)}.`); }
  else if (sgn * (entry - stop) <= 0) { const bad = stop; stop = pstop;
    problems.push(`A stop at ${g(bad)} is on the wrong side of a ${g(entry)} ${side_word} — that is not a stop, it is a loss. Showing ${g(stop)}.`); }
  if (target === null) { target = ptgt; problems.push(`No target yet. Working to ${g(target)}.`); }
  else if (sgn * (target - entry) <= 0) { const bad = target; target = ptgt;
    problems.push(`A target at ${g(bad)} is not a profit on a ${g(entry)} ${side_word}. Showing ${g(target)}.`); }
  if (max_loss === null) { max_loss = 0.0; problems.push("No max loss, so the way in is not sized. Say what the trade may cost in total."); }
  const out_by_typed = _snap(_fnum(out_by)); out_by = out_by_typed;
  if (out_by !== null && sgn * (stop - out_by) < TICK - 1e-9) {
    out_by = null; problems.push(`OUT BY at ${g(out_by_typed)} is not past the ${g(stop)} stop, so there is nothing to cut between them. Ignoring it.`);
  }
  const levels_held = _levels_of(held_map);
  let sold = _levels_of(sold_map);
  const [held_n, held_avg] = blend(levels_held);
  let n_sold = 0; for (const q of sold.values()) n_sold += q;
  if (n_sold && !held_n) {
    problems.push(`${commas(n_sold)} sold, but nothing in Filled — a sale comes out of lots you bought, so type those first. Ignoring the sales until then.`);
    sold_note = `${commas(n_sold)} sold ignored — nothing in Filled`; sold = new Map(); n_sold = 0;
  } else if (n_sold > held_n) {
    const typed = n_sold, counted = new Map(); let left = held_n;
    const keys = [...sold.keys()].sort((a, b) => sgn * (a - held_avg) - sgn * (b - held_avg));
    for (const p of keys) { const q = Math.min(sold.get(p), left); if (q) { counted.set(p, q); left -= q; } }
    sold = counted; n_sold = held_n;
    problems.push(`${commas(typed)} sold is more than the ${commas(held_n)} filled. Counting ${commas(held_n)}, the least profitable first.`);
    sold_note = `${commas(typed)} sold is more than the ${commas(held_n)} filled · counting ${commas(held_n)}`;
  }
  let sold_bp = 0.0; if (n_sold) for (const [p, q] of sold) sold_bp += q * sgn * (p - held_avg);

  const ins = entry_levels(entry, stop, side), insSet = new Set(ins.map(k6));
  let in_excl = _trade_effective_in_skips(ins, excl_in || {});
  let peak_p = _snap(_fnum(peak)), peak_note = "";
  let width = PEAK_WIDTHS[shape] ? peak_width(shape, entry, stop) : null;
  if (width && peak_p === null) peak_note = "peak on — click a rung in the dot column";
  else if (width && !insSet.has(k6(peak_p))) peak_note = `peak at ${g(peak_p)} is off the way in — sizing flat`;
  if (!width || peak_p === null || !insSet.has(k6(peak_p))) { peak_p = null; width = null; }

  const dpb = DOLLARS_PER_BP[inst];
  const cut_all = out_by !== null ? cut_levels(stop, out_by, side) : [];
  const cut_ahead = out_by !== null ? cuts_ahead_levels(cut_all, sold, stop, side) : [];
  const cut_ref = avg => out_by === null ? stop : cut_reference(avg, cut_ahead, side, out_by);
  const plan_in = excl => {
    const exclList = [...excl].map(Number);
    const at = (ref, budget) => ladder_plan({ entry, stop, target, max_loss: budget, side, instrument: inst, excluded: exclList,
      held_levels: levels_held, sold_lots: n_sold, sold_bp, peak: peak_p, width, risk_to: ref });
    if (out_by === null) return at(null, max_loss);
    return fit_in(at, cut_all, side, max_loss, dpb, 0.0, out_by, stop)[0];
  };
  let lp = plan_in(in_excl);
  const in_zero = new Set();
  if (peak_p !== null) {
    const kept = setOf(excl_in, "on");
    for (let it = 0; it < ins.length; it++) {
      if (lp.plan.reduce((a, b) => a + b, 0) <= 0) break;
      const zero = new Set(); lp.levels.forEach((p, i) => { if (lp.plan[i] === 0 && !kept.has(k6(p))) zero.add(k6(p)); });
      if (!zero.size) break;
      for (const z of zero) { in_zero.add(z); in_excl.add(z); }
      lp = plan_in(in_excl);
    }
  }
  let risk_ref = stop;
  if (out_by !== null) {
    restate(lp.rows, cut_ahead, side, dpb, out_by, sold_bp);
    const full = lp.rows.filter(r => r.pos > 0);
    risk_ref = full.length ? cut_ref(full[full.length - 1].avg) : cut_ref(entry);
  }
  const depths = lp.rows.map(r => r.depth);
  const sel = (depth !== null && depth !== undefined && depths.includes(depth)) ? depth : (depths.length ? depths[depths.length - 1] : null);
  const row = lp.rows.find(x => x.depth === sel) || null;
  const book_at = r => [r ? Math.trunc(r.pos) : 0, (r && !Number.isNaN(r.avg)) ? r.avg : entry];
  const first_for = avg => (first !== null && sgn * (first - avg) > 0) ? first : _first_profit(avg, side);
  const [pos_d, avg_d] = book_at(row);
  const pfirst = _first_profit(avg_d, side), f_sel = first_for(avg_d);
  if (first === null) problems.push(`No first exit yet. Working to ${g(f_sel)}.`);
  else if (f_sel !== first) problems.push(`A first exit at ${g(first)} is not a profit on ${pos_d ? "your average" : "the entry"} of ${f3(avg_d)}. Showing ${g(f_sel)}.`);
  if (sgn * (target - f_sel) < TICK) {
    const bad = target; target = r6(f_sel + sgn * EXIT_SPAN_TICKS * TICK);
    problems.push(`A target at ${g(bad)} leaves no rungs beyond a first exit at ${g(f_sel)} — it is the boundary you are flat by, not a level you work. Showing ${g(target)}.`);
  }
  const basis = n_sold ? held_avg : null;
  const peak_o = _snap(_fnum(peak_out)), shape_o = !!PEAK_WIDTHS[shape_out];
  const kept_out = setOf(excl_out, "on");
  const exit_for = r => {
    const [pos, avg] = book_at(r), f = first_for(avg);
    const ahead = exits_ahead_levels(exit_levels(f, target, side), sold, side), aheadSet = new Set(ahead.map(k6));
    let skips = _effective_out_skips(ahead, excl_out);
    const pk = (shape_o && peak_o !== null && aheadSet.has(k6(peak_o))) ? peak_o : null;
    const w = pk !== null ? peak_width(shape_out, f, target) : null;
    const stop_at = cut_ref(avg);
    const plan_out = sk => exits_plan({ avg, position: pos, stop: stop_at, first: f, last: target, side, instrument: inst,
      excluded: [...sk].map(Number), sold_levels: sold, sold_basis: basis, peak: pk, width: w });
    let e = plan_out(skips); const zero = new Set();
    if (pk !== null) {
      for (let it = 0; it < ahead.length; it++) {
        if (e.lots.reduce((a, b) => a + b, 0) <= 0) break;
        const z = new Set(); e.levels.forEach((p, i) => { if (e.lots[i] === 0 && !kept_out.has(k6(p))) z.add(k6(p)); });
        if (!z.size) break;
        for (const x of z) { zero.add(x); skips.add(x); }
        e = plan_out(skips);
      }
    }
    return [e, skips, zero];
  };
  const [ep, out_excl, out_zero] = exit_for(row);
  let peak_out_note = "";
  if (shape_o && peak_o === null) peak_out_note = "peak out on — click a rung in the blue dot column";
  else if (shape_o && ep.peak === null) peak_out_note = `peak out at ${g(peak_o)} is off the way out — equal regret`;
  const banks = new Map();
  for (const r of lp.rows) {
    const [e] = exit_for(r);
    banks.set(r.depth, (e.levels.length || !r.pos) ? e.rows[e.rows.length - 1].realised : null);
  }
  let cp = null;
  if (out_by !== null) cp = cuts_plan(pos_d ? avg_d : null, pos_d, stop, out_by, side, inst, sold);
  let cap_note = "";
  const held_row = lp.rows.find(r => r.held) || null;
  if (held_row !== null && max_loss && held_row.loss > max_loss + 0.5) {
    const where = out_by !== null ? `cut to ${g(out_by)}` : `at the ${g(stop)} stop`;
    cap_note = `filled loses ${d0(held_row.loss)} ${where}, ${d0(held_row.loss - max_loss)} over max loss`;
  }
  return { mark, entry, stop, target, first: f_sel, max_loss, sgn, side_word, problems,
    ph: [g(mark), g(pstop), g(pfirst), g(ptgt)], lp, ep, depths, sel, row, pos_d, avg_d,
    levels_held, sold, n_sold, held_avg, sold_note, peak_note, shape, peak_out_note, shape_out,
    in_excl, in_zero, out_excl, out_zero, banks, out_by, out_by_typed, cp, risk_ref, cap_note };
}

const TB = { TICK, DOLLARS_PER_BP, PEAK_WIDTHS, PROXY_STOP_TICKS, PROXY_TGT_TICKS, EXIT_SPAN_TICKS,
  pyRoundInt, r6, k6, g, d0, f3, px3, commas, sign, entry_levels, peak_width, ladder_plan, depth_table, blend,
  exit_levels, regret_at, exits_plan, cut_levels, cuts_plan, fit_in, restate, _fnum, _snap, _key, _first_profit,
  _window, _levels_now, _trade_default_in_skips, _trade_effective_in_skips, _effective_out_skips, _toggle_skip,
  _filter_skips, _levels_of, _trade_setup };
if (typeof module !== "undefined" && module.exports) module.exports = TB; else root.TB = TB;
})(typeof window !== "undefined" ? window : globalThis);

