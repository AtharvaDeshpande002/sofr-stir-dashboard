"""Export settle history from the desk's STIR markets database (SQLite on the shared drive) to small JSON
files the dashboard can fetch. Read-only: the database is opened with mode=ro&immutable=1 and nothing
is written next to it.

  python db_export.py            -> db/vx.json, db/sr3.json, db/meta.json  (skips if LATEST.txt is unchanged)
  python db_export.py --force    -> always rebuild

serve_dashboard.ps1 runs this when the share publishes a new database (after the 12:30 IST Bloomberg run).

Shapes (dates are ISO strings, newest first):
  vx.json : {asof, dates:[...], contracts:[{code:"UXV26", month:"2026-10", last:"2026-10-21"}],
             settles:{code:[[dateIdx, value], ...]}, spot:{"VIX Index":[[dateIdx, value], ...], ...}}
  sr3.json: same layout for SR3 (codes like "SFRZ26"), contract month and last trade date.
"""
import json, os, pathlib, sqlite3, sys, datetime as dt

SHARE = pathlib.Path(r"<MARKETS_DB_DIR>")
URI = "file:///<MARKETS_DB_DIR>/{name}?mode=ro&immutable=1"
HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "db"


def export_market(c, like, strip):
    rows = c.execute(
        "SELECT t.ticker, t.contract, t.last_trade, s.session, s.value FROM settles s JOIN tickers t ON t.id = s.id "
        "WHERE t.ticker LIKE ? AND t.kind = 'future' ORDER BY s.session", (like,)).fetchall()
    dates = sorted({r[3] for r in rows}, reverse=True)
    di = {d: i for i, d in enumerate(dates)}
    contracts, settles = {}, {}
    for tk, month, last, sess, v in rows:
        code = tk.replace(strip, "").strip()
        contracts[code] = {"code": code, "month": month, "last": last}
        settles.setdefault(code, []).append([di[sess], round(v, 6)])
    for code in settles: settles[code].sort()
    return {"dates": dates, "contracts": sorted(contracts.values(), key=lambda x: x["month"] or ""), "settles": settles}


def export_econ(c):
    """US releases: one event per reference period, keyed by its release date (eco_release_dt).
    econ.json: {asof, series:[{ticker, name, events:[{period, release, actual, survey, lo, hi, n, rev}]}]} (oldest first)"""
    names = dict(c.execute("SELECT ticker, description FROM tickers WHERE kind='econ'").fetchall())
    names.setdefault("AHE MOM% Index", "US Avg Hourly Earnings MoM")
    tickers = [t for t, d in names.items() if (d or "").startswith("US ")] + ["AHE MOM% Index"]
    fmap = {"actual_release": "actual", "bn_survey_median": "survey", "bn_survey_low": "lo", "bn_survey_high": "hi",
            "bn_survey_number_observations": "n", "first_revision": "rev"}
    series = []
    for t in sorted(set(tickers)):
        rows = c.execute("SELECT date, field, value, text FROM econ WHERE ticker = ? ORDER BY date", (t,)).fetchall()
        per = {}
        for d, f, v, tx in rows:
            e = per.setdefault(d, {"period": d})
            if f == "eco_release_dt" and tx: e["release"] = tx[:10]
            elif f in fmap and v is not None: e[fmap[f]] = round(v, 4)
        ev = [e for e in per.values() if e.get("release")]           # rows keyed by the release day itself are duplicates
        ev.sort(key=lambda e: e["release"])
        if ev: series.append({"ticker": t, "name": names.get(t) or t, "events": ev})
    return {"asof": dt.date.today().isoformat(), "series": series}


def main():
    force = "--force" in sys.argv
    name = (SHARE / "LATEST.txt").read_text().strip()
    OUT.mkdir(exist_ok=True)
    meta_p = OUT / "meta.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
    if not force and meta.get("db") == name:
        print("up to date:", name); return
    c = sqlite3.connect(URI.format(name=name.replace(" ", "%20")), uri=True)
    about = dict(c.execute("SELECT key, value FROM about").fetchall())

    vx = export_market(c, "UX___ Index", " Index")
    di = {d: i for i, d in enumerate(vx["dates"])}
    spot = {}
    for tk in ("VIX Index", "VIX9D Index", "VIX3M Index", "VVIX Index"):
        pts = c.execute("SELECT session, value FROM daily_v WHERE ticker = ? AND field = 'last' ORDER BY session", (tk,)).fetchall()
        spot[tk] = sorted([di[s], round(v, 4)] for s, v in pts if s in di)
    vx["spot"] = spot
    vx["asof"] = vx["dates"][0]

    sr3 = export_market(c, "SFR___ Comdty", " Comdty")
    sr3["asof"] = sr3["dates"][0]

    econ = export_econ(c)

    for fn, obj in (("vx.json", vx), ("sr3.json", sr3), ("econ.json", econ)):
        tmp = OUT / (fn + ".tmp")
        tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, OUT / fn)
    meta = {"db": name, "settles_through": about.get("settles through"), "built": about.get("built"),
            "exported": dt.datetime.now().isoformat(timespec="seconds"),
            "vx_contracts": len(vx["contracts"]), "sr3_contracts": len(sr3["contracts"])}
    meta_p.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print("exported", meta)


if __name__ == "__main__":
    main()
