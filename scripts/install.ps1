param(
  [switch]$InstallGBrain,
  [switch]$SkipService,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function New-BridgeBrainToken {
  $Bytes = New-Object byte[] 32
  $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $Rng.GetBytes($Bytes)
  } finally {
    $Rng.Dispose()
  }
  return -join ($Bytes | ForEach-Object { $_.ToString("x2") })
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$ServiceHome = Join-Path $CodexHome "services\gbrain-chatgpt-embeddings"
$SkillName = "unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
$SkillDest = Join-Path $CodexHome "skills\$SkillName"
$NodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$CodexBin = if ($env:CODEX_BIN) { $env:CODEX_BIN } else { (Get-Command codex -ErrorAction SilentlyContinue).Source }
$GbrainBin = if ($env:GBRAIN_BIN) { $env:GBRAIN_BIN } else { (Get-Command gbrain -ErrorAction SilentlyContinue).Source }
$Port = if ($env:GBRAIN_CHATGPT_EMBED_PORT) { $env:GBRAIN_CHATGPT_EMBED_PORT } else { "4127" }
$Profile = if ($env:BRIDGEBRAIN_PROFILE) { $env:BRIDGEBRAIN_PROFILE } elseif ($env:GBRAIN_CHATGPT_EMBED_PROFILE) { $env:GBRAIN_CHATGPT_EMBED_PROFILE } else { "quality" }
$ModelName = if ($env:GBRAIN_CHATGPT_EMBED_MODEL) { $env:GBRAIN_CHATGPT_EMBED_MODEL } else { "chatgpt-bridge-semantic-hash-1536" }
$Dimensions = if ($env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS } else { "1536" }
$Token = if ($env:BRIDGEBRAIN_API_TOKEN) { $env:BRIDGEBRAIN_API_TOKEN } elseif ($env:GBRAIN_CHATGPT_EMBED_TOKEN) { $env:GBRAIN_CHATGPT_EMBED_TOKEN } else { New-BridgeBrainToken }
$BaseUrl = "http://127.0.0.1:$Port/v1/t/$Token"

if ($Profile -eq "compat") {
  if (-not $env:GBRAIN_CHATGPT_EMBED_MODEL) { $ModelName = "chatgpt-bridge-semantic-hash-768" }
  if (-not $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $Dimensions = "768" }
}

function Fail($Message) {
  Write-Error "INSTALL FAILED: $Message"
  exit 1
}

function Test-GBrainHome($PathValue) {
  $Root = [System.IO.Path]::GetPathRoot($PathValue)
  if (-not $Root -or $PathValue -match '^[A-Za-z]:[^\\/]') { Fail "GBRAIN_HOME must be an absolute path when set." }
  $Segments = $PathValue -split '[\\/]+'
  if ($Segments -contains '..') { Fail "GBRAIN_HOME must not contain '..' path segments." }
}

function Protect-LocalSecretPath($PathValue) {
  try {
    if ($env:OS -ne "Windows_NT" -and -not $IsWindows) { return }
    $Icacls = (Get-Command icacls -ErrorAction SilentlyContinue).Source
    if (-not $Icacls) { return }
    $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & $Icacls $PathValue /inheritance:r /grant:r "*${Sid}:F" "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
  } catch {
    Write-Warning "Could not restrict ACL on ${PathValue}: $($_.Exception.Message)"
  }
}

if (-not $NodeBin) { Fail "Node.js is required. Install Node or set NODE_BIN." }
if (-not $CodexBin) { Fail "Codex CLI is required and must already be logged in with ChatGPT auth." }
if (-not $GbrainBin) {
  if (-not $InstallGBrain) { Fail "gbrain is missing. Install it first, or rerun with -InstallGBrain after Bun is installed." }
  $BunBin = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $BunBin) { Fail "Bun is missing. Install Bun first, then rerun -InstallGBrain." }
  & $BunBin install -g github:garrytan/gbrain
  $GbrainBin = (Get-Command gbrain -ErrorAction SilentlyContinue).Source
}
if (-not $GbrainBin) { Fail "gbrain is still missing after install attempt." }

New-Item -ItemType Directory -Force -Path $ServiceHome | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SkillDest "scripts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SkillDest "agents") | Out-Null

Copy-Item -Force (Join-Path $Root "src\gbrain-chatgpt-embeddings-server.js") (Join-Path $ServiceHome "server.js")
Copy-Item -Force (Join-Path $Root "bridge-skill\$SkillName\SKILL.md") (Join-Path $SkillDest "SKILL.md")
Copy-Item -Force (Join-Path $Root "bridge-skill\$SkillName\agents\openai.yaml") (Join-Path $SkillDest "agents\openai.yaml")
Copy-Item -Force (Join-Path $Root "bridge-skill\$SkillName\scripts\gpt-web-login-bridge.js") (Join-Path $SkillDest "scripts\gpt-web-login-bridge.js")

$env:GPT_WEB_LOGIN_CODEX_BIN = $CodexBin
$env:GPT_WEB_LOGIN_CWD = $HOME
& $NodeBin (Join-Path $SkillDest "scripts\gpt-web-login-bridge.js") status
& $NodeBin (Join-Path $Root "scripts\patch-gbrain-litellm.js")

$GbrainHomeParent = if ($env:GBRAIN_HOME) { $env:GBRAIN_HOME } else { $HOME }
Test-GBrainHome $GbrainHomeParent
$GbrainConfigDir = Join-Path $GbrainHomeParent ".gbrain"
$ConfigFile = Join-Path $GbrainConfigDir "config.json"
New-Item -ItemType Directory -Force -Path $GbrainConfigDir | Out-Null
$ConfigExisted = Test-Path $ConfigFile
& $NodeBin (Join-Path $Root "scripts\configure-gbrain.js") $ConfigFile $ModelName $Dimensions $BaseUrl
if (-not $ConfigExisted) {
  & $GbrainBin init --pglite --embedding-model "litellm:$ModelName" --embedding-dimensions $Dimensions --skip-embed-check
  & $NodeBin (Join-Path $Root "scripts\configure-gbrain.js") $ConfigFile $ModelName $Dimensions $BaseUrl
}
Protect-LocalSecretPath $GbrainConfigDir
Protect-LocalSecretPath $ConfigFile

if (-not $SkipService) {
  $Runner = Join-Path $ServiceHome "run-bridgebrain.ps1"
  @"
`$env:GBRAIN_CHATGPT_EMBED_HOST = "127.0.0.1"
`$env:GBRAIN_CHATGPT_EMBED_PORT = "$Port"
`$env:GBRAIN_CHATGPT_EMBED_PROFILE = "$Profile"
`$env:GBRAIN_CHATGPT_EMBED_DIMENSIONS = "$Dimensions"
`$env:GBRAIN_CHATGPT_EMBED_MODEL = "$ModelName"
`$env:BRIDGEBRAIN_API_TOKEN = "$Token"
`$env:CODEX_HOME = "$($CodexHome.Replace("\", "\\"))"
`$env:BRIDGE_SCRIPT = "$((Join-Path $SkillDest "scripts\gpt-web-login-bridge.js").Replace("\", "\\"))"
`$env:CACHE_DIR = "$((Join-Path $ServiceHome "cache").Replace("\", "\\"))"
`$env:GPT_WEB_LOGIN_CODEX_BIN = "$($CodexBin.Replace("\", "\\"))"
`$env:GPT_WEB_LOGIN_CWD = "$($HOME.Replace("\", "\\"))"
& "$($NodeBin.Replace("\", "\\"))" "$((Join-Path $ServiceHome "server.js").Replace("\", "\\"))"
"@ | Set-Content -Encoding UTF8 $Runner
  Protect-LocalSecretPath $Runner

  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $TaskName = "GBrain BridgeBrain Embeddings"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Description "BridgeBrain local GBrain embeddings service" | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

if (-not $SkipService) {
  Start-Sleep -Seconds 2
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" | Out-Null
}

if (-not $SkipVerify) {
  & (Join-Path $Root "scripts\verify.ps1")
}

Write-Host "BridgeBrain installed."
Write-Host "Model: litellm:$ModelName"
Write-Host "Dimensions: $Dimensions"
Write-Host "Endpoint: http://127.0.0.1:$Port/v1/t/<redacted>"
