param(
  [string]$ProfileDir = "$env:TEMP\cdp-profile",
  [int]$Port = 9222,
  [string]$ChromePath = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

# 一键桥接：启动调试 Chrome（独立配置目录）→ 写 DevToolsActivePort → 启动 CDP 代理
# 用法：在迁移包根目录运行  .\setup-bridge.ps1

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null

$alive = $false
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null
  $alive = $true
} catch {}

if (-not $alive) {
  Write-Host "启动 Chrome（调试端口 $Port，独立配置目录 $ProfileDir）..."
  Start-Process -FilePath $ChromePath -ArgumentList "--remote-debugging-port=$Port", "--user-data-dir=$ProfileDir", "--no-first-run", "--no-default-browser-check"
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null
      $alive = $true
      break
    } catch {}
  }
}

if (-not $alive) { throw "Chrome 调试端口 $Port 未就绪" }

$v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
$wsPath = $v.webSocketDebuggerUrl.Replace("ws://127.0.0.1:$Port", "")
@("$Port", $wsPath) | Set-Content -LiteralPath (Join-Path $ProfileDir "DevToolsActivePort") -Encoding Ascii
Write-Host ("DevToolsActivePort 已写入: " + (Get-Content -LiteralPath (Join-Path $ProfileDir "DevToolsActivePort") -Raw))

$env:WEB_ACCESS_CHROME_DATA_DIR = $ProfileDir
$checkDeps = Join-Path $PSScriptRoot "skills\web-access\scripts\check-deps.mjs"
& node $checkDeps --browser chrome
if ($LASTEXITCODE -ne 0) { throw "CDP 代理启动失败" }

Write-Host ""
Write-Host "桥接就绪。现在可以在目标机器浏览器中登录 CARSI 后批量下载。"
