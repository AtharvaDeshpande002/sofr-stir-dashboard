# ═══════════════════════════════════════════════════════════════
#  SOFR Dashboard — LAN server + 1-minute history recorder
#  Serves C:\SOFR_dash_project over HTTP so teammates on the office
#  network can open the dashboard from their own browsers, and
#  appends a 1-min snapshot of the live feed to history\YYYY-MM-DD.jsonl.
#  Run via START_DASHBOARD_SERVER.bat (handles admin + firewall).
# ═══════════════════════════════════════════════════════════════
param(
    [int]$Port = 8080,
    [string]$Root = "C:\SOFR_dash_project"
)

$mime = @{
    ".html"="text/html; charset=utf-8"; ".json"="application/json; charset=utf-8"
    ".jsonl"="application/json; charset=utf-8"
    ".js"="text/javascript"; ".css"="text/css"; ".ico"="image/x-icon"
    ".png"="image/png"; ".svg"="image/svg+xml"; ".md"="text/plain; charset=utf-8"
}

$posDir  = Join-Path $Root "positions"
$histDir = Join-Path $Root "history"
foreach ($d in @($posDir,$histDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
try { $listener.Start() }
catch {
    Write-Host "FAILED to start on port $Port : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Run via START_DASHBOARD_SERVER.bat (needs admin once for the URL/firewall setup)." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"; exit 1
}

$ips = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" } |
       Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "  SOFR DASHBOARD SERVER RUNNING" -ForegroundColor Green
Write-Host "  Serving: $Root   |   Recording history: $histDir (1/min)"
Write-Host "  Team links (share one that works on your network):" -ForegroundColor Cyan
foreach ($ip in $ips) { Write-Host "    http://${ip}:$Port/SOFR_Dashboard.html" -ForegroundColor Cyan }
Write-Host ""
Write-Host "  Keep this window open. Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""

# ── request handler ─────────────────────────────────────────────
function Handle-Request($ctx) {
    $req  = $ctx.Request
    $resp = $ctx.Response
    try {
        $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart("/")
        if ($rel -eq "") { $rel = "SOFR_Dashboard.html" }

        # per-trader positions API (optional, unused by default)
        if ($rel -match '^pos/([A-Za-z0-9_\-]{1,32})$' -and $req.HttpMethod -eq "POST") {
            $name = $Matches[1].ToLower()
            $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
            $body = $reader.ReadToEnd(); $reader.Close()
            if ($body.Length -gt 0 -and $body.Length -lt 200000) {
                [System.IO.File]::WriteAllText((Join-Path $script:posDir "$name.json"), $body)
                $resp.StatusCode = 200
            } else { $resp.StatusCode = 400 }
            $resp.Close(); return
        }
        if ($rel -eq "pos/list") {
            $names = Get-ChildItem $script:posDir -Filter *.json -ErrorAction SilentlyContinue |
                     ForEach-Object { '"' + $_.BaseName + '"' }
            $out = [System.Text.Encoding]::UTF8.GetBytes("[" + ($names -join ",") + "]")
            $resp.ContentType = "application/json"
            $resp.Headers.Add("Cache-Control","no-store, max-age=0")
            $resp.ContentLength64 = $out.Length
            $resp.OutputStream.Write($out, 0, $out.Length)
            $resp.Close(); return
        }

        $path = Join-Path $script:Root $rel
        $full = [System.IO.Path]::GetFullPath($path)
        $ext  = [System.IO.Path]::GetExtension($full).ToLower()
        $blocked = @(".xlsm",".xlsx",".bas",".ps1",".bat")
        $histAllow = "STIR historical settle data feeds.xlsx"   # market settles only — needed by Correlation & Market Read
        $fname = [System.IO.Path]::GetFileName($full)
        $posAllow  = "Copy of Final Charts v2.xlsx"             # the trader's own positions (CURVE tab) — this PC only
        $isBlockedExt = ($blocked -contains $ext) -and ($fname -ine $histAllow) -and -not (($fname -ieq $posAllow) -and $req.IsLocal)
        $isPrivate = ($rel -like "pnl_history/*") -and -not $req.IsLocal          # the trader's own P&L log — this PC only
        if (-not $full.StartsWith($script:Root, [System.StringComparison]::OrdinalIgnoreCase) -or $isBlockedExt -or $isPrivate) {
            $resp.StatusCode = 403; $resp.Close(); return
        }

        if (Test-Path $full -PathType Leaf) {
            $bytes = $null
            for ($i=0; $i -lt 3; $i++) {   # retry: VBA may be mid-write on the json
                # shared read: a workbook open in Excel holds a write handle, which plain ReadAllBytes refuses
                try {
                    $fs = New-Object System.IO.FileStream($full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
                    try { $bytes = New-Object byte[] $fs.Length; $got = 0; while ($got -lt $bytes.Length) { $k = $fs.Read($bytes, $got, $bytes.Length - $got); if ($k -le 0) { break }; $got += $k } } finally { $fs.Close() }
                    break
                }
                catch { Start-Sleep -Milliseconds 30 }
            }
            if ($bytes) {
                $resp.ContentType = if ($script:mime.ContainsKey($ext)) { $script:mime[$ext] } else { "application/octet-stream" }
                $resp.Headers.Add("Cache-Control","no-store, max-age=0")
                $resp.Headers.Add("Access-Control-Allow-Origin","*")
                $resp.Headers.Add("Last-Modified", (Get-Item -LiteralPath $full).LastWriteTimeUtc.ToString("R"))   # e.g. when Excel last saved a workbook
                $resp.ContentLength64 = $bytes.Length
                $resp.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $resp.StatusCode = 503 }
        } else { $resp.StatusCode = 404 }
        $resp.Close()
    } catch { try { $resp.Close() } catch {} }
}

# ── history recorder: one snapshot per minute, only if feed advanced ──
$script:lastRecMin    = ""
$script:lastFeedStamp = ""
function Record-History {
    $nowMin = Get-Date -Format "yyyyMMddHHmm"
    if ($nowMin -eq $script:lastRecMin) { return }
    $script:lastRecMin = $nowMin
    $liveFile = Join-Path $script:Root "sofr_live.json"
    if (-not (Test-Path $liveFile)) { return }
    try {
        $j = Get-Content $liveFile -Raw | ConvertFrom-Json
        if (-not $j.spreads -or -not $j.timestamp) { return }
        if ($j.timestamp -eq $script:lastFeedStamp) { return }   # feed stalled — don't record stale data
        $script:lastFeedStamp = $j.timestamp
        $row = @{ t = (Get-Date -Format "HH:mm"); s = $j.spreads; o = $j.outrights } | ConvertTo-Json -Compress
        Add-Content -Path (Join-Path $script:histDir ((Get-Date -Format "yyyy-MM-dd") + ".jsonl")) -Value $row -Encoding UTF8
    } catch { }
}

# ── settle history from the desk's markets database (shared drive): every 10 min, if the share has
#    published a new day (LATEST.txt changed), run db_export.py in the background -> db\*.json ──
$script:lastDbCheck = [DateTime]::MinValue
$script:dbShare = "<MARKETS_DB_DIR>\LATEST.txt"
function Check-Db {
    if (((Get-Date) - $script:lastDbCheck).TotalMinutes -lt 10) { return }
    $script:lastDbCheck = Get-Date
    try {
        $latest = (Get-Content -LiteralPath $script:dbShare -ErrorAction Stop | Select-Object -First 1).Trim()
        $metaP = Join-Path $script:Root "db\meta.json"
        $have = if (Test-Path $metaP) { (Get-Content $metaP -Raw | ConvertFrom-Json).db } else { "" }
        if ($latest -and $latest -ne $have) {
            Start-Process python -ArgumentList "`"$(Join-Path $script:Root 'db_export.py')`"" -WorkingDirectory $script:Root -WindowStyle Hidden
            Write-Host "  [$(Get-Date -Format HH:mm)] new markets database $latest -> exporting settle history" -ForegroundColor Cyan
        }
    } catch { }
}

# ── main loop: serve requests, tick the recorder once a second ──
$ctxTask = $listener.GetContextAsync()
while ($listener.IsListening) {
    try {
        if ($ctxTask.Wait(1000)) {
            $ctx = $ctxTask.Result
            $ctxTask = $listener.GetContextAsync()
            Handle-Request $ctx
        }
        Record-History
        Check-Db
    } catch { Start-Sleep -Milliseconds 200 }
}
