"""Live feed: read the OPEN Excel workbook "Copy of Final Charts v2.xlsx" (TT RTD values, no saving needed)
and write sofr_live.json for the dashboard every second. Replaces the COD.xlsm VBA feed (SOFR_LiveFeed.bas).

Run:  python live_feed.py          (START_DASHBOARD_SERVER.bat starts it; only one copy runs at a time)

Excel must run as the same Windows user and NOT as administrator-vs-not mismatched: an elevated process
cannot see a normal Excel window, so the launcher starts this script un-elevated.

What it reads (sheet › cells):
  Calc_SR3     D:name  K:live ("Tilt", size-weighted bid/ask)  L:TT settle  — outrights rows 5-29, 3M spreads
               rows 31+, every other structure by name; the front contract (U6) and its spread from rows 370-371
               (added by hand, see LIVE_FEED_SETUP.txt)
  Calc_ZQSR1   D45:D56 meeting, H live bp, I settle bp
  Vix          AF5:AF12 contract, AJ live, AK settle
  SR3 Posn     C/D strategy + quantity; F contract + per-structure columns (AX 12M fly, BC 6M fly, BH 3M fly,
               BL 12M spread, BP 6M spread, BT 3M spread, BY net outright, BZ TT NetPos)
  Calc_SR3 G   the settle the sheet's COD uses (what SR3 Charts shows): sent as the dashboard's "open" reference
  Calc_ZQSR1   D5:I30 ZQ outrights (H live, I settle)
  PnL          C3 total, K2 SR3, S2 meetings, AA2 SR1-ZQ; ZQ trades M4:S23, SR1-ZQ trades U4:AA23
OI and treasuries are NOT fed live: the dashboard reads them from "STIR historical settle data feeds.xlsx".
"""
import datetime as dt, json, os, re, socket, sys, time

import pythoncom
import win32com.client

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sofr_live.json")
CFG = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))
SRC = CFG.get("source_workbook", "Copy of Final Charts v2.xlsx")
INTERVAL = max(1.0, float(CFG.get("interval_sec", 1)))


def contracts_from_dashboard():
    """the dashboard's own CONTRACTS list, so the arrays line up with it exactly"""
    html = open(os.path.join(HERE, "SOFR_Dashboard.html"), encoding="utf-8").read()
    m = re.search(r"const CONTRACTS\s*=\s*\[([^\]]+)\]", html)
    return re.findall(r'"([HMUZ]\d)"', m.group(1))


CONTRACTS = contracts_from_dashboard()


def num(v):
    """Excel value -> float or None (COM returns cell errors such as #N/A as large negative ints)"""
    if isinstance(v, bool) or v is None: return None
    if isinstance(v, (int, float)):
        if abs(v) > 1e8: return None
        return float(v)
    return None


def text(v):
    if isinstance(v, str): return v.strip()
    if v is None or (isinstance(v, int) and abs(v) > 1e8): return ""      # empty, or a cell error (#N/A ...)
    return str(v)


def rng(wb, sheet, addr):
    v = wb.Worksheets(sheet).Range(addr).Value
    if not isinstance(v, tuple): return ((v,),)
    return v


def find_wb(xl, name):
    for wb in xl.Workbooks:
        if wb.Name.lower() == name.lower(): return wb
    return None


def read_calc_sr3(wb):
    """name -> (live, TT settle, reference settle) for every structure in Calc_SR3:
    D name, K live ("Tilt"), L TT settle, G = the settle the sheet's COD uses (OFFSET by G2; what SR3 Charts shows).
    Includes the hand-added front-contract rows 370-371."""
    out = {}
    for addr in ("D4:L367", "D370:L380"):
        for row in rng(wb, "Calc_SR3", addr):
            name = text(row[0])
            if not name or name.startswith("#"): continue
            live, stl, ref = num(row[7]), num(row[8]), num(row[3])     # D=0 ... G=3, K=7, L=8
            if ref is None and addr.startswith("D370"): ref = stl          # extra rows have no G column
            if live is not None or stl is not None: out[name] = (live, stl, ref)
    return out


def build_curve(calc):
    """arrays aligned to the dashboard's CONTRACTS: live / TT settle / reference settle, outrights and 3M spreads"""
    outr = [(calc.get(c) or (None, None, None)) for c in CONTRACTS]
    O = [[o[k] for o in outr] for k in range(3)]                      # live, TT settle, reference settle
    S = [[], [], []]
    for i in range(len(CONTRACTS) - 1):
        s = calc.get(CONTRACTS[i] + "1S") or (None, None, None)
        for k in range(3):
            v = s[k]
            a, b = O[k][i], O[k][i + 1]
            if v is None and a is not None and b is not None: v = round(100 * (a - b), 4)   # from the outrights
            S[k].append(v)
    while S[0] and S[0][-1] is None and S[1][-1] is None:          # trim contracts the sheet does not list
        for k in range(3): S[k].pop()
    while O[0] and O[0][-1] is None and O[1][-1] is None:
        for k in range(3): O[k].pop()
    return O, S


def read_zq(wb):
    """ZQ outrights (Calc_ZQSR1 rows 5-30: D name, H live, I settle)"""
    out = []
    for row in rng(wb, "Calc_ZQSR1", "D5:I30"):
        name = text(row[0])
        if re.match(r"^ZQ[FGHJKMNQUVXZ]\d$", name): out.append({"c": name, "live": num(row[4]), "settle": num(row[5])})
    return out


def read_zq_trades(wb):
    """ZQ and SR1-ZQ lines from the PnL sheet: Meets block M:S (N qty, O trade, Q settle, R live, S P&L),
    SR1-ZQ block U:AA (V qty, W trade, Y settle, Z live, AA P&L)"""
    def block(addr):
        out = []
        for r in rng(wb, "PnL", addr):
            q, name = num(r[1]), text(r[2])
            if q and name and name != "-": out.append({"trade": name, "qty": q, "settle": num(r[4]), "live": num(r[5]), "pnl": num(r[6])})
        return out
    return block("M4:S23"), block("U4:AA23")


def read_meetings(wb):
    out = []
    for row in rng(wb, "Calc_ZQSR1", "D45:J56"):
        label = text(row[0])
        if not re.match(r"^[A-Z][a-z]{2}'\d{2}$", label): continue          # "Oct'26"
        out.append({"meet": label, "live": num(row[4]), "settle": num(row[5])})   # D=0,E,F,G,H=4,I=5
    return out


def read_vx(wb):
    pos = {}
    try:
        for row in rng(wb, "Vix Posn", "C5:F16"):                               # C contract ... F TT
            if text(row[0]): pos[text(row[0])] = num(row[3]) or 0
    except Exception:
        pass
    out = []
    for row in rng(wb, "Vix", "AF5:AK16"):
        name = text(row[0])
        if not re.match(r"^VX [A-Z][a-z]{2}\d{2}$", name): continue
        out.append({"c": name, "px": num(row[4]), "stl": num(row[5]), "pos": pos.get(name, 0)})   # AF=0 ... AJ=4, AK=5
    return out


def read_positions(wb):
    rows = rng(wb, "SR3 Posn", "C4:CA40")                 # C=0, D=1, F=3, AX=47, BC=52, BH=57, BL=61, BP=65, BT=69, BY=74, BZ=75
    col = lambda L: sum((ord(ch) - 64) * 26 ** k for k, ch in enumerate(reversed(L))) - 3
    # 3M spread and 3M fly bars show the WHOLE BOOK decomposed (the sheet's own maths):
    #   positions     = BX  (every structure broken into 3M spreads)
    #   fly_positions = AC + AT + BH  (3M-fly legs of 1E, of 3M double flies, plus direct 3M flies)
    # the direct holdings stay available as pos_3m_direct (BT) / pos_3mfly_direct (BH); other families unchanged.
    fam = {"pos_12mfly": "AX", "pos_6mfly": "BC", "pos_12m": "BL", "pos_6m": "BP", "positions": "BX",
           "pos_3m_direct": "BT", "pos_3mfly_direct": "BH", "pos_net": "BY", "pos_tt": "BZ",
           "_fly_1e": "AC", "_fly_1d": "AT"}
    arrays = {k: [0] * len(CONTRACTS) for k in fam}
    strategies = []
    for r in rows:
        code, q = text(r[0]), num(r[1])
        if code and q: strategies.append({"code": code, "qty": q})
        c = text(r[3])
        if c in CONTRACTS:
            i = CONTRACTS.index(c)
            for k, L in fam.items():
                v = num(r[col(L)])
                if v is not None: arrays[k][i] = v
    arrays["fly_positions"] = [a + b + c for a, b, c in zip(arrays.pop("_fly_1e"), arrays.pop("_fly_1d"), arrays["pos_3mfly_direct"])]
    return arrays, strategies


def read_sr3_trades(wb):
    """SR3 lines of the PnL sheet E4:K23: F qty, G trade, I settle, J live ("Tilt"), K P&L vs settle"""
    out = []
    for r in rng(wb, "PnL", "E4:K23"):
        q, name = num(r[1]), text(r[2])
        if q and name and name != "-": out.append({"trade": name, "qty": q, "settle": num(r[4]), "live": num(r[5]), "pnl": num(r[6])})
    return out


PNL_DIR = os.path.join(HERE, "pnl_history")
_pnl_last = [0.0]


def record_pnl(pnl, sr3, zq, sr1zq):
    """one line per 15s: today's P&L by book and by line -> pnl_history/YYYY-MM-DD.jsonl (local only, see server)"""
    if time.time() - _pnl_last[0] < 15 or not pnl or pnl.get("total") is None: return
    _pnl_last[0] = time.time()
    os.makedirs(PNL_DIR, exist_ok=True)
    lines = {}
    for book, rows in (("SR3", sr3), ("ZQ", zq), ("SR1ZQ", sr1zq)):
        for t in rows:
            if t.get("pnl") is not None: lines[f"{book}|{t['trade']}"] = round(t["pnl"], 1)
    rec = {"t": dt.datetime.now().strftime("%H:%M:%S"), **{k: (round(v, 1) if isinstance(v, float) else v) for k, v in pnl.items()}, "lines": lines}
    with open(os.path.join(PNL_DIR, dt.date.today().isoformat() + ".jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def read_pnl(wb):
    g = lambda a: num(wb.Worksheets("PnL").Range(a).Value)
    return {"total": g("C3"), "sr3": g("K2"), "meets": g("S2"), "sr1zq": g("AA2")}


def write_json(obj):
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(obj, f, separators=(",", ":"))
    for _ in range(10):
        try:
            os.replace(tmp, OUT); return
        except PermissionError:
            time.sleep(0.05)


def r4(a): return [None if v is None else round(v, 4) for v in a]


def find_src(xl):
    """the source workbook: exact name first, else any open copy of it ("Copy of Final Charts v2 (2).xlsx", ...)"""
    wb = find_wb(xl, SRC)
    if wb is not None: return wb
    base = os.path.splitext(SRC)[0].lower()
    for w in xl.Workbooks:
        if w.Name.lower().startswith(base): return w
    return None


_last_src = [None]


def tick(xl, out_path=None):
    wb = find_src(xl)
    if wb is None: return f"'{SRC}' (or a copy of it) is not open in Excel"
    if wb.Name != _last_src[0]:
        print(f"  [{dt.datetime.now():%H:%M:%S}] reading '{wb.Name}'"); _last_src[0] = wb.Name
    calc = read_calc_sr3(wb)
    (outrights, s_out, ref_out), (spreads, s_spr, ref_spr) = build_curve(calc)
    if not any(v is not None for v in spreads): return "no live spreads yet (TT not connected?)"
    meets = read_meetings(wb)
    pos, strategies = read_positions(wb)
    zq_trades, sr1zq_trades = read_zq_trades(wb)
    sr3_trades = read_sr3_trades(wb)
    pnl = read_pnl(wb)
    if out_path is None: record_pnl(pnl, sr3_trades, zq_trades, sr1zq_trades)
    data = {
        "timestamp": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": wb.Name, "trader": CFG.get("trader_name", ""), "tick_value": CFG.get("tick_value", 25),
        "contracts": CONTRACTS[:len(outrights)],
        "spreads": r4(spreads), "outrights": r4(outrights),
        "settle_spreads": r4(s_spr), "settle_outrights": r4(s_out),
        # the dashboard's "open" reference = the settle Calc_SR3 column G / SR3 Charts uses (the trader's COD basis)
        "session_open": r4(ref_spr), "open_outrights": r4(ref_out), "session_open_time": "SETTLE",
        **pos, "sr3_strategies": strategies,
        "sr3_settles": {k: v[1] for k, v in calc.items() if v[1] is not None},
        "meetings": meets, "meeting_pricing": [m["live"] for m in meets],
        "zq": read_zq(wb), "zq_trades": zq_trades, "sr1zq_trades": sr1zq_trades, "sr3_trades": sr3_trades,
        "vx": read_vx(wb), "pnl": pnl,
        # OI and treasuries are not fed live: the dashboard reads them from "STIR historical settle data feeds.xlsx"
        "oi_date": "", "oi": [], "flow": [], "treasuries": {},
    }
    if out_path:
        json.dump(data, open(out_path, "w", encoding="utf-8"), indent=1)
    else:
        write_json(data)
    return None


def main():
    if "--once" in sys.argv:                                # test: one read to the given path, nothing else touched
        pythoncom.CoInitialize()
        out = sys.argv[sys.argv.index("--once") + 1]
        for _ in range(20):                                   # Excel rejects calls while a cell is being edited
            try:
                print(tick(win32com.client.GetActiveObject("Excel.Application"), out) or f"wrote {out}"); return
            except Exception as e:
                last = e; time.sleep(0.5)
        print("failed:", last); return
    import ctypes
    if ctypes.windll.shell32.IsUserAnAdmin():
        # an elevated process cannot see a normal Excel window: it would wait forever and block the real feed
        print("live_feed.py was started as ADMINISTRATOR and cannot see your Excel. Not starting.\n"
              "Double-click START_LIVE_FEED.bat (or run START_DASHBOARD_SERVER.bat normally) instead.")
        time.sleep(8); return
    lock = socket.socket()
    try:
        lock.bind(("127.0.0.1", 8098))                       # one feeder at a time
    except OSError:
        print("live_feed.py is already running."); time.sleep(5); return
    pythoncom.CoInitialize()
    print(f"SOFR live feed: reading '{SRC}' from the running Excel -> {OUT} every {INTERVAL:g}s. Ctrl+C to stop.")
    xl, last_msg, last_print, n = None, None, 0, 0
    while True:
        t0 = time.time()
        try:
            if xl is None: xl = win32com.client.GetActiveObject("Excel.Application")
            msg = tick(xl)
            if msg is None:
                n += 1
                if n % 60 == 1: print(f"  [{dt.datetime.now():%H:%M:%S}] live ({n} writes)")
        except Exception as e:
            xl = None if "GetActiveObject" in repr(e) or "Operation unavailable" in str(e) else xl
            code = getattr(e, "hresult", None) or (e.args[0] if getattr(e, "args", None) else None)
            msg = "Excel busy, retrying" if code in (-2147418111, -2147417846) else f"waiting for Excel ({e})"
            if "MK_E_UNAVAILABLE" in str(e) or code == -2147221021: xl, msg = None, "Excel is not running (or runs as administrator)"
        if msg and (msg != last_msg or time.time() - last_print > 60):
            print(f"  [{dt.datetime.now():%H:%M:%S}] {msg}"); last_msg, last_print = msg, time.time()
        if msg is None: last_msg = None
        time.sleep(max(0.1, INTERVAL - (time.time() - t0)))


if __name__ == "__main__":
    main()
