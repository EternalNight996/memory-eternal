# MANUAL end-to-end check (NOT part of `npm test`): real processes, real ports, for issue #23's
# "port-occupant fallback + never kill a foreign process" behaviour.
# Everything runs on a temp DSH_HOME / temp vault and ports 7996/7997 -- the user's resident
# instance on 7999 is never touched. ASCII only: Windows PowerShell 5.1 reads .ps1 as GBK
# unless the file has a UTF-8 BOM, and non-ASCII text breaks its parser.
$ErrorActionPreference = 'Continue'
$root = 'E:\Desktop\myapp\memory-eternal'
$tmp = Join-Path $env:TEMP ('me-e2e23-' + (Get-Random))
$vault = Join-Path $tmp 'vault'
$env:DSH_HOME = Join-Path $tmp 'dsh'
New-Item -ItemType Directory -Force -Path $vault, $env:DSH_HOME, (Join-Path $tmp 'foreign') | Out-Null

$pOurs = 7997      # this plugin's web, started by hand => "an old web the lock never registered"
$pForeign = 7996   # a foreign process whose file happens to be named web.js (old predicate would kill it)
$dummy = @()

function PortFree([int]$p) { try { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Out-Null; $false } catch { $true } }
function Invoke-MemCli([string[]]$a) { node "$root\bin\dsh-memory.mjs" @a 2>&1; "  exit=$LASTEXITCODE" }

$foreignJs = Join-Path $tmp 'foreign\web.js'
$foreignSrc = @'
const http = require('http')
http.createServer((q, s) => s.end('foreign')).listen(Number(process.argv[2]), '127.0.0.1')
'@
[System.IO.File]::WriteAllText($foreignJs, $foreignSrc, (New-Object System.Text.UTF8Encoding($false)))
$node = (Get-Command node).Source

try {
  if (-not (PortFree $pOurs) -or -not (PortFree $pForeign)) { 'ports busy, aborting'; exit 1 }

  '---------- A: a web on the port that the lock never registered ----------'
  $w = Start-Process -FilePath $node -ArgumentList @("$root\lib\web.js", '--port', "$pOurs", '--vault', $vault) -PassThru -WindowStyle Hidden
  $dummy += $w.Id
  Start-Sleep -Seconds 2
  $lockRaw = Get-Content (Join-Path $env:DSH_HOME 'memory-eternal-watchdog.json') -Raw -ErrorAction SilentlyContinue
  if (-not $lockRaw) { $lockRaw = '(no lock file)' }
  "A0) lock file (expect no watchdog entry): $lockRaw"
  'A1) status must still report the version actually served on the port:'
  Invoke-MemCli @('status', '--port', "$pOurs")

  'A2) restart must reap that unregistered web by port occupant, then start + self-check:'
  Invoke-MemCli @('restart', '--port', "$pOurs", '--vault', $vault, '--interval', '2000')
  Start-Sleep -Seconds 1
  $ov = Invoke-RestMethod "http://127.0.0.1:$pOurs/memory-eternal/api/overview"
  "A3) after restart the port serves v$($ov.version)"

  'A4) POST /config (envelope is {patch:{...}}) -> pendingOutcome:'
  try {
    $cfg = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$pOurs/memory-eternal/api/config" -ContentType 'application/json' -Body '{"patch":{"captureMaxTokens":2600}}'
    "  ok=$($cfg.ok) pendingOutcome=$($cfg.pendingOutcome) applied=$($cfg.applied -join ',')"
    "  note=$($cfg.note)"
  } catch { "  POST failed: $($_.Exception.Message)" }

  '---------- B: a foreign web.js holds the port -- warn only, never kill ----------'
  $f = Start-Process -FilePath $node -ArgumentList @($foreignJs, "$pForeign") -PassThru -WindowStyle Hidden
  $dummy += $f.Id
  Start-Sleep -Seconds 2
  $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($f.Id)").CommandLine
  "B1) foreign cmdline = $cmdline"
  $judge = node -e "import('file:///E:/Desktop/myapp/memory-eternal/lib/watchdog.js').then(m=>console.log(m.looksLikeOurWeb(process.argv[1])))" $cmdline
  "B2) looksLikeOurWeb(foreign cmdline) = $judge   <- expect false (old predicate: true, because it contains web.js)"
  'B3) restart on that port must abort without killing it:'
  Invoke-MemCli @('restart', '--port', "$pForeign", '--vault', $vault)
  Start-Sleep -Seconds 1
  $still = Get-Process -Id $f.Id -ErrorAction SilentlyContinue
  if ($still) { "B4) foreign process is still alive OK (pid $($f.Id))" } else { "B4) FAIL: the foreign process was killed" }
} finally {
  '---------- cleanup ----------'
  Invoke-MemCli @('stop', '--port', "$pOurs")
  foreach ($procId in $dummy) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { } }
  Start-Sleep -Seconds 1
  if (PortFree $pOurs) { "port $pOurs released OK" } else { "port $pOurs STILL BUSY" }
  if (PortFree $pForeign) { "port $pForeign released OK" } else { "port $pForeign STILL BUSY" }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
