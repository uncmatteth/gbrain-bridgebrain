# GBrain BridgeBrain

Local side-brain installer for GBrain: Codex ChatGPT-login embeddings, no Ollama, no GPU, no extra embedding API key.

BridgeBrain helps GBrain understand text well enough to search and remember useful context for agents. It installs a local embeddings service that talks to the target user's already-logged-in Codex CLI. It does not copy credentials, scrape browser cookies, scan the computer by default, or require a separate embedding provider.

Plain English: GBrain is the brain, BridgeBrain is the bridge that gives that brain useful embeddings through the user's own Codex ChatGPT login.

## Side Brain vs Main Brain

By default, this repo makes GBrain a **side brain**:

- GBrain gets a local embeddings endpoint.
- GBrain can search and store context better.
- Nothing scans the whole machine.
- Codex, OpenClaw, and other agents are not automatically rewired.
- Machine-memory sync is off unless explicitly enabled with exact roots.

To make GBrain a **main brain**, do that as a separate, explicit setup:

1. Install BridgeBrain and verify it works.
2. Point Codex, OpenClaw, or other agents at GBrain through their MCP/tool configuration.
3. Choose exact source roots to sync, such as specific repo folders.
4. Enable machine memory only with `BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1` and `GBRAIN_MACHINE_ROOTS=...`.
5. Verify each agent can query GBrain before adding broader sources.

That split is intentional. The public repo is safe by default; a personal machine can be wired deeper only when the owner asks for it.

## Give This Repo To An Agent

For another user's agent, the short instruction is:

```text
Read AGENTS.md first. Install this repo locally. Do not enable GitHub Actions or cloud CI. Do not inspect or copy auth files. Run package guard and dry-run first. Install missing platform prerequisites only through normal package managers or official installers. Stop if Codex is not logged in.
```

The agent-facing playbook is `AGENTS.md`. It tells the agent how to check Node, Codex, GBrain, and Bun; how to run dry-run; and where to stop instead of touching secrets.

## What It Ships

- Local `/v1/embeddings`, `/v1/models`, and `/health` HTTP service.
- Bundled `unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit` bridge skill.
- Default `quality` profile: `chatgpt-bridge-semantic-hash-1536`.
- Explicit `compat` fallback: `chatgpt-bridge-semantic-hash-768`.
- `mock` profile for CI and no-login tests.
- Linux user `systemd`, macOS `launchd`, and Windows Scheduled Task installers.
- Optional machine-memory source discovery and recurring GBrain sync.
- GBrain LiteLLM compatibility patch for model-id and dimension guards, with backups and hard failure if expected upstream code changed.
- Eval fixtures and recall/MRR scoring.
- Hygiene checks for public repo safety.

## What It Does Not Do

- No Ollama.
- No GPU embedding daemon.
- No extra embedding API key.
- No login automation.
- No credential copying.
- No shared ChatGPT account trick.
- No whole-computer scan by default.
- No automatic "main brain" wiring for Codex, OpenClaw, or other agents.
- No benchmark victory lap without data.

Every machine uses its own already-authenticated Codex ChatGPT login. BridgeBrain never reads, copies, prints, packages, or persists raw credentials. If Codex is not logged in, install stops instead of doing credential-handling bullshit.

## Architecture

```text
GBrain
  -> LiteLLM/OpenAI-compatible embedding route
  -> http://127.0.0.1:4127/v1
  -> BridgeBrain local Node.js adapter
  -> bundled ChatGPT web-login bridge skill
  -> local Codex CLI auth path
  -> structured semantic fingerprint
  -> deterministic feature hashing
  -> normalized 1536-dimensional vector
```

The adapter uses Node.js built-in modules only. It listens on loopback by default. It stores cache files keyed by source text hash and does not store raw source text, but cached semantic fingerprints are still derived data. Do not embed secrets unless provider exposure and derived local cache are acceptable.

## Install

If an agent is doing the install, read `AGENTS.md` first. It contains the no-secrets, no-cloud-CI, no-whole-disk-scan install rules and the exact preflight sequence.

Prereqs:

- Node.js 18+.
- Codex CLI installed and already logged in with ChatGPT auth.
- GBrain installed, or Bun installed if you want `--install-gbrain`.
  The optional installer path pins GBrain to a reviewed commit by default; set `GBRAIN_INSTALL_SPEC` only if you intentionally want a different GBrain source.

Linux or macOS:

```bash
git clone https://github.com/<owner>/gbrain-bridgebrain.git
cd gbrain-bridgebrain
scripts/install.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/<owner>/gbrain-bridgebrain.git
cd gbrain-bridgebrain
.\scripts\install.ps1
```

The installer copies the bundled bridge skill into the current user's Codex home, installs the adapter service, patches GBrain's LiteLLM model-id check, configures GBrain, and runs verification.

It also generates a per-install local token. GBrain's LiteLLM base URL is written as `http://127.0.0.1:<port>/v1/t/<generated-token>`, and the installed service explicitly sets `BRIDGEBRAIN_ALLOW_PATH_TOKEN=1` so that GBrain-compatible tokenized path works. Do not publish that local config or service file.

If you use a non-default GBrain home, set `GBRAIN_HOME` to GBrain's parent directory before installing and verifying. The config file is `$GBRAIN_HOME/.gbrain/config.json`.

If GBrain already has pages, the installer does not wipe the brain. It updates provider config and reports that a supported migration or reindex is needed if existing embeddings use another width.

## Dry Run

Use dry run before testing an installer on a real machine:

```bash
scripts/install.sh --dry-run
```

Windows PowerShell:

```powershell
.\scripts\install.ps1 -DryRun
```

Dry run validates inputs and prints a redacted plan. It does not write files, patch GBrain, install services, create Scheduled Tasks, run verification, register sources, or sync anything.

## Machine Memory

BridgeBrain can also install a recurring GBrain source sync job. This is explicit because it sends syncable repo content through the configured embedding path.

Linux or macOS:

```bash
BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 \
GBRAIN_MACHINE_ROOTS="$HOME/Documents/GitHub:$HOME/Projects" \
GBRAIN_MACHINE_TERMINATE_SERVE=none \
scripts/install.sh --machine-memory
```

Windows PowerShell:

```powershell
$env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY="1"
$env:GBRAIN_MACHINE_ROOTS="$HOME\Documents\GitHub;$HOME\source\repos"
$env:GBRAIN_MACHINE_TERMINATE_SERVE="none"
.\scripts\install.ps1 -MachineMemory
```

Use `--machine-memory-sync-now` or `-MachineMemorySyncNow` to run the first sync immediately. The runner discovers git repositories under explicit `GBRAIN_MACHINE_ROOTS`, registers missing GBrain sources, confirms active non-archived sources before sync, and syncs requested sources with GBrain's official sync command: `gbrain sync --source <id> --yes`. Normal sync requires `--source <id>`; use `--all-sources` only when you intentionally want every matching source under the selected roots. The runner streams GBrain output to the terminal and prints source count, elapsed time, and estimated remaining time before and after each source. It skips hidden/vendor directories during discovery, has no default roots, and blocks whole-home/root scans unless `BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1` is set after review.

`GBRAIN_SYNC_TRACE=1` is enabled by default during machine-memory sync so a stalled import names the file being processed; set `GBRAIN_MACHINE_SYNC_TRACE=0` to disable it. Use `--no-schema-pack` only as GBrain's documented escape hatch for suspected schema-pack regex stalls.

The installer also patches known GBrain CLI compatibility points needed by this setup: LiteLLM user-provided model IDs and BridgeBrain embedding dimensions. If upstream GBrain changes those files, install stops instead of applying a guessed patch.

On PGLite, long-running stdio `gbrain serve` processes can hold the database lock. The default is `GBRAIN_MACHINE_TERMINATE_SERVE=none`. On Linux/macOS, set `GBRAIN_MACHINE_TERMINATE_SERVE=all` only on machines where scheduled sync is allowed to interrupt active GBrain MCP sessions; Codex can respawn MCP after sync. Windows does not support that mode; leave it `none` and stop `gbrain serve` manually before scheduled sync if needed.

## GBrain Updates

GBrain moves fast. BridgeBrain includes a guarded update helper so the BridgeBrain boost can keep pace with upstream GBrain without surprise upgrades.

Check for new upstream GBrain commits:

```bash
npm run gbrain:update:check
```

The check reads `garrytan/gbrain`'s upstream `HEAD` commit and records the last seen commit in a small local state file under the user's GBrain home. It does not upgrade GBrain, patch files, run sync, scan source roots, or touch the brain database. For a read-only check:

```bash
npm run gbrain:update:check -- --no-write-state
```

Apply an update only after review:

```bash
npm run gbrain:update:apply
```

The apply command is intentionally strict:

- runs `gbrain doctor --json` before the upgrade;
- runs BridgeBrain adapter tests and package guard before the upgrade;
- writes a timestamped local backup outside this repo;
- runs `gbrain upgrade`;
- reapplies the BridgeBrain LiteLLM compatibility patch;
- runs `gbrain doctor --json` again;
- runs the full repo check after the upgrade.

By default, the backup is metadata-only: manifest plus a redacted GBrain config summary. It does not copy the GBrain database, local memory files, raw provider tokens, or unknown config fields. Full data snapshots are intentionally outside the public workflow; make one only after a direct local operator request, to a private local path, and never package or publish it.

If doctor or tests fail, the upgrade stops. If a post-upgrade gate fails, the command prints the backup path and stops instead of silently rolling back a live local brain.

## Compatibility Mode

Default is 1536 dimensions:

```text
litellm:chatgpt-bridge-semantic-hash-1536
```

Use 768 only when you need an existing smaller schema:

```bash
BRIDGEBRAIN_PROFILE=compat \
GBRAIN_CHATGPT_EMBED_MODEL=chatgpt-bridge-semantic-hash-768 \
GBRAIN_CHATGPT_EMBED_DIMENSIONS=768 \
scripts/install.sh
```

PowerShell:

```powershell
$env:BRIDGEBRAIN_PROFILE="compat"
$env:GBRAIN_CHATGPT_EMBED_MODEL="chatgpt-bridge-semantic-hash-768"
$env:GBRAIN_CHATGPT_EMBED_DIMENSIONS="768"
.\scripts\install.ps1
```

## Verify

Linux or macOS:

```bash
scripts/verify.sh
```

Windows:

```powershell
.\scripts\verify.ps1
```

Repo-local checks:

```bash
npm test
npm run eval
npm run hygiene
npm run package:guard
npm run check
```

`npm test` uses mock mode and does not require ChatGPT login. Live install verification does require the local Codex ChatGPT login because that is the whole point.

For release privacy checks, keep exact private strings outside the repo and scan them with:

```bash
BRIDGEBRAIN_PRIVATE_BLOCKLIST=/path/to/private-blocklist.txt npm run hygiene
```

The blocklist file is one fixed string per line. The scan reports matching files without printing the private strings back to the terminal.

## Benchmark It

Mock eval:

```bash
node scripts/eval.js
```

Live eval against an installed BridgeBrain service reads GBrain's configured LiteLLM base URL by default:

```bash
node scripts/eval.js --live
```

In live mode, you can override the target with `BRIDGEBRAIN_EVAL_BASE_URL` and pass the local token with `BRIDGEBRAIN_API_TOKEN` or `GBRAIN_CHATGPT_EMBED_TOKEN`. Mock mode ignores `BRIDGEBRAIN_EVAL_BASE_URL` and always uses a spawned loopback service.

The eval prints recall@K and MRR. The bundled fixture is small on purpose: it proves the harness works. Bring a better corpus, submit results, and break the damn thing in public.

## Security Boundary

BridgeBrain sends text being embedded through the already-authenticated provider account via Codex. It does not make provider submission private from the provider. It does keep raw credentials out of the repo and out of the adapter.

The bundled bridge passes prompt text through stdin, not command-line args, and disables the child Codex shell/browser/app/search tool surfaces before model calls.

Embedding POSTs require the per-install local token. The server default prefers `Authorization: Bearer <token>`; the installer enables tokenized `/v1/t/<token>/...` compatibility with `BRIDGEBRAIN_ALLOW_PATH_TOKEN=1` because GBrain stores a provider base URL. Header auth is cleaner when the caller can set headers.

Never publish:

- Codex auth material.
- Browser cookies.
- API keys.
- Raw tokens.
- Session databases.
- GBrain databases or caches.
- Local private memory files.

See `SECURITY.md` for the full boundary.

## Files

- `src/gbrain-chatgpt-embeddings-server.js` - local embeddings adapter.
- `bridge-skill/` - bundled ChatGPT web-login bridge skill.
- `scripts/install.sh` - Linux/macOS installer.
- `scripts/install.ps1` - Windows installer.
- `scripts/setup-machine-memory.js` - source discovery, source registration, and serial sync runner using GBrain's resumable per-source timeout.
- `scripts/verify.sh` and `scripts/verify.ps1` - install verification.
- `scripts/patch-gbrain-litellm.js` - safe GBrain compatibility patch.
- `scripts/test-adapter.js` - no-login adapter smoke test.
- `scripts/test-bridge.js` - bridge stdin/no-shell-tool smoke test.
- `scripts/eval.js` - recall/MRR eval harness.
- `scripts/hygiene-scan.js` - public-release hygiene scan.
- `scripts/hygiene-scan.sh` - optional POSIX wrapper for the Node hygiene scan.
- `systemd/` and `launchd/` - user service and machine-sync templates.
- `evals/` - fixture corpus and query set.
- `AGENTS.md` - agent install playbook and hard boundaries.

## Agent Boundary

Give an agent this repo plus `AGENTS.md`, `README.md`, `SECURITY.md`, and `CONTRIBUTING.md`. Do not put private handoffs, local paths, logs, tokens, GBrain data, Codex state, or machine scan output in this public repo.

## License

MIT.
