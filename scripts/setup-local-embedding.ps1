# 本地语义召回服务（Ollama）离线安装/配置助手
#
# 背景：很多内网机器无法直连 ollama.com / registry.ollama.ai。本脚本不负责联网下载，
# 而是把「已经拷进来的安装包 / 模型」装好、配好 7997 端口，并验证 OpenAI 兼容端点。
#
# 用法：
#   # A. 只装了安装包（模型还要联网 pull）
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-embedding.ps1 -OllamaSetup D:\OllamaSetup.exe
#
#   # B. 离线：把另一台机器上 %USERPROFILE%\.ollama\models 整个目录拷过来
#   powershell ... -OllamaSetup D:\OllamaSetup.exe -ModelsFrom D:\ollama-models
#
#   # C. 离线：用 GGUF 文件创建模型（模型名默认 bge-m3）
#   powershell ... -Gguf D:\bge-m3.Q4_K_M.gguf
#
# 做完后到「设置 → 记忆 → 语义召回（可选）」点「检测连接 → 一键配置并建缓存」。
param(
  [string]$OllamaSetup,
  [string]$ModelsFrom,
  [string]$Gguf,
  [string]$Model = 'bge-m3',
  [int]$Port = 7997
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "[ollama-setup] $m" }

# 1) 安装
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $exe)) {
  if (-not $OllamaSetup) {
    Write-Host "未检测到 Ollama，也没有传 -OllamaSetup。请在有网的机器下载 https://ollama.com/download/OllamaSetup.exe 后拷过来再运行。" -ForegroundColor Yellow
    exit 2
  }
  if (-not (Test-Path $OllamaSetup)) { throw "找不到安装包：$OllamaSetup" }
  Info "安装 Ollama：$OllamaSetup"
  Start-Process -FilePath $OllamaSetup -ArgumentList '/S' -Wait
  if (-not (Test-Path $exe)) { throw '安装后仍未找到 ollama.exe，请手动确认安装位置' }
}

# 2) 端口固定到 7997（写用户环境变量，后续终端生效）
[Environment]::SetEnvironmentVariable('OLLAMA_HOST', "127.0.0.1:$Port", 'User')
$env:OLLAMA_HOST = "127.0.0.1:$Port"
Info "OLLAMA_HOST=127.0.0.1:$Port（已写入用户环境变量）"

# 3) 离线模型目录（可选）：直接覆盖到本机 Ollama models
if ($ModelsFrom) {
  if (-not (Test-Path $ModelsFrom)) { throw "找不到模型目录：$ModelsFrom" }
  $dst = Join-Path $env:USERPROFILE '.ollama\models'
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  Info "复制模型目录 → $dst（可能较慢，约 1–2GB）"
  Copy-Item (Join-Path $ModelsFrom '*') $dst -Recurse -Force
}

# 4) 启动服务（若端口没在监听）
function Test-Port($p) { try { (Test-NetConnection -ComputerName 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $false } }
if (-not (Test-Port $Port)) {
  Info '启动 ollama serve（后台）'
  Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Test-Port $Port); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Port $Port)) { throw "服务没有在 $Port 上起来；检查 OLLAMA_HOST 是否被其它进程占用" }
}

# 5) 模型：GGUF 导入 > 已拷贝 > pull（需要外网）
if ($Gguf) {
  if (-not (Test-Path $Gguf)) { throw "找不到 GGUF：$Gguf" }
  $mf = Join-Path $env:TEMP 'Modelfile.bge'
  "FROM $Gguf" | Set-Content -Path $mf -Encoding ASCII
  Info "从 GGUF 创建模型 $Model"
  & $exe create $Model -f $mf
} else {
  $has = $false
  try {
    $tags = (curl.exe -s --max-time 5 "http://127.0.0.1:$Port/api/tags") | ConvertFrom-Json
    $has = @($tags.models | ForEach-Object { $_.name }) -contains $Model
  } catch { $has = $false }
  if (-not $has) {
    Info "本机没有模型 $Model，尝试 ollama pull（需要联网；离线请用 -ModelsFrom 或 -Gguf）"
    & $exe pull $Model
  }
}

# 6) 验证 OpenAI 兼容端点
$probe = curl.exe -s --max-time 8 "http://127.0.0.1:$Port/v1/models"
Info "GET /v1/models => $probe"
$payload = '{"model":"' + $Model + '","input":"测试"}'
$embed = curl.exe -s --max-time 20 -X POST "http://127.0.0.1:$Port/v1/embeddings" -H 'Content-Type: application/json' -d $payload
$embedHead = if ($embed) { $embed.Substring(0, [Math]::Min(160, $embed.Length)) } else { '（空响应，检查模型名/服务日志）' }
Info "POST /v1/embeddings => $embedHead"
Info '完成。回到 DSH：设置 → 记忆 → 语义召回（可选）→ 检测连接 → 一键配置并建缓存。'
