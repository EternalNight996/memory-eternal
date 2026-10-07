# MANUAL end-to-end check (NOT part of `npm test`) for v0.10.5's host-independent config save.
# Runs a REAL standalone `dsh-memory serve` process on a temp DSH_HOME (i.e. the Codex / no-DSH
# situation) and verifies both branches:
#   A) no live DSH host  -> POST /config writes the shared config directly (applied-direct)
#   B) live host marker  -> POST /config only writes the pending file (queued), never the shared file
# ASCII only: Windows PowerShell 5.1 reads .ps1 as GBK unless it has a UTF-8 BOM.
$ErrorActionPreference = 'Continue'
$root = 'E:\Desktop\myapp\memory-eternal'
$tmp = Join-Path $env:TEMP ('me-e2e-hostless-' + (Get-Random))
$vault = Join-Path $tmp 'vault'
$env:DSH_HOME = Join-Path $tmp 'dsh'
New-Item -ItemType Directory -Force -Path $vault, $env:DSH_HOME | Out-Null
$port = 8009
$shared = Join-Path $env:DSH_HOME 'memory-eternal-config.json'
$pending = Join-Path $env:DSH_HOME 'memory-eternal-config.pending.json'
$marker = Join-Path $env:DSH_HOME 'memory-eternal-config.host.json'
$srv = $null

function PortFree([int]$p) { try { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Out-Null; $false } catch { $true } }
function Save([int]$days) {
  $body = '{"patch":{"recycleRetentionDays":' + $days + '}}'
  try { return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/memory-eternal/api/config" -ContentType 'application/json' -Body $body -TimeoutSec 30 }
  catch { return @{ error = $_.Exception.Message } }
}
function SharedDays { if (Test-Path $shared) { (Get-Content $shared -Raw | ConvertFrom-Json).recycleRetentionDays } else { '(no file)' } }

try {
  if (-not (PortFree $port)) { "port $port busy, aborting"; exit 1 }
  $srv = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("$root\bin\dsh-memory.mjs", 'serve', '--port', "$port", '--vault', $vault) -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-RestMethod "http://127.0.0.1:$port/memory-eternal/api/overview" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 400 }
  }
  "TMP=$tmp  DSH_HOME=$env:DSH_HOME  server pid=$($srv.Id)"
  "shared file before: recycleRetentionDays = $(SharedDays)"

  '---------- A: no DSH host (the Codex case) ----------'
  "host marker exists? $(Test-Path $marker)   (expect False)"
  $r1 = Save 28
  "A1) pendingOutcome=$($r1.pendingOutcome) appliedDirect=$($r1.appliedDirect) pending=[$($r1.pending -join ',')]"
  "A2) note=$($r1.note)"
  "A3) shared file now: recycleRetentionDays = $(SharedDays)   (expect 28)"
  "A4) pending file removed? $(-not (Test-Path $pending))   (expect True)"

  '---------- B: a live host is present ----------'
  # A marker written with THIS PowerShell process id counts as a live host (kill(pid,0) succeeds)
  $markerJson = '{"pid":' + $PID + ',"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"version":"fake-host"}'
  [System.IO.File]::WriteAllText($marker, $markerJson, (New-Object System.Text.UTF8Encoding($false)))
  "B1) host marker written with a live pid ($PID)"
  $r2 = Save 7
  "B2) pendingOutcome=$($r2.pendingOutcome) appliedDirect=$($r2.appliedDirect)   (expect queued / False)"
  "B3) shared file still: recycleRetentionDays = $(SharedDays)   (expect 28 -- NOT overwritten to 7)"
  "B4) pending file exists? $(Test-Path $pending)   (expect True -- the change waits for the host)"
} finally {
  '---------- cleanup ----------'
  if ($srv) { try { Stop-Process -Id $srv.Id -Force -ErrorAction Stop } catch { } }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (PortFree $port) { "port $port released OK" } else { "port $port STILL BUSY" }
}
