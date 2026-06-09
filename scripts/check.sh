#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP_FILES=()
cleanup() {
  rm -f "${TMP_FILES[@]}"
}
trap cleanup EXIT

echo "JS syntax..."
JS_LIST="$(mktemp)"
TMP_FILES+=("$JS_LIST")
find src scripts bridge-skill -type f -name '*.js' | sort >"$JS_LIST"
while IFS= read -r file; do
  node --check "$file"
done < "$JS_LIST"

echo "Shell syntax..."
SH_LIST="$(mktemp)"
TMP_FILES+=("$SH_LIST")
find scripts -type f -name '*.sh' | sort >"$SH_LIST"
while IFS= read -r file; do
  bash -n "$file"
done < "$SH_LIST"

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

echo "GBrain update checker smoke..."
node scripts/test-gbrain-update-check.js

echo "Mock eval..."
node scripts/eval.js

echo "Live eval auth smoke..."
node scripts/test-eval-auth.js

echo "Hygiene scan..."
node scripts/hygiene-scan.js

echo "Release gate..."
node scripts/release-gate.js

echo "All local checks completed."
