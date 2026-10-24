/* The Trade page in the browser: Mathur-Git/trade-board's scripts/trade_page.py callbacks and renderer,
 * assets/ladder-drag.js and assets/trade-loss.js, ported. One state object stands in for the Dash
 * stores; every handler mirrors one callback and then redraws, as Dash would. The arithmetic is in
 * core.js (TB), which matches the Python number for number. */
(function () {
"use strict";
const TB = window.TB;
const { TICK, PEAK_WIDTHS, g, d0, px3, r6, k6, _fnum, _snap, _key } = TB;
const TRADE_WINDOW_TICKS = 10, TRADE_RUNGS_MIN = 8, TRADE_RUNGS_MAX = 18, LOSS_STEP = 500, TRADE_LABEL_SPAN = 11;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = n => Number(n).toLocaleString("en-US");
const f1 = v => v.toFixed(1), f3 = v => v.toFixed(3);

// ---- state: the page's stores ------------------------------------------------------------
const TEXT = ["mark", "entry", "stop", "first", "target", "loss", "outby", "settle"];
const INPUT_ID = { mark: "tr-mark", entry: "tr-entry", stop: "tr-stop", first: "tr-first", target: "tr-target",
                   loss: "tr-loss", outby: "tr-outby", settle: "tr-settle" };
const S = { inst: "SR3", side: "buy", mark: null, entry: null, stop: null, first: null, target: null, loss: null,
            outby: null, settle: null, held: {}, sold: {}, excl_in: { off: [], on: [] }, excl_out: { off: [], on: [] },
            depth: null, rungs: TRADE_WINDOW_TICKS, peak: null, shape: "off", peak_out: null, shape_out: "off",
            exit_on: "on" };
const P = { loaded: null, msg: null, armed: null, plan: null, ver: null };   // plan stores

const setup = (st = S, ei = st.excl_in, eo = st.excl_out) => TB._trade_setup(st.inst, st.side, st.mark, st.entry,
  st.held, st.sold, st.stop, st.first, st.target, st.loss, ei, eo, st.depth, st.peak, st.shape, st.peak_out, st.shape_out, st.outby);

// ---- skip stores (trade_skip_in / trade_skip_out) -------------------------------------
function inLevelsNow() {
  let entry = _snap(_fnum(S.entry)); if (entry === null) entry = _snap(_fnum(S.mark));
  return TB._levels_now(entry, _snap(_fnum(S.stop)), S.side);
}
function filterIn() { S.excl_in = TB._filter_skips(S.excl_in, new Set(inLevelsNow().map(k6))); }
function filterOut() {
  const s = setup(); if (s === null) return;
  S.excl_out = TB._filter_skips(S.excl_out, new Set(s.ep.ahead.map(k6)));
}
function clickIn(lv) {
  const levels = inLevelsNow(), store = S.excl_in || {};
  const off = new Set((store.off || []).map(x => k6(+x))), on = new Set((store.on || []).map(x => k6(+x))), k = k6(lv);
  const auto = new Set(TB._trade_default_in_skips(levels));
  if (PEAK_WIDTHS[S.shape] && S.peak !== null) {
    const base = { off: [...off].filter(x => x !== k).map(Number).sort((a, b) => a - b),
                   on: [...on].filter(x => x !== k).map(Number).sort((a, b) => a - b) };
    const s = setup(S, base, S.excl_out);
    if (s !== null) for (const z of s.in_zero) auto.add(z);
  }
  const skipped = (auto.has(k) || off.has(k)) && !on.has(k);
  off.delete(k); on.delete(k);
  if (skipped && auto.has(k)) on.add(k); else if (!skipped && !auto.has(k)) off.add(k);
  S.excl_in = { off: [...off].map(Number).sort((a, b) => a - b), on: [...on].map(Number).sort((a, b) => a - b) };
}
function clickOut(lv) {
  const s = setup(); if (s === null) return;
  const auto = new Set();                                          // _no_default
  if (PEAK_WIDTHS[S.shape_out] && S.peak_out !== null) {
    const st = S.excl_out || {};
    const base = { off: (st.off || []).filter(x => Math.abs(+x - lv) > 1e-9), on: (st.on || []).filter(x => Math.abs(+x - lv) > 1e-9) };
    const s0 = setup(S, S.excl_in, base);
    if (s0 !== null) for (const z of s0.out_zero) auto.add(z);
  }
  S.excl_out = TB._toggle_skip(S.excl_out, lv, auto);
}

// ---- marks: draggable flags (_trade_marks) ---------------------------------------------
const OUT_KINDS = new Set(["first", "target"]);
function marksHtml(tags, side, lo, hi, entry, stop, first, target, avg, out_by, exit_on) {
  const t = TICK; let band;
  if (side === "buy") band = { stop: [out_by === null ? lo : r6(out_by + t), r6(entry - t)], entry: [r6(stop + t), hi],
    first: [TB._first_profit(avg, "buy"), r6(target - t)], target: [r6((exit_on ? first : entry) + t), hi], outby: [lo, r6(stop - t)] };
  else band = { stop: [r6(entry + t), out_by === null ? hi : r6(out_by - t)], entry: [lo, r6(stop - t)],
    first: [r6(target + t), TB._first_profit(avg, "sell")], target: [lo, r6((exit_on ? first : entry) - t)], outby: [r6(stop + t), hi] };
  const ids = { stop: "tr-stop", entry: "tr-entry", first: "tr-first", target: "tr-target", outby: "tr-outby" };
  return tags.map(([kind, text]) => {
    const b = band[kind];
    if (b && b[0] <= b[1]) return `<span class="lad-tag lad-flag" data-kind="${kind}" data-input="${ids[kind]}" data-lo="${g(b[0])}" data-hi="${g(b[1])}">${text}</span>`;
    return `<span class="lad-tag" data-kind="${kind}">${text}</span>`;
  }).join("");
}
function ruleAt(grid, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return [null, 0];
  for (const lv of grid) if (lv - TICK / 2 < value && value <= lv + TICK / 2) return [lv, 0.5 + (lv - value) / TICK];
  return [null, 0];
}
const riskTxt = v => Math.abs(v) < 0.5 ? "" : d0(v);

// ---- the ladder (_trade_book) --------------------------------------------------------------
function tradeBook(lp, ep, side, mark, avg, held_map, sold_map, in_excl, out_excl, ticks, sel, peak, shape_on, peak_out, shape_out_on, cp, risk_ref, exit_on) {
  const entry = lp.entry, stop = lp.stop;
  const first = ep.first, target = exit_on ? ep.last : lp.target;
  const out_by = cp ? cp.out_by : null;
  risk_ref = risk_ref === null ? stop : risk_ref;
  const mapOf = (lv, q) => { const m = new Map(); lv.forEach((p, i) => m.set(k6(p), q[i])); return m; };
  const in_q = mapOf(lp.levels, lp.lots), out_q = exit_on ? mapOf(ep.levels, ep.lots) : new Map();
  const in_at = new Map(); for (const r of lp.rows) if (!r.held && r.depth > 0) in_at.set(k6(r.level), r);
  const out_at = new Map(); if (exit_on) for (const r of ep.rows) if (r.depth > 0) out_at.set(k6(r.level), r);
  const cut_q = cp && exit_on ? mapOf(cp.levels, cp.lots) : new Map();
  const cut_left = cp && exit_on ? mapOf(cp.levels, cp.left) : new Map();
  const ahead = exit_on ? new Set(ep.ahead.map(k6)) : new Set();
  const passed = exit_on ? new Set([...ep.passed, ...(cp ? cp.passed : [])].map(k6)) : new Set();
  const allIn = new Set(lp.all_levels.map(k6));
  const [lo, hi] = TB._window(mark, side, ticks);
  const n = TB.pyRoundInt((hi - lo) / TICK), grid = [];
  for (let i = 0; i <= n; i++) grid.push(r6(hi - i * TICK));
  const big_in = lp.lots.length ? Math.max(...lp.lots) : 0, big_out = ep.lots.length ? Math.max(...ep.lots) : 0;
  const big_cut = cp && cp.lots.length ? Math.max(...cp.lots) : 0;
  const [avg_row, avg_frac] = ruleAt(grid, avg);
  const out_avg = (avg !== null && exit_on) ? ep.avg_out : null;
  const [out_row, out_frac] = ruleAt(grid, out_avg);
  const rules = [[avg_row, avg_frac, "lad-avgline"], [out_row, out_frac, "lad-avgline out"]];
  const dpb = lp.dollars_per_bp, sgn = TB.sign(side);
  const held_lv = new Map(); for (const [p, q] of lp.held_levels) held_lv.set(_key(p), [p, q]);
  const risk_at = (lv, q) => q * sgn * (lv - risk_ref) * dpb;
  const pnl_at = (lv, q) => q * sgn * (lv - ep.avg) * dpb;
  const regret_at = (lv, q) => TB.regret_at(lv, q, target, side, dpb);
  const rows = [];
  for (const lv of grid) {
    const K = k6(lv), qi = in_q.get(K) || 0, qo = out_q.get(K) || 0, r_in = in_at.get(K);
    const unc = r_in !== undefined && sel !== null && r_in.depth > sel;
    const work_in = allIn.has(K), work_out = ahead.has(K), work_cut = cut_q.has(K) && !work_out;
    const qc = work_cut ? (cut_q.get(K) || 0) : 0;
    const skip_in = work_in && in_excl.has(K), skip_out = work_out && out_excl.has(K);
    const cls = ["lad-row"], tags = [];
    if (passed.has(K) && !work_in) cls.push("ex-passed");
    if (Math.abs(lv - mark) < 1e-9) cls.push("ex-mkt", side === "buy" ? "lad-mkt-above" : "lad-mkt-below");
    if (Math.abs(lv - entry) < 1e-9) { cls.push("lad-entry"); tags.push(["entry", "ENTRY"]); }
    if (avg_row !== null && Math.abs(lv - avg_row) < 1e-9) cls.push("lad-avg");
    if (Math.abs(lv - stop) < 1e-9) { cls.push("lad-stop"); tags.push(["stop", "STOP"]); }
    if (exit_on && Math.abs(lv - first) < 1e-9) { cls.push("ex-first"); tags.push(["first", "1ST"]); }
    if (Math.abs(lv - target) < 1e-9) { cls.push("lad-tgt"); tags.push(["target", "TGT"]); }
    if (out_by !== null && Math.abs(lv - out_by) < 1e-9) { cls.push("lad-outby"); tags.push(["outby", "OUT BY"]); }
    const tags_in = tags.filter(t => !OUT_KINDS.has(t[0])), tags_out = tags.filter(t => OUT_KINDS.has(t[0]));
    if ((skip_in || skip_out) && !(qi || qo)) cls.push("lad-skip");
    if (qi || qo || qc) cls.push("lad-live");
    if (work_in || work_out || work_cut) cls.push("lad-work");
    const wi = big_in && qi ? `${(100 * qi / big_in).toFixed(1)}%` : "0%";
    const wo = big_out && qo ? `${(100 * qo / big_out).toFixed(1)}%` : "0%";
    const wc = big_cut && qc ? `${(100 * qc / big_cut).toFixed(1)}%` : "0%";
    const bar_in = `<div class="lad-barwrap${unc ? " tr-unc" : ""}"><div class="lad-bar ${side === "buy" ? "bid" : "ask"}" style="width:${wi}"></div></div>`;
    const bar_out = `<div class="lad-barwrap"><div class="lad-bar ${side === "buy" ? "ask" : "bid"}" style="width:${work_cut ? wc : wo}"></div></div>`;
    const empty = `<div class="lad-barwrap"></div>`;
    const hv = held_map[String(_key(lv))], sv = sold_map[String(_key(lv))];
    const held = `<td class="lad-held-c"><div class="lad-held-in"><input type="number" min="0" step="1" data-held="${_key(lv)}" value="${hv ?? ""}"></div></td>`;
    const sold = `<td class="lad-held-c ex-sold-c"><div class="lad-held-in"><input type="number" min="0" step="1" data-sold="${_key(lv)}" value="${sv ?? ""}"></div></td>`;
    const cell = (q, skipped, workable, klass, kind) => {
      const txt = skipped ? "skip" : (q ? num(q) : "");
      if (skipped) klass = `${klass} is-skip`;
      if (workable) return `<td class="${klass} tr-work clickable" data-skip="${kind}" data-p="${_key(lv)}">${txt}</td>`;
      return `<td class="${klass}">${txt}</td>`;
    };
    const pos_txt = in_at.has(K) ? num(in_at.get(K).pos) : "";
    const left_txt = out_at.has(K) ? num(out_at.get(K).left) : (work_cut && cp.position ? num(cut_left.get(K)) : "");
    const out_cell = work_cut ? `<td class="tr-out-c tr-cut">${qc ? num(qc) : ""}</td>` : cell(qo, skip_out, work_out, "tr-out-c", "out");
    const h = held_lv.get(_key(lv));
    const h_risk = risk_at(lv, h ? h[1] : 0), i_risk = risk_at(lv, qi), o_regret = regret_at(lv, qo);
    const is_peak = peak !== null && Math.abs(lv - peak) < 1e-9;
    const dot_cls = "tr-peak-c" + (lp.peak !== null ? "" : " is-off");
    const dot = (shape_on && work_in) ? `<td class="${dot_cls} clickable" data-peak="in" data-p="${_key(lv)}">${is_peak ? "●" : ""}</td>` : `<td class="${dot_cls}">${is_peak ? "●" : ""}</td>`;
    const is_peak_o = peak_out !== null && Math.abs(lv - peak_out) < 1e-9;
    const dot_o_cls = "tr-peak-c tr-peak-out-c" + (ep.peak !== null ? "" : " is-off");
    const dot_o = (shape_out_on && work_out) ? `<td class="${dot_o_cls} clickable" data-peak="out" data-p="${_key(lv)}">${is_peak_o ? "●" : ""}</td>` : `<td class="${dot_o_cls}">${is_peak_o ? "●" : ""}</td>`;
    const avgForMarks = avg !== null ? avg : entry;
    let px = `<span class="lad-px">${f1(lv)}</span>`;
    for (const [row, frac, klass] of rules) if (row !== null && Math.abs(lv - row) < 1e-9) px += `<div class="${klass}" style="top:${(frac * 100).toFixed(2)}%"></div>`;
    rows.push(`<tr class="${cls.join(" ")}">` +
      `<td class="lad-mark-c mk-in">${marksHtml(tags_in, side, lo, hi, entry, stop, first, target, avgForMarks, out_by, exit_on)}</td>` +
      `<td class="lad-mark-c mk-out">${marksHtml(tags_out, side, lo, hi, entry, stop, first, target, avgForMarks, out_by, exit_on)}</td>` +
      held + cell(qi, skip_in, work_in, "tr-in-c" + (unc ? " tr-unc" : ""), "in") +
      `<td class="lad-bid-c">${work_in ? bar_in : empty}</td>` +
      `<td class="lad-px-c">${px}</td>` +
      `<td class="lad-ask-c">${(work_out || work_cut) ? bar_out : empty}</td>` +
      out_cell + sold +
      `<td class="tr-pos-c${unc ? " tr-unc" : ""}">${pos_txt}</td>` +
      `<td class="tr-left-c">${left_txt}</td>` +
      `<td class="tr-risk-c">${riskTxt(h_risk)}</td>` +
      `<td class="tr-risk-c${unc ? " tr-unc" : ""}">${riskTxt(i_risk)}</td>` +
      `<td class="tr-risk-c tr-risk-o">${riskTxt(o_regret)}</td>` + dot + dot_o + `</tr>`);
  }
  // the foot
  const shown = new Set(grid.map(_key));
  let held_tot = 0, held_off = 0; for (const [k, [p, q]] of held_lv) { held_tot += risk_at(p, q); if (!shown.has(k)) held_off += risk_at(p, q); }
  let in_tot = 0, in_off = 0; lp.levels.forEach((p, i) => { in_tot += risk_at(p, lp.lots[i]); if (!shown.has(_key(p))) in_off += risk_at(p, lp.lots[i]); });
  const sold_off = lp.sold ? (lp.sold * sgn * (lp.held_avg - risk_ref) * dpb + lp.banked) : 0.0;
  let out_pnl = 0, out_tot = 0, out_off = 0;
  ep.levels.forEach((p, i) => { out_pnl += pnl_at(p, ep.lots[i]); out_tot += regret_at(p, ep.lots[i]); if (!shown.has(_key(p))) out_off += regret_at(p, ep.lots[i]); });
  let banked = ep.sold ? ep.banked : 0.0;
  let sold_regret = 0; for (const [p, q] of ep.sold_levels) sold_regret += regret_at(p, q);
  const span = exit_on ? TRADE_LABEL_SPAN : TRADE_LABEL_SPAN - 4;
  if (!exit_on) { const r_sel = lp.rows.find(r => r.depth === sel); out_pnl = r_sel ? r_sel.pnl : 0.0; banked = 0.0; }
  const foot = (label, h, i, o, klass = "") => `<tr class="${("tr-risk-foot " + klass).trim()}"><td colspan="${span}" class="tr-risk-lbl">${label}</td>` +
    `<td class="tr-risk-c">${riskTxt(h)}</td><td class="tr-risk-c">${riskTxt(i)}</td><td class="tr-risk-c tr-risk-o">${riskTxt(o)}</td>` +
    `<td class="tr-peak-c"></td><td class="tr-peak-c tr-peak-out-c"></td></tr>`;
  if ([held_tot, in_tot, out_tot, banked, sold_regret].some(x => Math.abs(x) >= 0.5)) {
    if ([held_off, in_off, out_off].some(x => Math.abs(x) >= 0.5)) rows.push(foot("off the ladder", held_off, in_off, out_off));
    if (lp.sold) rows.push(foot("sold / banked", -sold_off, 0.0, sold_regret));
    const held_net = held_tot - sold_off, word = cp ? "if cut" : "if stopped";
    rows.push(foot(`total  ·  ${word} ${d0(held_net + in_tot)}  ·  if it works ${d0(out_pnl + banked)}`, held_net, in_tot, out_tot + sold_regret, "tr-risk-total"));
  }
  return rows.join("");
}

function depthLabel(sel, depths, held) {
  if (sel === null || !depths.length) return "—";
  if (sel === 0) return "filled only";
  if (sel === depths[depths.length - 1]) return "full fill";
  const n = `${sel} rung${sel !== 1 ? "s" : ""}`;
  return held ? `filled + ${n}` : n;
}
function depthRows(lp, sel, banks) {
  const out = [`<tr class="lad-head"><th class="dot"></th><th>depth</th><th>lots</th><th>pos</th><th>avg</th><th>loss</th><th>P&amp;L</th><th>R:R</th></tr>`];
  const last = lp.rows.length ? lp.rows[lp.rows.length - 1].depth : 0;
  for (const r of lp.rows) {
    const cls = [r.depth === last ? "lad-full" : "", r.held ? "lad-held-row" : ""].filter(Boolean);
    if (r.depth === sel) cls.push("tr-picked"); else if (sel !== null && r.depth > sel) cls.push("tr-uncounted");
    const label = r.held ? `filled @ ${px3(r.level)}` : `${r.depth} @ ${f1(r.level)}`;
    let pnl = banks.get(r.depth); pnl = (pnl === null || pnl === undefined) ? NaN : pnl;
    const rr = r.loss > 0 ? pnl / r.loss : NaN;
    const cellN = (v, fmt, k) => {
      const ok = isFinite(v) && !Number.isNaN(v);
      const txt = ok ? (fmt === "d0" ? d0(v) : fmt === "3" ? f3(v) : v.toFixed(2)) : "-";
      return `<td class="${ok ? `val ${k}` : "val"}">${txt}</td>`;
    };
    out.push(`<tr class="${cls.concat(["clickable"]).join(" ")}" data-depth="${r.depth}">` +
      `<td class="dot">${r.depth === sel ? "●" : ""}</td><td class="lbl">${label}</td>` +
      `<td class="val">${num(r.lots)}</td><td class="val">${num(r.pos)}</td>` +
      cellN(r.avg, "3", "") + cellN(r.loss, "d0", r.loss > 0 ? "neg" : (r.loss < 0 ? "pos" : "")) +
      cellN(pnl, "d0", pnl && pnl > 0 ? "pos" : "") + cellN(rr, "2", "rr") + `</tr>`);
  }
  return out.join("");
}
function exitRows(p, stop_word = "if stopped") {
  const out = [`<tr class="lad-head"><th>reaches</th><th>sell</th><th>left</th><th>avg out</th><th>banked</th><th>${stop_word}</th><th>if runs</th></tr>`];
  const last = p.rows.length ? p.rows[p.rows.length - 1].depth : 0;
  for (const r of p.rows) {
    const cls = [r.depth === last ? "lad-full" : "", r.free ? "ex-free-row" : ""].filter(Boolean).join(" ");
    const label = r.depth === 0 ? "now" : f1(r.level);
    out.push(`<tr class="${cls}"><td class="lbl">${label}</td><td class="val">${r.lots ? num(r.lots) : "—"}</td>` +
      `<td class="val">${num(r.left)}</td><td class="val">${r.sold === 0 ? "—" : f3(r.avg_out)}</td>` +
      `<td class="val pos">${d0(r.realised)}</td><td class="val ${r.if_stopped > -0.5 ? "pos" : "neg"}">${d0(r.if_stopped)}</td>` +
      `<td class="val rr">${d0(r.if_runs)}</td></tr>`);
  }
  return out.join("");
}
const useText = (typed, used) => { const t = _fnum(typed); return (used === null || t === null || Math.abs(t - used) < 1e-9) ? "" : `using ${g(used)}`; };
const inRule = (lp, shape) => lp.peak === null ? "equal risk in" : `peaked risk in (${g(lp.peak)}, ${shape}, half at ±${lp.width.toFixed(2)}bp)`;
const outRule = (ep, shape) => ep.peak === null ? "equal regret out" : `peaked regret out (${g(ep.peak)}, ${shape}, half at ±${ep.width.toFixed(2)}bp)`;
function settleMarked(lp, settle, sgn) {
  if (settle === null) return null;
  const held = lp.held && lp.held_avg !== null ? lp.held * sgn * (settle - lp.held_avg) * lp.dollars_per_bp : 0.0;
  return lp.banked + held;
}

// ---- draw_trade ---------------------------------------------------------------------------
function setText(id, v) { const el = $(id); if (el && el.textContent !== v) el.textContent = v; }
function setPh(id, v) { const el = $(id); if (el) el.placeholder = v; }
function draw() {
  const exit_on = S.exit_on !== "off";
  // trade_mark_label
  const word = S.side === "buy" ? "below" : "above", flip = S.side === "buy" ? "above" : "below";
  setPh("tr-mark", S.side === "buy" ? "bid" : "ask");
  setText("tr-caption", exit_on ? `in ${word} the line, out ${flip} it - click a size to skip` : `in ${word} the line - click a size to skip`);
  setText("tr-depth-cap", exit_on ? "if it fills this far, then works out - click a row" : "if it fills this far, then reaches the target - click a row");
  $("tr-main").className = "chart-card panel tr-main" + (exit_on ? "" : " tr-exit-off");
  const rv = S.rungs || TRADE_WINDOW_TICKS;
  setText("tr-rungs-val", String(rv)); $("tr-rungs-dn").disabled = rv <= TRADE_RUNGS_MIN; $("tr-rungs-up").disabled = rv >= TRADE_RUNGS_MAX;
  const ln = Number(String(S.loss || "").replace(/[,$\s]/g, "")); $("tr-loss-dn").disabled = !(ln > LOSS_STEP);
  const s = setup();
  const put = o => {
    $("tr-rows").innerHTML = o.book; setText("tr-title", o.title); $("tr-depth").innerHTML = o.depth;
    setText("tr-exit-head", o.head); $("tr-exit").innerHTML = o.exit; setText("tr-foot", o.foot);
    ["tr-entry", "tr-stop", "tr-first", "tr-target"].forEach((id, i) => setPh(id, o.ph[i]));
    ["tr-entry-use", "tr-stop-use", "tr-first-use", "tr-target-use", "tr-avg-in", "tr-avg-out", "tr-pnl-in", "tr-pnl-out"].forEach((id, i) => setText(id, o.extra[i]));
    setPh("tr-outby", o.ob[0]); setText("tr-outby-use", o.ob[1]);
    setPh("tr-settle", o.stl[0]); setText("tr-settle-use", o.stl[1]); setText("tr-stl-in", o.stl[2]); setText("tr-stl-out", o.stl[3]);
  };
  if (s === null) {
    put({ book: "", title: "", depth: "", head: `type the ${S.side === "buy" ? "bid" : "ask"} at the top of the ladder`, exit: "", foot: "",
      ph: ["entry", "stop", "first", "target"], extra: ["", "", "", "", "—", "—", "—", "—"], ob: ["at stop", ""], stl: ["none", "", "—", "—"] });
    planStatus(); return;
  }
  const cp = s.cp; let ob_note;
  if (s.out_by_typed !== null && s.out_by === null) ob_note = "not past the stop · ignored";
  else { const bits = [s.out_by !== null ? useText(S.outby, s.out_by) : ""]; if (cp && cp.avg_cut !== null) bits.push(`avg cut ${f3(cp.avg_cut)}`); ob_note = bits.filter(Boolean).join(" · "); }
  const ob = ["at stop", ob_note];
  const extra = [useText(S.entry, s.entry), useText(S.stop, s.stop), useText(S.first, s.first), useText(S.target, s.target), "—", "—"];
  const typed_first = _snap(_fnum(S.first)), typed_target = S.target;
  const { mark, entry, stop } = s; let target = s.target;
  const first = s.first, sgn = s.sgn, lp = s.lp, ep = s.ep, depths = s.depths, sel = s.sel, row = s.row;
  let banks = s.banks;
  if (!exit_on) { target = lp.target; extra[3] = useText(typed_target, target); banks = new Map(lp.rows.map(r => [r.depth, r.pnl])); }
  const pos_d = s.pos_d, avg_d = s.avg_d, n_sold = s.n_sold;
  const lowest = TB._first_profit(avg_d, S.side), lim = S.side === "buy" ? "min" : "max";
  if (extra[2]) {
    const past = typed_first !== null && sgn * (typed_first - lowest) < -1e-9;
    const on_lim = typed_first !== null && Math.abs(typed_first - lowest) < 1e-9;
    extra[2] = past ? `${S.side === "buy" ? "below" : "above"} ${lim} · using ${g(lowest)}` : on_lim ? `${extra[2]} · ${lim}` : `${extra[2]} · ${lim} ${g(lowest)}`;
  } else extra[2] = `${lim} ${g(lowest)}`;
  if (pos_d) { extra[4] = f3(avg_d); if (!Number.isNaN(ep.avg_out)) extra[5] = f3(ep.avg_out); }
  const ticks = Math.max(TRADE_RUNGS_MIN, Math.min(TRADE_RUNGS_MAX, Math.trunc(S.rungs || TRADE_WINDOW_TICKS)));
  const book = tradeBook(lp, ep, S.side, mark, pos_d ? avg_d : null, S.held, S.sold, s.in_excl, s.out_excl, ticks, sel,
    _snap(_fnum(S.peak)), !!PEAK_WIDTHS[S.shape], _snap(_fnum(S.peak_out)), !!PEAK_WIDTHS[S.shape_out], cp, s.risk_ref, exit_on);
  let title = exit_on ? `${S.inst}   ${s.side_word}   ${g(entry)} → ${g(stop)} in, ${g(first)} → ${g(target)} out`
                      : `${S.inst}   ${s.side_word}   ${g(entry)} → ${g(stop)} in, target ${g(target)}`;
  if (cp && exit_on) title += `, ${g(cp.all_levels[0])} → ${g(cp.all_levels[cp.all_levels.length - 1])} cut`;
  if (s.cap_note) title += `   ·   ${s.cap_note}`;
  if (lp.held) title += `   ·   ${num(lp.held)} already on at ${f3(lp.held_avg)}`;
  if (s.peak_note) title += `   ·   ${s.peak_note}`;
  if (s.peak_out_note && exit_on) title += `   ·   ${s.peak_out_note}`;
  if (s.sold_note) title += `   ·   ${s.sold_note}`; else if (n_sold && exit_on) title += `   ·   ${num(n_sold)} sold`;
  const pnl = row ? banks.get(sel) : null, have_pnl = pnl !== null && pnl !== undefined && !Number.isNaN(pnl);
  extra.push(row ? d0(-row.loss) : "—", have_pnl ? d0(pnl) : "—");
  const settle_px = _fnum(S.settle), marked = settleMarked(lp, settle_px, sgn);
  let stl;
  if (marked === null) stl = ["none", "", "—", "—"];
  else { const note = (lp.held || lp.sold) ? `on books ${d0(marked)}` : "nothing on yet · same as p&l";
    stl = ["none", note, row ? d0(-row.loss - marked) : "—", have_pnl ? d0(pnl - marked) : "—"]; }
  if (!lp.levels.length && !ep.levels.length) {
    put({ book, title, depth: "", head: "no rungs between the stop and the target", exit: "", foot: "", ph: s.ph, extra, ob, stl });
    planStatus(); return;
  }
  const head = pos_d ? `then, coming out of ${num(pos_d)}${n_sold ? " still on" : ""} at ${f3(avg_d)} — ${depthLabel(sel, depths, !!lp.held)}`
                     : "then, coming out — nothing to sell yet";
  const cut_rule = cp ? `, equal loss cut, risk in measured to its ${f3(s.risk_ref)} average` : "";
  const out_bits = exit_on ? `${outRule(ep, S.shape_out)}${cut_rule}  ·  stop excluded going in${cp ? " and cutting" : ""}, target excluded coming out`
                           : "P&L to the target  ·  stop excluded going in";
  const foot = `${S.inst}  ·  $${lp.dollars_per_bp.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/bp  ·  ` +
    `$${lp.tick_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/tick  ·  ${TICK}bp grid  ·  ${inRule(lp, S.shape)}, ${out_bits}  ·  no flipping on this page`;
  put({ book, title, depth: depthRows(lp, sel, banks), head, exit: exitRows(ep, cp ? "if cut" : "if stopped"), foot, ph: s.ph, extra, ob, stl });
  planStatus();
}

// ---- inputs ---------------------------------------------------------------------------------
function syncInputs() {
  for (const k of TEXT) { const el = $(INPUT_ID[k]); if (el && document.activeElement !== el) el.value = S[k] ?? ""; }
  for (const [id, key] of [["tr-inst", "inst"], ["tr-side", "side"], ["tr-shape", "shape"], ["tr-shape-out", "shape_out"], ["tr-exit-on", "exit_on"]])
    document.querySelectorAll(`#${id} input`).forEach(i => { i.checked = i.value === S[key]; });
}
function setField(k, v) {                         // a typed field committed
  v = (v === null || v === undefined || String(v).trim() === "") ? null : String(v);
  if (S[k] === v) return;
  S[k] = v;
  if (["entry", "stop", "mark"].includes(k)) filterIn();
  if (["first", "target"].includes(k)) filterOut();
  draw();
}
const timers = {};
for (const k of TEXT) {
  const el = $(INPUT_ID[k]);
  el.addEventListener("input", () => { clearTimeout(timers[k]); timers[k] = setTimeout(() => setField(k, el.value), 500); });
  el.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timers[k]); setField(k, el.value); } });
  el.addEventListener("blur", () => { clearTimeout(timers[k]); setField(k, el.value); });
}
function radio(id, key, after) {
  $(id).addEventListener("change", e => { if (e.target && e.target.name === id) { S[key] = e.target.value; if (after) after(); draw(); } });
}
radio("tr-inst", "inst");
radio("tr-side", "side", () => { filterIn(); filterOut(); });
radio("tr-shape", "shape");
radio("tr-shape-out", "shape_out");
radio("tr-exit-on", "exit_on");

// Held and Sold boxes sit inside the ladder, which is rebuilt on every change, so they commit on
// change (blur / Enter), as dcc.Input(debounce=True) does.
$("tr-rows").addEventListener("change", e => {
  const t = e.target; if (!t || t.tagName !== "INPUT") return;
  const store = t.dataset.held !== undefined ? "held" : t.dataset.sold !== undefined ? "sold" : null; if (!store) return;
  const key = t.dataset.held ?? t.dataset.sold, v = parseInt(t.value, 10), cur = { ...S[store] };
  if (v && v > 0) cur[key] = v; else delete cur[key];
  if (JSON.stringify(cur) === JSON.stringify(S[store])) return;
  S[store] = cur;
  if (store === "sold") filterOut();
  draw();
});
$("tr-rows").addEventListener("click", e => {
  if (Date.now() < suppressUntil) return;
  const td = e.target.closest("td"); if (!td) return;
  if (td.dataset.skip) {
    const lv = r6(parseInt(td.dataset.p, 10) / 2);
    if (td.dataset.skip === "in") clickIn(lv); else clickOut(lv);
    draw(); return;
  }
  if (td.dataset.peak) {
    const lv = r6(parseInt(td.dataset.p, 10) / 2), key = td.dataset.peak === "in" ? "peak" : "peak_out";
    S[key] = (S[key] !== null && Math.abs(+S[key] - lv) < 1e-9) ? null : lv;
    draw();
  }
});
$("tr-depth").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-depth]"); if (!tr) return;
  S.depth = parseInt(tr.dataset.depth, 10); draw();
});
$("tr-rungs-dn").addEventListener("click", () => { S.rungs = Math.max(TRADE_RUNGS_MIN, (S.rungs || TRADE_WINDOW_TICKS) - 1); draw(); });
$("tr-rungs-up").addEventListener("click", () => { S.rungs = Math.min(TRADE_RUNGS_MAX, (S.rungs || TRADE_WINDOW_TICKS) + 1); draw(); });
$("tr-clear").addEventListener("click", () => {
  S.excl_in = { off: [], on: [...TB._trade_default_in_skips(inLevelsNow())].map(Number).sort((a, b) => a - b) };
  S.excl_out = { off: [], on: [] }; draw();
});
$("tr-clear-held").addEventListener("click", () => { S.held = {}; draw(); });
$("tr-clear-sold").addEventListener("click", () => { S.sold = {}; filterOut(); draw(); });
$("tr-clear-all").addEventListener("click", () => {
  for (const k of TEXT) S[k] = null;
  Object.assign(S, { held: {}, sold: {}, excl_in: { off: [], on: [] }, excl_out: { off: [], on: [] }, depth: null, peak: null, peak_out: null });
  syncInputs(); draw();
});
// max loss steps by 500 (assets/trade-loss.js)
function stepLoss(dir) {
  const el = $("tr-loss"), raw = String(el.value || "").replace(/[,$\s]/g, ""), v = raw === "" ? null : Number(raw);
  let n;
  if (dir > 0) n = (v === null || isNaN(v)) ? LOSS_STEP : Math.floor(v / LOSS_STEP) * LOSS_STEP + LOSS_STEP;
  else { if (v === null || isNaN(v) || v <= LOSS_STEP) return; n = Math.max(LOSS_STEP, Math.ceil(v / LOSS_STEP) * LOSS_STEP - LOSS_STEP); }
  el.value = String(n); $("tr-loss-dn").disabled = !(n > LOSS_STEP);
  clearTimeout(timers.loss); timers.loss = setTimeout(() => setField("loss", el.value), 500);
}
$("tr-loss-up").addEventListener("click", () => stepLoss(1));
$("tr-loss-dn").addEventListener("click", () => stepLoss(-1));
$("tr-loss").addEventListener("keydown", e => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault(); stepLoss(e.key === "ArrowUp" ? 1 : -1);
});
// theme
$("theme-btn").addEventListener("click", () => {
  const root = $("root"), dark = root.classList.contains("theme-dark");
  root.className = dark ? "theme-light" : "theme-dark"; $("theme-btn").textContent = dark ? "Dark" : "Light";
  try { localStorage.setItem("tbTheme", dark ? "light" : "dark"); } catch (e) {}
});
try { if (localStorage.getItem("tbTheme") === "light") { $("root").className = "theme-light"; $("theme-btn").textContent = "Dark"; } } catch (e) {}

// ---- drag a flag with the left button (assets/ladder-drag.js) ---------------------------------
let drag = null, suppressUntil = 0;
document.addEventListener("click", e => { if (Date.now() < suppressUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
const priceOf = tr => { const el = tr && tr.querySelector(".lad-px"); return el ? parseFloat(el.textContent) : NaN; };
document.addEventListener("mousedown", e => {
  if (e.button !== 0 || !e.target.closest) return;
  const flag = e.target.closest(".lad-flag"); if (!flag) return;
  const body = flag.closest("tbody"), tr = flag.closest("tr"); if (!body || !tr) return;
  const rows = [...body.querySelectorAll("tr")], from = rows.indexOf(tr); if (from < 0) return;
  const lo = parseFloat(flag.getAttribute("data-lo")), hi = parseFloat(flag.getAttribute("data-hi"));
  let first = -1, last = -1;
  rows.forEach((r, i) => { const px = priceOf(r); if (isFinite(px) && px >= lo - 1e-9 && px <= hi + 1e-9) { if (first < 0) first = i; last = i; } });
  if (first < 0) return;
  e.preventDefault();
  drag = { flag, rows, from, to: from, first, last, input: flag.getAttribute("data-input"), rowH: tr.getBoundingClientRect().height || 22, y0: e.clientY };
  flag.classList.add("dragging"); document.body.classList.add("lad-dragging");
});
document.addEventListener("mousemove", e => {
  if (!drag) return;
  const want = drag.from + Math.round((e.clientY - drag.y0) / drag.rowH), to = Math.max(drag.first, Math.min(drag.last, want));
  if (to !== drag.to) { drag.rows[drag.to].classList.remove("lad-drop"); drag.to = to; drag.rows[to].classList.add("lad-drop"); }
  drag.flag.style.transform = "translateY(" + (drag.to - drag.from) * drag.rowH + "px)";
});
function finish() {
  if (!drag) return;
  const d = drag; drag = null; suppressUntil = Date.now() + 400;
  d.flag.classList.remove("dragging"); d.flag.style.transform = ""; document.body.classList.remove("lad-dragging");
  const row = d.rows[d.to]; if (row) row.classList.remove("lad-drop");
  if (d.to === d.from) return;
  const px = priceOf(row), input = $(d.input);
  if (input && isFinite(px)) { const v = String(Math.round(px * 2) / 2); input.value = v; const key = Object.keys(INPUT_ID).find(k => INPUT_ID[k] === d.input); setField(key, v); }
}
document.addEventListener("mouseup", finish);
window.addEventListener("blur", finish);

// ---- saved plans (lib/plans.py + the plan callbacks), kept in this browser --------------------
const PLAN_KEYS = ["inst", "side", "mark", "entry", "stop", "first", "target", "loss", "outby", "settle", "held", "sold",
                   "excl_in", "excl_out", "depth", "rungs", "peak", "shape", "peak_out", "shape_out"];
const PLAN_TEXT = new Set(["mark", "entry", "stop", "first", "target", "loss", "outby", "settle"]);
const LS = "tbPlans", LSA = "tbPlansArchive";
const store = () => { try { return JSON.parse(localStorage.getItem(LS) || "{}") || {}; } catch (e) { return {}; } };
const saveStore = s => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) {} };
const archiveAdd = (key, data) => { try { const a = JSON.parse(localStorage.getItem(LSA) || "{}") || {}; a[key] = data; localStorage.setItem(LSA, JSON.stringify(a)); } catch (e) {} };
const slug = name => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const nowIso = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = iso => { const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso || ""); return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[4]}:${m[5]}` : (iso || ""); };
function planNorm(st) {
  if (!st) return null;
  const out = {};
  for (const k of PLAN_KEYS) {
    let v = st[k];
    if (PLAN_TEXT.has(k)) v = (v !== null && v !== undefined) ? (String(v).trim() || null) : null;
    else if (k === "held" || k === "sold") { const o = {}; for (const [a, b] of Object.entries(v || {})) if (b) o[String(a)] = Math.trunc(b); v = o; }
    else if (k === "excl_in" || k === "excl_out") { v = v || {}; v = { off: (v.off || []).map(x => r6(+x)).sort((a, b) => a - b), on: (v.on || []).map(x => r6(+x)).sort((a, b) => a - b) }; }
    else if (k === "rungs") v = Math.trunc(v || TRADE_WINDOW_TICKS);
    else if (k === "peak" || k === "peak_out") v = (v !== null && v !== undefined) ? r6(+v) : null;
    else if (k === "shape" || k === "shape_out") v = PEAK_WIDTHS[v] ? v : "off";
    else if (k === "depth") v = (v === undefined) ? null : v;
    out[k] = v;
  }
  return out;
}
const planState = () => planNorm(S);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function planSnapshot(st) {
  const s = TB._trade_setup(st.inst, st.side, st.mark, st.entry, st.held, st.sold, st.stop, st.first, st.target, st.loss,
    st.excl_in, st.excl_out, st.depth, st.peak, st.shape, st.peak_out, st.shape_out, st.outby);
  if (s === null) return {};
  const lp = s.lp, ep = s.ep, row = s.row, cp = s.cp, live = !!s.pos_d, pnl = row ? s.banks.get(s.sel) : null;
  const snap = { entry: s.entry, stop: s.stop, first: s.first, target: s.target, max_loss: s.max_loss,
    depth: depthLabel(s.sel, s.depths, !!lp.held), position: s.pos_d,
    avg_in: live ? Math.round(s.avg_d * 1e4) / 1e4 : null,
    avg_out: live && !Number.isNaN(ep.avg_out) ? Math.round(ep.avg_out * 1e4) / 1e4 : null,
    if_stopped: row ? Math.round(-row.loss * 100) / 100 : null, pnl: (pnl !== null && pnl !== undefined) ? Math.round(pnl * 100) / 100 : null,
    in: Object.fromEntries(lp.levels.map((p, i) => [g(p), lp.lots[i]]).filter(x => x[1])),
    out: Object.fromEntries(ep.levels.map((p, i) => [g(p), ep.lots[i]]).filter(x => x[1])) };
  const marked = settleMarked(lp, _fnum(st.settle), s.sgn);
  if (marked !== null) Object.assign(snap, { settle: _fnum(st.settle), on_books: Math.round(marked * 100) / 100 });
  if (cp) Object.assign(snap, { out_by: s.out_by, avg_cut: cp.avg_cut !== null ? Math.round(cp.avg_cut * 1e4) / 1e4 : null,
    cut: Object.fromEntries(cp.levels.map((p, i) => [g(p), cp.lots[i]]).filter(x => x[1])) });
  return snap;
}
function listPlans() {
  return Object.values(store()).map(d => { const vs = d.versions || []; return { name: d.name, versions: vs.length, updated: vs.length ? vs[vs.length - 1].saved_at : (d.created || "") }; })
    .sort((a, b) => a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0);
}
function appendVersion(data, st, note) {
  const n = Math.max(data.last_n || 0, ...data.versions.map(v => v.n), 0) + 1;
  data.last_n = n;
  data.versions.push({ n, saved_at: nowIso(), note: (note || "").trim(), state: st, snapshot: planSnapshot(st) });
  const all = store(); all[slug(data.name)] = data; saveStore(all);
  return data;
}
const loadedOf = (data, v) => ({ plan: data.name, n: v.n, saved_at: v.saved_at, state: planNorm(v.state) });
const msg = text => { P.msg = { text, state: planState() }; };
function applyState(st) {
  for (const k of PLAN_KEYS) S[k] = (st[k] !== undefined) ? JSON.parse(JSON.stringify(st[k])) : S[k];
  syncInputs();
}
function renderPlanLists() {
  const plans = listPlans();
  $("tr-plan").innerHTML = plans.map(pl => `<label><input type="radio" name="tr-plan" value="${esc(pl.name)}"${P.plan === pl.name ? " checked" : ""}><span class="dash-options-list-option-text">${esc(pl.name)}\n${pl.versions} version${pl.versions !== 1 ? "s" : ""} · ${when(pl.updated)}</span></label>`).join("");
  $("tr-plan-empty").textContent = plans.length ? "" : "no saved plans yet — name one above";
  const data = P.plan ? store()[slug(P.plan)] : null, vs = data && data.versions ? data.versions : [];
  $("tr-plan-ver").innerHTML = vs.slice().reverse().map(v => {
    const snap = v.snapshot || {}, what = [];
    if (snap.position) what.push(`${num(snap.position)} lots` + (snap.avg_out ? `, out ${snap.avg_out.toFixed(3)}` : ""));
    if (v.note) what.push(v.note);
    const val = `${data.name}::${v.n}`;
    return `<label><input type="radio" name="tr-plan-ver" value="${esc(val)}"${P.ver === val ? " checked" : ""}><span class="dash-options-list-option-text">v${v.n} · ${when(v.saved_at)}\n${esc(what.join(" · ") || "—")}</span></label>`;
  }).join("");
  $("tr-plan-ver-empty").textContent = vs.length ? "" : "pick a plan to see its versions";
  // Delete label (plan_del_label)
  const del = $("tr-plan-del");
  if (!P.ver || !P.ver.includes("::")) { del.textContent = "Delete version"; del.disabled = true; del.className = "plan-btn sm danger"; del.title = ""; }
  else { const n = P.ver.split("::").pop();
    if (vs.length <= 1) { del.textContent = `Delete v${n}`; del.disabled = true; del.className = "plan-btn sm danger"; del.title = "its only version — archive the plan instead"; }
    else if (P.armed === P.ver) { del.textContent = `Confirm delete v${n}`; del.disabled = false; del.className = "plan-btn sm danger armed"; del.title = ""; }
    else { del.textContent = `Delete v${n}`; del.disabled = false; del.className = "plan-btn sm danger"; del.title = ""; } }
}
function planStatus() {
  const now = planState(), loaded = P.loaded, dirty = !!loaded && !same(now, loaded.state);
  const reset = $("tr-plan-reset");
  reset.textContent = loaded ? `Reset to v${loaded.n}` : "Reset"; reset.disabled = !dirty; $("tr-plan-save").disabled = !dirty;
  const el = $("tr-plan-status");
  if (P.msg && same(P.msg.state, now)) { el.innerHTML = `<span class="plan-msg">${esc(P.msg.text)}</span>`; return; }
  if (!loaded) { el.innerHTML = `<span class="plan-quiet">not saved — name it above and Save as new</span>`; return; }
  const w = when(loaded.saved_at);
  if (dirty) { el.innerHTML = `<span class="plan-dirty">● unsaved changes since v${loaded.n} (${esc(w)})</span>`; return; }
  const mk = ((loaded.state || {}).side || "buy") === "buy" ? "bid" : "ask";
  el.innerHTML = `<span class="plan-quiet">v${loaded.n} · saved ${esc(w)} · the ${mk} is as it was then</span>`;
}
function pickVersion(val) {                       // plan_load
  P.ver = val; P.armed = null;
  if (!val || !val.includes("::")) { renderPlanLists(); return; }
  const i = val.lastIndexOf("::"), name = val.slice(0, i), n = val.slice(i + 2);
  const data = store()[slug(name)], v = data ? data.versions.find(x => String(x.n) === n) : null;
  if (!v) { renderPlanLists(); return; }
  const st = planNorm(v.state);
  if (!(P.loaded && P.loaded.plan === data.name && P.loaded.n === v.n && same(P.loaded.state, st))) {
    applyState(st); P.loaded = loadedOf(data, v); P.msg = null;
  }
  renderPlanLists(); draw();
}
function pickPlan(name) {                         // plan_versions
  P.plan = name;
  const data = name ? store()[slug(name)] : null;
  pickVersion(data && data.versions.length ? `${data.name}::${data.versions[data.versions.length - 1].n}` : null);
}
$("tr-plan").addEventListener("change", e => { if (e.target.name === "tr-plan") pickPlan(e.target.value); });
$("tr-plan-ver").addEventListener("change", e => { if (e.target.name === "tr-plan-ver") pickVersion(e.target.value); });
function saveVersion() {                          // plan_save
  if (!P.plan) { msg("Pick a plan to save a version of, or name one and Save as new plan."); planStatus(); return; }
  const data = store()[slug(P.plan)];
  if (!data) { msg(`“${P.plan}” is no longer in plans/ — Save as new plan to keep this.`); renderPlanLists(); planStatus(); return; }
  const st = planState(); appendVersion(data, st, $("tr-plan-note").value || "");
  const v = data.versions[data.versions.length - 1];
  P.ver = `${data.name}::${v.n}`; P.loaded = loadedOf(data, v); P.msg = null; $("tr-plan-note").value = "";
  renderPlanLists(); planStatus();
}
$("tr-plan-save").addEventListener("click", saveVersion);
$("tr-plan-note").addEventListener("keydown", e => { if (e.key === "Enter" && P.loaded && !same(planState(), P.loaded.state)) saveVersion(); });
function saveNew() {                              // plan_save_new
  const name = ($("tr-plan-name").value || "").trim();
  if (!slug(name)) { msg("Type a name for the new plan first."); planStatus(); return; }
  if (store()[slug(name)]) { msg(`There is already a plan called “${name}”. Pick it and Save version, or choose another name.`); planStatus(); return; }
  const data = { name, page: "trade", created: nowIso(), versions: [] }, st = planState();
  appendVersion(data, st, $("tr-plan-note").value || "");
  const v = data.versions[data.versions.length - 1];
  P.plan = name; P.ver = `${name}::${v.n}`; P.loaded = loadedOf(data, v); P.msg = null;
  $("tr-plan-name").value = ""; $("tr-plan-note").value = "";
  renderPlanLists(); planStatus();
}
$("tr-plan-new").addEventListener("click", saveNew);
$("tr-plan-name").addEventListener("keydown", e => { if (e.key === "Enter") saveNew(); });
$("tr-plan-archive").addEventListener("click", () => {          // plan_archive
  if (!P.plan) { msg("No plan loaded to archive."); planStatus(); return; }
  const all = store(), key = slug(P.plan), data = all[key];
  if (data) { archiveAdd(`${key}-${nowIso().replace(/[-:T]/g, "")}`, data); delete all[key]; saveStore(all); }
  const name = P.plan; P.plan = null; P.ver = null; P.loaded = null;
  msg(`Archived “${name}” — kept in this browser's plan archive.`);
  renderPlanLists(); planStatus();
});
$("tr-plan-reset").addEventListener("click", () => {           // plan_reset
  const st = P.loaded && P.loaded.state; if (!st) return;
  applyState(st); P.msg = null; draw();
});
$("tr-plan-blank").addEventListener("click", () => {           // plan_blank
  applyState({ inst: S.inst, side: S.side, mark: null, entry: null, stop: null, first: null, target: null, loss: null, outby: null,
    settle: null, held: {}, sold: {}, excl_in: { off: [], on: [] }, excl_out: { off: [], on: [] }, depth: null,
    rungs: TRADE_WINDOW_TICKS, peak: null, shape: "off", peak_out: null, shape_out: "off" });
  P.plan = null; P.ver = null; P.loaded = null; P.msg = null; $("tr-plan-name").value = ""; $("tr-plan-note").value = "";
  renderPlanLists(); draw();
});
$("tr-plan-del").addEventListener("click", () => {             // plan_delete
  if (!P.ver || !P.ver.includes("::")) return;
  if (P.armed !== P.ver) { P.armed = P.ver; renderPlanLists(); return; }
  const i = P.ver.lastIndexOf("::"), name = P.ver.slice(0, i), n = parseInt(P.ver.slice(i + 2), 10);
  const all = store(), key = slug(name), data = all[key];
  P.armed = null;
  if (!data) { renderPlanLists(); return; }
  const keep = data.versions.filter(v => v.n !== n);
  if (keep.length === data.versions.length || !keep.length) { renderPlanLists(); return; }
  archiveAdd(`${key}-v${n}-${nowIso().replace(/[-:T]/g, "")}`, { name: data.name, deleted_at: nowIso(), version: data.versions.find(v => v.n === n) });
  data.last_n = Math.max(data.last_n || 0, ...data.versions.map(v => v.n));
  data.versions = keep; all[key] = data; saveStore(all);
  pickVersion(`${data.name}::${keep[keep.length - 1].n}`);
});

syncInputs(); renderPlanLists(); draw();
})();
