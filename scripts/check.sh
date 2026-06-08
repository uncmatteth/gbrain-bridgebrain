#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "JS syntax..."
while IFS= read -r file; do
  node --check "$file"
done < <(find src scripts bridge-skill -type f -name '*.js' | sort)

echo "Shell syntax..."
while IFS= read -r file; do
  bash -n "$file"
done < <(find scripts -type f -name '*.sh' | sort)

echo "PowerShell syntax..."
if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -Command '$ErrorActionPreference="Stop"; foreach ($f in @("scripts/install.ps1","scripts/verify.ps1")) { if (Test-Path -LiteralPath $f) { [scriptblock]::Create((Get-Content -LiteralPath $f -Raw)) > $null } }'
elif command -v powershell >/dev/null 2>&1; then
  powershell -NoProfile -Command '$ErrorActionPreference="Stop"; foreach ($f in @("scripts/install.ps1","scripts/verify.ps1")) { if (Test-Path -LiteralPath $f) { [scriptblock]::Create((Get-Content -LiteralPath $f -Raw)) > $null } }'
else
  echo "PowerShell not available; Windows installer syntax not locally parsed."
fi

echo "Adapter mock smoke..."
node scripts/test-adapter.js

echo "Bridge CLI smoke..."
node scripts/test-bridge.js

echo "Installer smoke..."
node scripts/test-installers.js

echo "Mock eval..."
node scripts/eval.js

echo "Live eval auth smoke..."
node scripts/test-eval-auth.js

echo "Hygiene..."
scripts/hygiene-scan.sh

echo "All local checks completed."
