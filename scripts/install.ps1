param(
  [switch]$InstallGBrain,
  [switch]$MachineMemory,
  [switch]$MachineMemorySyncNow,
  [switch]$SkipService,
  [switch]$SkipVerify,
  [switch]$DryRun
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

function Fail($Message) {
  Write-Error "INSTALL FAILED: $Message"
  exit 1
}

function Test-TcpPort($Label, $Value) {
  $Parsed = 0
  if (-not [int]::TryParse([string]$Value, [ref]$Parsed) -or $Parsed -lt 1 -or $Parsed -gt 65535) {
    Fail "$Label must be an integer TCP port in 1..65535."
  }
}

function Test-BridgeBrainToken($Value) {
  if (-not ("$Value" -match '^[A-Za-z0-9._~-]{8,256}$')) {
    Fail "BridgeBrain token must be 8..256 URL-safe characters."
  }
}

function Test-PositiveInteger($Label, $Value) {
  $Parsed = 0
  if (-not [int]::TryParse([string]$Value, [ref]$Parsed) -or $Parsed -le 0) {
    Fail "$Label must be a positive integer."
  }
}

function Test-NodeVersion($NodeCommand) {
  $VersionText = & $NodeCommand -e "process.stdout.write(process.versions.node)"
  if ($LASTEXITCODE -ne 0) { Fail "Could not read Node.js version." }
  $Major = 0
  if (-not [int]::TryParse(($VersionText -split '\.')[0], [ref]$Major) -or $Major -lt 18) {
    Fail "Node.js 18 or newer is required."
  }
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$ServiceHome = Join-Path $CodexHome "services\gbrain-chatgpt-embeddings"
$MachineMemoryHome = Join-Path $CodexHome "services\gbrain-machine-memory"
$SkillName = "unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
$SkillDest = Join-Path $CodexHome "skills\$SkillName"
$NodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$CodexBin = if ($env:CODEX_BIN) { $env:CODEX_BIN } else { (Get-Command codex -ErrorAction SilentlyContinue).Source }
$GbrainBin = if ($env:GBRAIN_BIN) { $env:GBRAIN_BIN } else { (Get-Command gbrain -ErrorAction SilentlyContinue).Source }
$Port = if ($env:GBRAIN_CHATGPT_EMBED_PORT) { $env:GBRAIN_CHATGPT_EMBED_PORT } else { "4127" }
$Profile = if ($env:BRIDGEBRAIN_PROFILE) { $env:BRIDGEBRAIN_PROFILE } elseif ($env:GBRAIN_CHATGPT_EMBED_PROFILE) { $env:GBRAIN_CHATGPT_EMBED_PROFILE } else { "quality" }
$ModelName = if ($env:GBRAIN_CHATGPT_EMBED_MODEL) { $env:GBRAIN_CHATGPT_EMBED_MODEL } else { "chatgpt-bridge-semantic-hash-1536" }
$Dimensions = if ($env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS } else { "1536" }
$TokenSupplied = [bool]($env:BRIDGEBRAIN_API_TOKEN -or $env:GBRAIN_CHATGPT_EMBED_TOKEN)
$Token = if ($env:BRIDGEBRAIN_API_TOKEN) { $env:BRIDGEBRAIN_API_TOKEN } elseif ($env:GBRAIN_CHATGPT_EMBED_TOKEN) { $env:GBRAIN_CHATGPT_EMBED_TOKEN } else { New-BridgeBrainToken }
$BaseUrl = "http://127.0.0.1:$Port/v1/t/$Token"
$MachineMemoryIntervalSeconds = if ($env:GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS) { $env:GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS } else { "900" }
$MachineMemoryRoots = if ($env:GBRAIN_MACHINE_ROOTS) { $env:GBRAIN_MACHINE_ROOTS } else { "" }
$MachineMemoryTerminateServe = if ($env:GBRAIN_MACHINE_TERMINATE_SERVE) { $env:GBRAIN_MACHINE_TERMINATE_SERVE } else { "none" }
$MachineMemorySyncTimeoutSeconds = if ($env:GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS) { $env:GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS } else { "600" }
$MachineMemoryGbrainTimeoutSeconds = if ($env:GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS) { $env:GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS } else { "" }
$GbrainInstallSpec = if ($env:GBRAIN_INSTALL_SPEC) { $env:GBRAIN_INSTALL_SPEC } else { "github:garrytan/gbrain#1eb430a2df9f842a754dd6af9910f049ccac65a1" }
$MachineMemoryUnlock = if ($env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY) { $env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY } else { "" }
$MachineMemoryAllowWideRoots = if ($env:BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS) { $env:BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS } else { "" }
$GbrainHomeParent = if ($env:GBRAIN_HOME) { $env:GBRAIN_HOME } else { $HOME }

if ($MachineMemorySyncNow) {
  $MachineMemory = $true
}

if ($Profile -eq "compat") {
  if (-not $env:GBRAIN_CHATGPT_EMBED_MODEL) { $ModelName = "chatgpt-bridge-semantic-hash-768" }
  if (-not $env:GBRAIN_CHATGPT_EMBED_DIMENSIONS) { $Dimensions = "768" }
}
if ($Profile -ne "quality" -and $Profile -ne "compat" -and $Profile -ne "mock") {
  Fail "BRIDGEBRAIN_PROFILE must be quality, compat, or mock."
}
Test-TcpPort "GBRAIN_CHATGPT_EMBED_PORT" $Port
Test-BridgeBrainToken $Token
if ($SkipService -and -not $DryRun -and -not $TokenSupplied) {
  Fail "-SkipService requires BRIDGEBRAIN_API_TOKEN or GBRAIN_CHATGPT_EMBED_TOKEN so GBrain is not rewritten to a fresh token for an old service."
}

function Invoke-Checked($Label, $Command, $Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Label failed with exit code $LASTEXITCODE"
  }
}

function Test-GBrainHome($PathValue) {
  $Root = [System.IO.Path]::GetPathRoot($PathValue)
  if (-not $Root -or $PathValue -match '^[A-Za-z]:[^\\/]') { Fail "GBRAIN_HOME must be an absolute path when set." }
  $Segments = $PathValue -split '[\\/]+'
  if ($Segments -contains '..') { Fail "GBRAIN_HOME must not contain '..' path segments." }
}

function Test-PathWithin($ChildPath, $ParentPath) {
  if (-not $ParentPath) { return $false }
  $Child = ([string]$ChildPath).TrimEnd('\', '/').Replace('\', '/')
  $Parent = ([string]$ParentPath).TrimEnd('\', '/').Replace('\', '/')
  $Comparison = if ($env:OS -eq "Windows_NT" -or $IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
  return ([string]::Equals($Child, $Parent, $Comparison) -or $Child.StartsWith("$Parent/", $Comparison))
}

function Resolve-InstallPath($PathValue) {
  $Current = [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\', '/')
  for ($Depth = 0; $Depth -lt 10; $Depth += 1) {
    if (-not (Test-Path -LiteralPath $Current)) { return $Current }
    $Item = Get-Item -LiteralPath $Current -Force
    $LinkTarget = $null
    if ($Item.PSObject.Properties.Name -contains "Target" -and $Item.Target) {
      $LinkTarget = @($Item.Target)[0]
    }
    if (-not $LinkTarget) {
      return ([string]$Item.FullName).TrimEnd('\', '/')
    }
    if (-not [System.IO.Path]::IsPathRooted($LinkTarget)) {
      $LinkTarget = Join-Path (Split-Path -Parent $Item.FullName) $LinkTarget
    }
    $Current = [System.IO.Path]::GetFullPath($LinkTarget).TrimEnd('\', '/')
  }
  Fail "could not resolve path after following reparse points: $PathValue"
}

function Test-PrivateBlockedRoot($ResolvedPath) {
  $PrivateRoots = @(
    $CodexHome,
    (Join-Path $GbrainHomeParent ".gbrain"),
    (Join-Path $HOME ".openclaw"),
    (Join-Path $HOME ".agents"),
    (Join-Path (Join-Path $HOME ".codex") "memories")
  )
  foreach ($PrivateRoot in $PrivateRoots) {
    $ResolvedPrivate = Resolve-InstallPath $PrivateRoot
    if ((Test-PathWithin $ResolvedPath $ResolvedPrivate) -or (Test-PathWithin $ResolvedPrivate $ResolvedPath)) { return $ResolvedPrivate }
  }
  $HomeSlash = (Resolve-InstallPath $HOME).Replace('\', '/')
  $RootSlash = ([string]$ResolvedPath).Replace('\', '/')
  $Comparison = if ($env:OS -eq "Windows_NT" -or $IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
  if ([string]::Equals($RootSlash, "$HomeSlash/.codex", $Comparison) -or $RootSlash.StartsWith("$HomeSlash/.", $Comparison)) {
    return "hidden home directory"
  }
  return ""
}

function Test-MachineMemoryRequest {
  if (-not $MachineMemory) { return }
  if ($MachineMemoryUnlock -ne "1") {
    Fail "machine memory is locked. Set BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 and GBRAIN_MACHINE_ROOTS for this exact install."
  }
  if (-not $MachineMemoryRoots) {
    Fail "GBRAIN_MACHINE_ROOTS is required for machine memory. No default roots are scanned."
  }
  if ($MachineMemoryTerminateServe -ne "none" -and $MachineMemoryTerminateServe -ne "all") {
    Fail "GBRAIN_MACHINE_TERMINATE_SERVE must be none or all."
  }
  Test-PositiveInteger "GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS" $MachineMemoryIntervalSeconds
  Test-PositiveInteger "GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS" $MachineMemorySyncTimeoutSeconds
  if ($MachineMemoryGbrainTimeoutSeconds) {
    Test-PositiveInteger "GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS" $MachineMemoryGbrainTimeoutSeconds
    if ([int]$MachineMemoryGbrainTimeoutSeconds -ge [int]$MachineMemorySyncTimeoutSeconds) {
      Fail "GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS must be lower than GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS."
    }
  }
  if (($env:OS -eq "Windows_NT" -or $IsWindows) -and $MachineMemoryTerminateServe -ne "none") {
    Fail "GBRAIN_MACHINE_TERMINATE_SERVE=all is not supported on Windows. Stop gbrain serve before scheduled sync or use none."
  }

  $HomeResolved = Resolve-InstallPath $HOME
  $HomeParent = [System.IO.Directory]::GetParent($HomeResolved).FullName.TrimEnd('\', '/')
  $DriveRoot = [System.IO.Path]::GetPathRoot($HomeResolved).TrimEnd('\', '/')
  $ValidatedRoots = @()
  foreach ($RootEntry in $MachineMemoryRoots.Split([System.IO.Path]::PathSeparator)) {
    if (-not $RootEntry) { continue }
    if (-not [System.IO.Path]::IsPathRooted($RootEntry)) {
      Fail "machine memory root must be absolute: $RootEntry"
    }
    if (-not (Test-Path -LiteralPath $RootEntry -PathType Container)) {
      Fail "machine memory root does not exist or is unreadable: $RootEntry"
    }
    $Resolved = Resolve-InstallPath $RootEntry
    $PrivateReason = Test-PrivateBlockedRoot $Resolved
    if ($PrivateReason) {
      Fail "private machine memory root blocked: $Resolved ($PrivateReason). Use specific public repo/work roots."
    }
    if ($MachineMemoryAllowWideRoots -ne "1" -and ($Resolved -eq $HomeResolved -or $Resolved -eq $HomeParent -or $Resolved -eq $DriveRoot -or (Test-DefaultBlockedWideRoot $Resolved))) {
      Fail "wide machine memory root blocked: $Resolved. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review."
    }
    $ValidatedRoots += $Resolved
  }
  if ($ValidatedRoots.Count -eq 0) { Fail "GBRAIN_MACHINE_ROOTS must contain at least one non-empty path." }
  $script:MachineMemoryRoots = ($ValidatedRoots -join [System.IO.Path]::PathSeparator)
}

function Test-DefaultBlockedWideRoot($ResolvedPath) {
  $AsSlash = ([string]$ResolvedPath).Replace('\', '/')
  if ($AsSlash -match '^[A-Za-z]:$') { return $true }
  if ($AsSlash -match '^/media/[^/]+/[^/]+$') { return $true }
  if ($AsSlash -match '^/run/media/[^/]+/[^/]+$') { return $true }
  if ($AsSlash -match '^/mnt/[^/]+$') { return $true }
  if ($AsSlash -match '^/Volumes/[^/]+$') { return $true }
  return $false
}

function Protect-LocalSecretPath($PathValue) {
	  try {
	    if ($env:OS -ne "Windows_NT" -and -not $IsWindows) { return }
	    $Icacls = (Get-Command icacls -ErrorAction SilentlyContinue).Source
	    if (-not $Icacls) { Fail "icacls is required to restrict local secret path ACLs: $PathValue" }
	    $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	    & $Icacls $PathValue /inheritance:r /grant:r "*${Sid}:F" "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
	    if ($LASTEXITCODE -ne 0) { Fail "could not restrict ACL on ${PathValue}" }
	    foreach ($BroadPrincipal in @("*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11", "*S-1-5-32-546", "Everyone", "Users", "Authenticated Users", "Guests")) {
	      & $Icacls $PathValue /remove:g $BroadPrincipal | Out-Null
	      if ($LASTEXITCODE -ne 0) { Fail "could not remove broad ACL principal ${BroadPrincipal} from ${PathValue}" }
	    }
	  } catch {
	    Fail "could not restrict ACL on ${PathValue}: $($_.Exception.Message)"
	  }
}

function ConvertTo-PowerShellLiteral($Value) {
  return "'" + ([string]$Value).Replace("'", "''") + "'"
}

function Wait-BridgeBrainHealth($PortValue) {
  $Deadline = (Get-Date).AddSeconds(20)
  $LastError = ""
  while ((Get-Date) -lt $Deadline) {
    try {
      $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$PortValue/health" -TimeoutSec 2
      if ($Health.ok -and $Health.profile -eq $Profile -and $Health.model -eq $ModelName -and [int]$Health.dimensions -eq [int]$Dimensions) { return }
      $LastError = "health response did not match expected profile/model/dimensions"
    } catch {
      $LastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 250
  }
  Fail "embedding service did not become healthy on port $PortValue. $LastError"
}

function Wait-BridgeBrainAuthenticated($PortValue) {
  $Deadline = (Get-Date).AddSeconds(20)
  $LastError = ""
  $Headers = @{ Authorization = "Bearer $Token" }
  $Body = @{ model = "chatgpt-bridge-semantic-hash-1536"; input = @(@(1, 2, 3)) } | ConvertTo-Json
  while ((Get-Date) -lt $Deadline) {
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$PortValue/v1/embeddings" -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 5 | Out-Null
      $LastError = "auth probe unexpectedly accepted invalid input"
    } catch {
      $StatusCode = 0
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $StatusCode = [int]$_.Exception.Response.StatusCode
      }
      if ($StatusCode -eq 400) { return }
      if ($StatusCode -eq 401) { $LastError = "configured token was rejected" } else { $LastError = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds 250
  }
  Fail "embedding service did not accept the configured token. $LastError"
}

function Write-DryRunPlan {
  $DryRunConfigFile = Join-Path (Join-Path $GbrainHomeParent '.gbrain') 'config.json'
  Write-Host "BridgeBrain dry-run plan"
  Write-Host "Platform: Windows"
  Write-Host "Codex home: $CodexHome"
  Write-Host "GBrain config: $DryRunConfigFile"
  Write-Host "Bridge service home: $ServiceHome"
  Write-Host "Bridge skill destination: $SkillDest"
  Write-Host "Profile: $Profile"
  Write-Host "Model: litellm:$ModelName"
  Write-Host "Dimensions: $Dimensions"
  Write-Host "Endpoint: http://127.0.0.1:$Port/v1/t/<redacted>"
  if ($InstallGBrain) { Write-Host "Install GBrain: would install if missing" } else { Write-Host "Install GBrain: no" }
  if ($SkipService) { Write-Host "Install embedding service: no" } else { Write-Host "Install embedding service: yes" }
  if ($SkipVerify) { Write-Host "Run verify: no" } else { Write-Host "Run verify: yes" }
  if ($MachineMemory) { Write-Host "Machine memory: yes" } else { Write-Host "Machine memory: no" }
  if ($MachineMemoryRoots) { Write-Host "Machine memory roots: $MachineMemoryRoots" } else { Write-Host "Machine memory roots: <unset>" }
  if ($MachineMemoryGbrainTimeoutSeconds) { Write-Host "Machine memory gbrain timeout: $MachineMemoryGbrainTimeoutSeconds" } else { Write-Host "Machine memory gbrain timeout: <timeout minus 30s>" }
  if ($MachineMemorySyncNow) { Write-Host "Machine memory sync now: yes" } else { Write-Host "Machine memory sync now: no" }
  Write-Host "No files will be written. No Scheduled Tasks will be created or started. No GBrain sources will be registered or synced."
}

function Install-MachineMemory {
  New-Item -ItemType Directory -Force -Path $MachineMemoryHome | Out-Null
  Copy-Item -Force (Join-Path $Root "scripts\setup-machine-memory.js") (Join-Path $MachineMemoryHome "setup-machine-memory.js")

  $Runner = Join-Path $MachineMemoryHome "run-machine-sync.ps1"
  $MachineMemoryAllowWideRootsLiteral = ConvertTo-PowerShellLiteral $MachineMemoryAllowWideRoots
  $GbrainBinLiteral = ConvertTo-PowerShellLiteral $GbrainBin
  $GbrainHomeParentLiteral = ConvertTo-PowerShellLiteral $GbrainHomeParent
  $MachineMemoryRootsLiteral = ConvertTo-PowerShellLiteral $MachineMemoryRoots
  $MachineMemoryTerminateServeLiteral = ConvertTo-PowerShellLiteral $MachineMemoryTerminateServe
  $MachineMemorySyncTimeoutSecondsLiteral = ConvertTo-PowerShellLiteral $MachineMemorySyncTimeoutSeconds
  $MachineMemoryGbrainTimeoutSecondsLiteral = ConvertTo-PowerShellLiteral $MachineMemoryGbrainTimeoutSeconds
  $NodeBinLiteral = ConvertTo-PowerShellLiteral $NodeBin
  $CodexHomeLiteral = ConvertTo-PowerShellLiteral $CodexHome
  $MachineMemoryScriptLiteral = ConvertTo-PowerShellLiteral (Join-Path $MachineMemoryHome "setup-machine-memory.js")
  @"
`$env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY = "1"
`$env:BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS = $MachineMemoryAllowWideRootsLiteral
`$env:CODEX_HOME = $CodexHomeLiteral
`$env:GBRAIN_BIN = $GbrainBinLiteral
`$env:GBRAIN_HOME = $GbrainHomeParentLiteral
`$env:GBRAIN_MACHINE_ROOTS = $MachineMemoryRootsLiteral
`$env:GBRAIN_MACHINE_TERMINATE_SERVE = $MachineMemoryTerminateServeLiteral
`$env:GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS = $MachineMemorySyncTimeoutSecondsLiteral
`$env:GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS = $MachineMemoryGbrainTimeoutSecondsLiteral
& $NodeBinLiteral $MachineMemoryScriptLiteral sync-once
exit `$LASTEXITCODE
"@ | Set-Content -Encoding UTF8 $Runner
  Protect-LocalSecretPath $Runner

  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
  $LogonTrigger = New-ScheduledTaskTrigger -AtLogOn
  $IntervalMinutes = [Math]::Max(1, [int][Math]::Ceiling($MachineMemoryIntervalSeconds / 60))
  $RepeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
  $TaskName = "GBrain Machine Memory Sync"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($LogonTrigger, $RepeatTrigger) -Description "BridgeBrain source registration and recurring GBrain sync" | Out-Null
  if ($MachineMemorySyncNow) {
    Start-ScheduledTask -TaskName $TaskName
  }
}

Test-GBrainHome $GbrainHomeParent
Test-MachineMemoryRequest

if ($DryRun) {
  Write-DryRunPlan
  exit 0
}

if (-not $NodeBin) { Fail "Node.js is required. Install Node or set NODE_BIN." }
Test-NodeVersion $NodeBin
if (-not $CodexBin) { Fail "Codex CLI is required and must already be logged in with ChatGPT auth." }
if (-not $GbrainBin) {
  if (-not $InstallGBrain) { Fail "gbrain is missing. Install it first, or rerun with -InstallGBrain after Bun is installed." }
  $BunBin = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $BunBin) { Fail "Bun is missing. Install Bun first, then rerun -InstallGBrain." }
  Invoke-Checked "gbrain install" $BunBin @("install", "-g", $GbrainInstallSpec)
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
Invoke-Checked "bridge status" $NodeBin @((Join-Path $SkillDest "scripts\gpt-web-login-bridge.js"), "status")
Invoke-Checked "BridgeBrain GBrain patch" $NodeBin @((Join-Path $Root "scripts\patch-gbrain-litellm.js"))

$GbrainConfigDir = Join-Path $GbrainHomeParent ".gbrain"
$ConfigFile = Join-Path $GbrainConfigDir "config.json"
New-Item -ItemType Directory -Force -Path $GbrainConfigDir | Out-Null
Protect-LocalSecretPath $GbrainConfigDir
$ConfigExisted = Test-Path $ConfigFile
Invoke-Checked "GBrain config update" $NodeBin @((Join-Path $Root "scripts\configure-gbrain.js"), $ConfigFile, $ModelName, $Dimensions, $BaseUrl)
if (-not $ConfigExisted) {
  Invoke-Checked "GBrain init" $GbrainBin @("init", "--pglite", "--embedding-model", "litellm:$ModelName", "--embedding-dimensions", $Dimensions, "--skip-embed-check")
  Invoke-Checked "GBrain config update" $NodeBin @((Join-Path $Root "scripts\configure-gbrain.js"), $ConfigFile, $ModelName, $Dimensions, $BaseUrl)
}
Protect-LocalSecretPath $GbrainConfigDir
Protect-LocalSecretPath $ConfigFile

$Pages = "unknown"
try {
  $IdentityJson = & $GbrainBin @("call", "get_brain_identity", "{}")
  if ($LASTEXITCODE -eq 0 -and $IdentityJson) {
    $Identity = $IdentityJson | ConvertFrom-Json
    if ($null -ne $Identity.page_count) { $Pages = "$($Identity.page_count)" }
    elseif ($null -ne $Identity.pages) { $Pages = "$($Identity.pages)" }
    else { $Pages = "0" }
  }
} catch {
  $Pages = "unknown"
}
if ($Pages -ne "0" -and $Pages -ne "unknown") {
  Write-Warning "Existing GBrain pages detected: $Pages"
  Write-Warning "Config updated only. No database wipe or reinit was performed."
  Write-Warning "If existing embeddings use another width, run a supported migration/reindex before importing new content."
}

if (-not $SkipService) {
  $Runner = Join-Path $ServiceHome "run-bridgebrain.ps1"
  $PortLiteral = ConvertTo-PowerShellLiteral $Port
  $ProfileLiteral = ConvertTo-PowerShellLiteral $Profile
  $DimensionsLiteral = ConvertTo-PowerShellLiteral $Dimensions
  $ModelNameLiteral = ConvertTo-PowerShellLiteral $ModelName
  $TokenLiteral = ConvertTo-PowerShellLiteral $Token
  $CodexHomeLiteral = ConvertTo-PowerShellLiteral $CodexHome
  $BridgeScriptLiteral = ConvertTo-PowerShellLiteral (Join-Path $SkillDest "scripts\gpt-web-login-bridge.js")
  $CacheDirLiteral = ConvertTo-PowerShellLiteral (Join-Path $ServiceHome "cache")
  $CodexBinLiteral = ConvertTo-PowerShellLiteral $CodexBin
  $HomeLiteral = ConvertTo-PowerShellLiteral $HOME
  $NodeBinLiteral = ConvertTo-PowerShellLiteral $NodeBin
  $ServerLiteral = ConvertTo-PowerShellLiteral (Join-Path $ServiceHome "server.js")
  @"
`$env:GBRAIN_CHATGPT_EMBED_HOST = "127.0.0.1"
`$env:GBRAIN_CHATGPT_EMBED_PORT = $PortLiteral
`$env:GBRAIN_CHATGPT_EMBED_PROFILE = $ProfileLiteral
`$env:GBRAIN_CHATGPT_EMBED_DIMENSIONS = $DimensionsLiteral
`$env:GBRAIN_CHATGPT_EMBED_MODEL = $ModelNameLiteral
`$env:BRIDGEBRAIN_API_TOKEN = $TokenLiteral
`$env:BRIDGEBRAIN_ALLOW_PATH_TOKEN = "1"
`$env:CODEX_HOME = $CodexHomeLiteral
`$env:BRIDGE_SCRIPT = $BridgeScriptLiteral
`$env:CACHE_DIR = $CacheDirLiteral
`$env:GPT_WEB_LOGIN_CODEX_BIN = $CodexBinLiteral
`$env:GPT_WEB_LOGIN_CWD = $HomeLiteral
& $NodeBinLiteral $ServerLiteral
"@ | Set-Content -Encoding UTF8 $Runner
  Protect-LocalSecretPath $Runner

  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 30)
  $TaskName = "GBrain BridgeBrain Embeddings"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "BridgeBrain local GBrain embeddings service" | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

if (-not $SkipService) {
  Wait-BridgeBrainHealth $Port
  Wait-BridgeBrainAuthenticated $Port
}

if ($MachineMemory) {
  Install-MachineMemory
}

if (-not $SkipVerify) {
  Invoke-Checked "BridgeBrain verify" (Join-Path $Root "scripts\verify.ps1") @()
}

Write-Host "BridgeBrain installed."
Write-Host "Model: litellm:$ModelName"
Write-Host "Dimensions: $Dimensions"
Write-Host "Endpoint: http://127.0.0.1:$Port/v1/t/<redacted>"
if ($MachineMemory) {
  Write-Host "Machine memory sync: installed"
}
