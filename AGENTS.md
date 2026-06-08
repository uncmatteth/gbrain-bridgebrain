# Agent Install Instructions

This repo is intended to be installable by an agent on the target user's own machine. Keep the install boring, local, and explicit.

## Hard Boundaries

- Do not enable GitHub Actions, cloud CI, hosted runners, or paid remote automation.
- Do not read, copy, print, export, persist, or package Codex auth files, browser cookies, API keys, session files, GBrain databases, or local memory files.
- Do not scan the whole home folder, whole disk, external drives, dotfiles, Codex state, or GBrain data.
- Do not use Ollama, local embeddings, or a separate embedding API key as a substitute for this repo's Codex ChatGPT web-login bridge.
- Do not ask the user to paste secrets. If Codex is not logged in, stop and tell the user to log in with Codex on that machine.

## Preflight

Run these first from the repo root:

```bash
git status --short --branch
npm run package:guard
```

Then use the platform dry run:

```bash
scripts/install.sh --dry-run
```

Windows PowerShell:

```powershell
.\scripts\install.ps1 -DryRun
```

Dry run must not write files, start services, register GBrain sources, or sync anything.

## Prerequisites

Check the target machine before installing:

- Node.js 18 or newer: `node --version`
- Codex CLI: `codex --version`
- Codex ChatGPT login: let the installer's bridge status check verify it; never inspect auth files.
- GBrain: `gbrain --version`
- Bun, only if GBrain is missing and the user wants `--install-gbrain`: `bun --version`

If Node, Codex, or Bun is missing, install them with the target platform's normal package manager or official installer. Do not download random scripts, scrape browser state, or copy tools from another machine.

Use `--install-gbrain` only when Bun is already installed:

```bash
scripts/install.sh --install-gbrain
```

Windows PowerShell:

```powershell
.\scripts\install.ps1 -InstallGBrain
```

If GBrain is missing and Bun is not installed, stop and report that Bun must be installed first.

## Normal Install

After preflight passes and prerequisites are present:

```bash
scripts/install.sh --install-gbrain
```

Windows PowerShell:

```powershell
.\scripts\install.ps1 -InstallGBrain
```

The installer copies the bundled bridge skill into the current user's Codex home, installs the local embedding service, patches GBrain's LiteLLM compatibility check, writes GBrain provider config, starts the platform service, and runs verification.

## Machine Memory

Machine memory is off by default. Do not enable it unless the user explicitly asks for it and gives exact roots.

Required unlock:

```bash
BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 \
GBRAIN_MACHINE_ROOTS="$HOME/Documents/GitHub:$HOME/Projects" \
scripts/install.sh --machine-memory
```

Windows PowerShell:

```powershell
$env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY="1"
$env:GBRAIN_MACHINE_ROOTS="$HOME\Documents\GitHub;$HOME\source\repos"
.\scripts\install.ps1 -MachineMemory
```

Whole-home, whole-drive, and external-drive scans are blocked by default. Do not override that block unless the user explicitly accepts the scope.

## Release Guard

Before publishing or packaging, run:

```bash
npm run package:guard
npm pack --dry-run --json --ignore-scripts
```

Public publish is intentionally locked while `package.json` has `"private": true`. Only flip that in a reviewed release commit.
