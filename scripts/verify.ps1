param(
  [switch]$SkipGbrain,
  [switch]$SkipBridge
)

$ErrorActionPreference = "Stop"

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$GbrainHome = if ($env:GBRAIN_HOME) { $env:GBRAIN_HOME } else { Join-Path $HOME ".gbrain" }
$SkillName = "unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
$BridgeScript = if ($env:BRIDGE_SCRIPT) { $env:BRIDGE_SCRIPT } else { Join-Path $CodexHome "skills\$SkillName\scripts\gpt-web-login-bridge.js" }
$Port = if ($env:GBRAIN_CHATGPT_EMBED_PORT) { $env:GBRAIN_CHATGPT_EMBED_PORT } else { "4127" }
$Profile = if ($env:BRIDGEBRAIN_PROFILE) { $env:BRIDGEBRAIN_PROFILE } elseif ($env:GBRAIN_CHATGPT_EMBED_PROFILE) { $env:GBRAIN_CHATGPT_EMBED_PROFILE } else { "quality" }
$ModelName = if ($env:GBRAIN_CHATGPT_EMBED_MODEL) { $env:GBRAIN_CHATGPT_EMBED_MODEL } else { "chatgpt-bridge-semantic-hash-1536" }
$Dimensions = if ($env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS } else { "1536" }
$Token = if ($env:BRIDGEBRAIN_API_TOKEN) { $env:BRIDGEBRAIN_API_TOKEN } elseif ($env:GBRAIN_CHATGPT_EMBED_TOKEN) { $env:GBRAIN_CHATGPT_EMBED_TOKEN } else { "" }
$BaseUrl = "http://127.0.0.1:$Port/v1"

if ($Profile -eq "compat") {
  if (-not $env:GBRAIN_CHATGPT_EMBED_MODEL) { $ModelName = "chatgpt-bridge-semantic-hash-768" }
  if (-not $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $Dimensions = "768" }
}

function Fail($Message) {
  Write-Error "VERIFY FAILED: $Message"
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node is missing" }

$ConfigFile = Join-Path $GbrainHome "config.json"
if (Test-Path $ConfigFile) {
  $ConfigForBaseUrl = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  if ($ConfigForBaseUrl.provider_base_urls.litellm) {
    $BaseUrl = $ConfigForBaseUrl.provider_base_urls.litellm
  }
} elseif ($Token) {
  $BaseUrl = "http://127.0.0.1:$Port/v1/t/$Token"
}

if ($Profile -ne "mock" -and -not $SkipBridge) {
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Fail "codex is missing" }
  if (-not (Test-Path $BridgeScript)) { Fail "bridge script missing at $BridgeScript" }
  Write-Host "Checking ChatGPT web-login bridge..."
  node $BridgeScript status
}

Write-Host "Checking local embedding service..."
$Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health"
if (-not $Health.ok) { Fail "health.ok is false" }
if ($Health.model -ne $ModelName) { Fail "model mismatch: $($Health.model) != $ModelName" }
if ([int]$Health.dimensions -ne [int]$Dimensions) { Fail "dimension mismatch: $($Health.dimensions) != $Dimensions" }
if ($Health.profile -ne $Profile) { Fail "profile mismatch: $($Health.profile) != $Profile" }

Write-Host "Checking default 1536 embedding response..."
$Body1536 = @{ model = "chatgpt-bridge-semantic-hash-1536"; input = @("BridgeBrain verification smoke test") } | ConvertTo-Json
$Response1536 = Invoke-RestMethod -Method Post -Uri "$BaseUrl/embeddings" -ContentType "application/json" -Body $Body1536
$Embedding1536 = $Response1536.data[0].embedding
if (-not $Embedding1536 -or $Embedding1536.Count -ne 1536) { Fail "expected 1536 dims, got $($Embedding1536.Count)" }

Write-Host "Checking explicit 768 compatibility response..."
$Body768 = @{ model = "chatgpt-bridge-semantic-hash-768"; input = @("BridgeBrain compatibility smoke test"); dimensions = 768 } | ConvertTo-Json
$Response768 = Invoke-RestMethod -Method Post -Uri "$BaseUrl/embeddings" -ContentType "application/json" -Body $Body768
$Embedding768 = $Response768.data[0].embedding
if (-not $Embedding768 -or $Embedding768.Count -ne 768) { Fail "expected 768 dims, got $($Embedding768.Count)" }

if ($SkipGbrain) {
  Write-Host "Skipping GBrain checks."
  Write-Host "BridgeBrain adapter verified."
  exit 0
}

if (-not (Get-Command gbrain -ErrorAction SilentlyContinue)) { Fail "gbrain is missing" }

Write-Host "Checking GBrain config..."
$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
if ($Config.embedding_disabled) { Fail "embedding_disabled is still true" }
if ($Config.embedding_model -ne "litellm:$ModelName") { Fail "wrong embedding_model: $($Config.embedding_model)" }
if ([int]$Config.embedding_dimensions -ne [int]$Dimensions) { Fail "wrong embedding_dimensions: $($Config.embedding_dimensions)" }
if ($Config.provider_base_urls.litellm -ne $BaseUrl) { Fail "wrong litellm base url: $($Config.provider_base_urls.litellm)" }

Write-Host "Checking GBrain provider..."
gbrain providers test

Write-Host "Checking GBrain doctor summary..."
$DoctorJson = gbrain doctor --json
$Doctor = $DoctorJson | ConvertFrom-Json
$Provider = $Doctor.checks | Where-Object { $_.name -eq "embedding_provider" } | Select-Object -First 1
$Width = $Doctor.checks | Where-Object { $_.name -eq "embedding_width_consistency" } | Select-Object -First 1
if (-not $Provider -or $Provider.status -ne "ok") { Fail "embedding_provider not ok: $($Provider.message)" }
if (-not ($Provider.message -like "*litellm:$ModelName*")) { Fail "wrong provider: $($Provider.message)" }
if (-not $Width -or $Width.status -ne "ok") { Fail "embedding_width_consistency not ok: $($Width.message)" }

Write-Host "BridgeBrain verified."
