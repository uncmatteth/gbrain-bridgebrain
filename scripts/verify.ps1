param(
  [switch]$SkipGbrain,
  [switch]$SkipBridge
)

$ErrorActionPreference = "Stop"

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$GbrainHomeParent = if ($env:GBRAIN_HOME) { $env:GBRAIN_HOME } else { $HOME }
$GbrainConfigDir = Join-Path $GbrainHomeParent ".gbrain"
$SkillName = "unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
$BridgeScript = if ($env:BRIDGE_SCRIPT) { $env:BRIDGE_SCRIPT } else { Join-Path $CodexHome "skills\$SkillName\scripts\gpt-web-login-bridge.js" }
$NodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$CodexBin = if ($env:CODEX_BIN) { $env:CODEX_BIN } else { (Get-Command codex -ErrorAction SilentlyContinue).Source }
$GbrainBin = if ($env:GBRAIN_BIN) { $env:GBRAIN_BIN } else { (Get-Command gbrain -ErrorAction SilentlyContinue).Source }
$Port = if ($env:GBRAIN_CHATGPT_EMBED_PORT) { $env:GBRAIN_CHATGPT_EMBED_PORT } else { "4127" }
$Profile = if ($env:BRIDGEBRAIN_PROFILE) { $env:BRIDGEBRAIN_PROFILE } elseif ($env:GBRAIN_CHATGPT_EMBED_PROFILE) { $env:GBRAIN_CHATGPT_EMBED_PROFILE } else { "quality" }
$ModelName = if ($env:GBRAIN_CHATGPT_EMBED_MODEL) { $env:GBRAIN_CHATGPT_EMBED_MODEL } else { "chatgpt-bridge-semantic-hash-1536" }
$Dimensions = if ($env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS } else { "1536" }
$Token = if ($env:BRIDGEBRAIN_API_TOKEN) { $env:BRIDGEBRAIN_API_TOKEN } elseif ($env:GBRAIN_CHATGPT_EMBED_TOKEN) { $env:GBRAIN_CHATGPT_EMBED_TOKEN } else { "" }
$BaseUrl = "http://127.0.0.1:$Port/v1"
$HealthUrl = "$BaseUrl/health"
$RequestAuthToken = ""
$ProfileEnvSet = [bool]($env:BRIDGEBRAIN_PROFILE -or $env:GBRAIN_CHATGPT_EMBED_PROFILE)
$ModelEnvSet = [bool]$env:GBRAIN_CHATGPT_EMBED_MODEL
$DimensionsEnvSet = [bool]$env:GBRAIN_CHATGPT_EMBED_DIMENSIONS

if ($Profile -eq "compat") {
  if (-not $env:GBRAIN_CHATGPT_EMBED_MODEL) { $ModelName = "chatgpt-bridge-semantic-hash-768" }
  if (-not $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $Dimensions = "768" }
}

function Fail($Message) {
  Write-Error "VERIFY FAILED: $Message"
  exit 1
}

function Invoke-Checked($Label, $Command, $Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Label failed with exit code $LASTEXITCODE"
  }
}

function Invoke-CaptureChecked($Label, $Command, $Arguments) {
  $Output = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Label failed with exit code $LASTEXITCODE"
  }
  return $Output
}

function Redact-Url($Value) {
  $Text = "$Value"
  $Text = $Text -replace '/v1/t/[^/\s''"<>]+', '/v1/t/<redacted>'
  $Text = $Text -replace '/t/[^/\s''"<>]+', '/t/<redacted>'
  $Text = $Text -replace '([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+', '$1<redacted>'
  $Text = $Text -replace '([a-z][a-z0-9+.-]*://)([^/@\s]+)@', '$1<redacted>@'
  return $Text
}

function Test-CredentialUrl($Parsed) {
  if ($Parsed.UserInfo) { return $true }
  if ($Parsed.AbsolutePath -match '(^|/)v1/t/[^/]+(/|$)' -or $Parsed.AbsolutePath -match '(^|/)t/[^/]+(/|$)') { return $true }
  if ($Parsed.Query -match '(?i)(token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)=') { return $true }
  return $false
}

function Get-HealthPath($Parsed) {
  $PathPrefix = $Parsed.AbsolutePath -replace '/v1(/t/[^/]+)?/?$', ''
  $PathPrefix = $PathPrefix.TrimEnd("/")
  return "$PathPrefix/health"
}

function Get-ServiceHealthUrl($EmbeddingBaseUrl, $AuthToken) {
  try {
    $Parsed = [System.Uri]$EmbeddingBaseUrl
  } catch {
    Fail "invalid embedding base URL: $(Redact-Url $EmbeddingBaseUrl)"
  }
  $HostName = $Parsed.Host.ToLowerInvariant()
  $Loopback = $HostName -eq "127.0.0.1" -or $HostName -eq "localhost" -or $HostName -eq "::1" -or $HostName -eq "[::1]"
	  if ($Parsed.Scheme -ne "http" -and $Parsed.Scheme -ne "https") {
	    Fail "provider URL protocol must be http or https"
	  }
	  if ($Parsed.Query) {
	    Fail "provider URL query strings are not supported: $(Redact-Url $EmbeddingBaseUrl)"
	  }
  if (-not $Loopback -and $env:BRIDGEBRAIN_VERIFY_ALLOW_REMOTE -ne "1") {
    Fail "provider URL must be loopback unless BRIDGEBRAIN_VERIFY_ALLOW_REMOTE=1"
  }
  if (-not $Loopback -and $Parsed.Scheme -eq "http" -and ($AuthToken -or (Test-CredentialUrl $Parsed))) {
    Fail "remote provider URLs must use https when credentials would be sent: $(Redact-Url $EmbeddingBaseUrl)"
  }
  return "$($Parsed.Scheme)://$($Parsed.Authority)$(Get-HealthPath $Parsed)$($Parsed.Query)"
}

function Test-GBrainHome($PathValue) {
  $Root = [System.IO.Path]::GetPathRoot($PathValue)
  if (-not $Root -or $PathValue -match '^[A-Za-z]:[^\\/]') { Fail "GBRAIN_HOME must be an absolute path when set." }
  $Segments = $PathValue -split '[\\/]+'
  if ($Segments -contains '..') { Fail "GBRAIN_HOME must not contain '..' path segments." }
}

Test-GBrainHome $GbrainHomeParent
if (-not $NodeBin) { Fail "node is missing" }

$ConfigFile = Join-Path $GbrainConfigDir "config.json"
if (Test-Path $ConfigFile) {
  $ConfigForBaseUrl = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  if ($ConfigForBaseUrl.provider_base_urls.litellm) {
    $BaseUrl = $ConfigForBaseUrl.provider_base_urls.litellm
  }
  if (-not $ModelEnvSet -and -not $ProfileEnvSet -and $ConfigForBaseUrl.embedding_model) {
    $ModelName = "$($ConfigForBaseUrl.embedding_model)" -replace '^litellm:', ''
  }
  if (-not $DimensionsEnvSet -and -not $ProfileEnvSet -and $ConfigForBaseUrl.embedding_dimensions) {
    $Dimensions = "$($ConfigForBaseUrl.embedding_dimensions)"
  }
}
if ($Token) {
  try {
    $BaseUriForAuth = [System.Uri]$BaseUrl
  } catch {
    Fail "invalid embedding base URL: $(Redact-Url $BaseUrl)"
  }
  if (-not (Test-CredentialUrl $BaseUriForAuth)) {
    $RequestAuthToken = $Token
  }
}
$HealthUrl = Get-ServiceHealthUrl $BaseUrl $RequestAuthToken
if (-not $ProfileEnvSet) {
  if ($ModelName -like "*-768" -or "$Dimensions" -eq "768") {
    $Profile = "compat"
  } elseif ($Profile -ne "mock") {
    $Profile = "quality"
  }
}
if ($Profile -ne "mock" -and $SkipBridge) {
  Fail "--skip-bridge is only allowed for mock profile tests."
}

if ($Profile -ne "mock" -and -not $SkipBridge) {
  if (-not $CodexBin) { Fail "codex is missing" }
  if (-not (Test-Path $BridgeScript)) { Fail "bridge script missing at $BridgeScript" }
  Write-Host "Checking ChatGPT web-login bridge smoke..."
  $env:GPT_WEB_LOGIN_CODEX_BIN = $CodexBin
  Invoke-Checked "bridge smoke" $NodeBin @($BridgeScript, "smoke")
}

Write-Host "Checking local embedding service..."
$Health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
if (-not $Health.ok) { Fail "health.ok is false" }
if ($Health.model -ne $ModelName) { Fail "model mismatch: $($Health.model) != $ModelName" }
if ([int]$Health.dimensions -ne [int]$Dimensions) { Fail "dimension mismatch: $($Health.dimensions) != $Dimensions" }
if ($Health.profile -ne $Profile) { Fail "profile mismatch: $($Health.profile) != $Profile" }

Write-Host "Checking default 1536 embedding response..."
$Body1536 = @{ model = "chatgpt-bridge-semantic-hash-1536"; input = @("BridgeBrain verification smoke test") } | ConvertTo-Json
$RequestHeaders = if ($RequestAuthToken) { @{ Authorization = "Bearer $RequestAuthToken" } } else { @{} }
$Response1536 = Invoke-RestMethod -Method Post -Uri "$BaseUrl/embeddings" -Headers $RequestHeaders -ContentType "application/json" -Body $Body1536 -TimeoutSec 20
$Embedding1536 = $Response1536.data[0].embedding
if (-not $Embedding1536 -or $Embedding1536.Count -ne 1536) { Fail "expected 1536 dims, got $($Embedding1536.Count)" }
if (-not ($Embedding1536 | Where-Object { $_ -is [double] -or $_ -is [int] -or $_ -is [decimal] } | Where-Object { $_ -ne 0 } | Select-Object -First 1)) {
  Fail "1536 embedding is all zero or invalid"
}

Write-Host "Checking explicit 768 compatibility response..."
$Body768 = @{ model = "chatgpt-bridge-semantic-hash-768"; input = @("BridgeBrain compatibility smoke test"); dimensions = 768 } | ConvertTo-Json
$Response768 = Invoke-RestMethod -Method Post -Uri "$BaseUrl/embeddings" -Headers $RequestHeaders -ContentType "application/json" -Body $Body768 -TimeoutSec 20
$Embedding768 = $Response768.data[0].embedding
if (-not $Embedding768 -or $Embedding768.Count -ne 768) { Fail "expected 768 dims, got $($Embedding768.Count)" }
if (-not ($Embedding768 | Where-Object { $_ -is [double] -or $_ -is [int] -or $_ -is [decimal] } | Where-Object { $_ -ne 0 } | Select-Object -First 1)) {
  Fail "768 embedding is all zero or invalid"
}

if ($SkipGbrain) {
  Write-Host "Skipping GBrain checks."
  Write-Host "BridgeBrain adapter verified."
  exit 0
}

if (-not $GbrainBin) { Fail "gbrain is missing" }

Write-Host "Checking GBrain config..."
$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
if ($Config.embedding_disabled) { Fail "embedding_disabled is still true" }
if ($Config.embedding_model -ne "litellm:$ModelName") { Fail "wrong embedding_model: $($Config.embedding_model)" }
if ([int]$Config.embedding_dimensions -ne [int]$Dimensions) { Fail "wrong embedding_dimensions: $($Config.embedding_dimensions)" }
if ($Config.provider_base_urls.litellm -ne $BaseUrl) {
  Fail "wrong litellm base url: $(Redact-Url $Config.provider_base_urls.litellm) (expected $(Redact-Url $BaseUrl))"
}

Write-Host "Checking GBrain provider..."
Invoke-Checked "GBrain provider test" $GbrainBin @("providers", "test")

Write-Host "Checking GBrain doctor summary..."
$DoctorJson = Invoke-CaptureChecked "GBrain doctor" $GbrainBin @("doctor", "--json")
$Doctor = $DoctorJson | ConvertFrom-Json
$Provider = $Doctor.checks | Where-Object { $_.name -eq "embedding_provider" } | Select-Object -First 1
$Width = $Doctor.checks | Where-Object { $_.name -eq "embedding_width_consistency" } | Select-Object -First 1
if (-not $Provider -or $Provider.status -ne "ok") { Fail "embedding_provider not ok: $($Provider.message)" }
if (-not ($Provider.message -like "*litellm:$ModelName*")) { Fail "wrong provider: $($Provider.message)" }
if (-not $Width -or $Width.status -ne "ok") { Fail "embedding_width_consistency not ok: $($Width.message)" }

Write-Host "BridgeBrain verified."
