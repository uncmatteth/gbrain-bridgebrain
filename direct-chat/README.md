# BridgeBrain Direct Chat

**Regular ChatGPT does the thinking. These tools execute directly on your own computer.**

This is a standalone local MCP tool server, not a model-login proxy. It never invokes Codex, never sends a model API request, never extracts your ChatGPT login, and has no paid-model fallback. Select it in an ordinary ChatGPT conversation when your account supports custom tool actions.

The original long-name `gpt-web-login-bridge.js` remains unchanged because the existing GBrain embedding service depends on it. **That old service still uses Codex if you run it.** Use this `direct-chat/` package, not the old `ask` command, for direct computer work. This package does not install, stop, reconfigure, or replace GBrain.

## Implemented capabilities

| Area | Direct tools |
| --- | --- |
| Projects | Actual machine identity, approved project roots, AGENTS.md and Git context |
| Files | List, literal search, read, create, exact edit, delete, SHA-256 conflict checks, backups and restoration |
| Execution | Local commands/scripts, eight concurrent jobs, real exit status, output cursors, stdin, timeouts and owned-process cancellation |
| Git | Status, diff, log, branches, selected-file commits, permanent isolated worktrees |
| Continuity | Saved, revision-checked project handoffs that another chat can read |
| Artifacts | Binary byte-range reads/writes and PNG/JPEG/WebP viewing |
| Browser | Optional Playwright tabs, navigation, page inspection, screenshots, click/fill/keys, select, upload/download |
| Desktop | Optional primary-screen screenshots, mouse, keys and ASCII typing through PyAutoGUI |
| Connection | JSONL stdio or authenticated, loopback-only Streamable HTTP; OAuth/PKCE local approval; pause and revoke |

There are 26 tool names; browser and desktop each expose multiple operations. Tool schemas are returned by `tools/list` rather than guessed from this table.

## What this does not promise

This is **not a clone of every proprietary Codex feature**. It cannot grant ChatGPT account entitlements, change usage limits or billing, increase model context, supply OpenAI's native computer-use engine, run independent AI subagents for free, or make ChatGPT continue reasoning after a turn ends. Parallel jobs are OS processes, not extra models. Stdin is pipe-based, not a pseudo-terminal.

The bridge itself makes zero model requests. ChatGPT/tool/tunnel/service limits still apply. A script you explicitly execute could call an external paid service; this bridge does not inspect or neutralize arbitrary scripts. Direct invocation of common AI CLIs is refused to prevent accidental fallback, but that check is not a sandbox.

A repository change cannot automatically attach tools to the current conversation. **A live connection must pass the verification below on the target machine and in the actual ChatGPT account.** Do not relabel write tools as read-only to bypass account restrictions.

## 1. Initialize on the target computer

Use an up-to-date supported Node.js runtime (minimum 18.17) and Git. File, command, Git and transport tools have no npm runtime dependencies. Work from this directory:

```bash
cd /path/to/gbrain-bridgebrain/direct-chat
node cli.js init --root project=/absolute/path/to/your/project --trusted-computer
node cli.js doctor
npm run check
```

Replace the project path. Repeat `--root name=PATH` for other explicitly authorized projects, or approve your projects directory as a single root. Do not use your entire home directory or drive. A dry run writes nothing:

```bash
node cli.js init --root project=/absolute/path/to/your/project --trusted-computer --dry-run
```

`--trusted-computer` explicitly enables file changes, commands, browser and desktop actions **as your OS user**, not in a security sandbox. Omit it for read-only, or select `--allow-write`, `--allow-exec`, `--allow-browser`, and `--allow-desktop` individually. Existing configs are never overwritten. On Windows, quote paths containing spaces; the same Node CLI works in PowerShell.

Default configuration: `~/.bridgebrain-direct/config.json`. Private operational state lives beside it in `state/`, outside approved projects. `--config PATH` supports separate instances. Do not put configuration/state into a repository or upload it. Do not copy another computer's config or pairing tokens.

## 2. Connect ordinary ChatGPT: choose one transport

### A. OpenAI Secure MCP Tunnel with stdio

Where your account/workspace offers Secure MCP Tunnel, use the official `tunnel-client` and its local-stdio profile. The MCP command is:

```bash
node /absolute/path/to/gbrain-bridgebrain/direct-chat/cli.js serve --stdio
```

OpenAI's documented setup uses a tunnel ID and a **tunnel runtime credential**. That is a transport credential, not a model request; this package does not call the Responses API. Obtain and enter it locally using the official setup, never in chat or this repository. Check current tunnel availability and any service limits rather than assuming it is included or unlimited.

Typical official client commands, after creating the tunnel in its settings:

```bash
tunnel-client help quickstart
tunnel-client init --sample sample_mcp_stdio_local --profile local-stdio --tunnel-id YOUR_TUNNEL_ID --mcp-command "node /absolute/path/to/gbrain-bridgebrain/direct-chat/cli.js serve --stdio"
tunnel-client doctor --profile local-stdio --explain
tunnel-client run --profile local-stdio
```

Use the Tunnel connection option when adding the custom app in ChatGPT. This route does not require publicly forwarding a local port or this package's HTTP OAuth. Tunnel access/revocation is managed by the tunnel service; the local `pause` command still applies.

### B. Your HTTPS tunnel/reverse proxy with this package's OAuth

Use an HTTPS tunnel or reverse proxy you control, forwarding to loopback port 8768. Do not expose an unauthenticated shell, bind to all interfaces, or put bearer credentials in a URL. The forwarding service is not installed or purchased by this package.

```bash
node cli.js set-public-url https://YOUR-HTTPS-HOST
node cli.js serve --http
```

In ChatGPT custom-app/developer settings, add `https://YOUR-HTTPS-HOST/mcp` using **OAuth**, with dynamic client registration if offered. The server supplies discovery metadata. It requires PKCE S256, binds grants to the MCP resource, and supports public clients with the recognized ChatGPT callback paths. It never asks for a ChatGPT password or imports browser state.

During connection, the browser shows a short-lived pairing request and its scopes. Only approve a connection you just initiated. On the **target computer**, from this directory, run the exact `node cli.js approve REQUEST_ID` command shown. For a non-default config, append `--config PATH`. Return to the pairing page; it completes the callback after approval. Pair each machine separately.

The generic callback paths currently accepted are `/connector_platform/oauth_redirect` and `/aip/<id>/oauth/callback` on `chatgpt.com` or `chat.openai.com`. Exact redirects must match registration. An unrecognized callback fails closed; investigate actual client requirements rather than weakening the check to arbitrary domains.

Changing the public URL revokes existing HTTP grants. Restart, then reconnect. Access tokens expire after 15 minutes; refresh tokens rotate and expire after 30 days. Local approval expires after five minutes. Keep both the bridge and selected transport running while working.

### Account compatibility is a real gate

OpenAI's developer-mode documentation describes read/write custom MCP tools for Pro and other eligible accounts. A Help Center article has described narrower Pro read/fetch support. These are not consistent guarantees for every rollout. The actual ordinary-Chat tool list and a user-approved write test decide whether your account can use this path. This server cannot fix a missing entitlement or change which allowance a ChatGPT mode uses. Do not silently substitute Codex or Work.

Sources checked September 23, 2026:

- https://developers.openai.com/api/docs/guides/developer-mode
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/build/auth
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## 3. Verify the actual connection

In ordinary Chat, explicitly select the connected app and ask it to:

1. Call `bridge_status` and `project_list`; report the machine identity and selected project, not an inferred path.
2. Read `project_context` and relevant nested AGENTS.md instructions.
3. With your approval, create a harmless new test file using `file_write`, read it back, and delete it with the returned SHA-256.
4. Run a harmless local command with `command_start`, then use `job_read` until a real exit code is available.

Success means those tool calls actually returned results from that machine. An installed icon, a saved ChatGPT login, `doctor`, or a claimed connection is not enough. If tools are missing, diagnose the app/transport/account selection; do not say work happened and do not launch a different model.

## Optional browser and desktop dependencies

Use an isolated Python environment rather than altering system Python:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-ui.txt
.venv/bin/python -m playwright install chromium
```

Pass `--python /absolute/path/to/.venv/bin/python` during init, or explicitly update that field locally in your existing config. On Windows use `python -m venv .venv` and `.venv\Scripts\python.exe`. `--chromium-executable PATH` is an optional local override; normally Playwright uses its installed Chromium. Linux may also need Playwright's documented system dependencies.

Browser sessions are separate and temporary: existing browser cookies, profiles and ChatGPT logins are not loaded or exported. Manually sign in to a website only when the task requires it; closing the session does not preserve that login. Browser screenshots include coordinate dimensions; clicks use DOM selectors.

Desktop control needs a visible session and OS grants. On macOS, grant the actual Python/terminal process Screen Recording and Accessibility. On Windows, use the logged-in interactive desktop, not a locked screen or service session. The included Linux desktop backend supports X11, **not Wayland**. It covers the primary display only; desktop typing is ASCII (browser fill supports Unicode). Desktop screenshots include native and image dimensions so coordinates can be scaled. PyAutoGUI's failsafe stays enabled.

## Working conventions

Keep established render jobs in the actual project checkout with their existing recordings, dependencies and environment. A new worktree does not magically copy ignored assets. Worktrees created by this bridge are permanent until explicitly removed; dirty worktrees cannot be removed and branches are never force-deleted.

A command is an executable/argument array, not an automatically interpreted shell string. Use `bash -lc` or PowerShell explicitly when needed; on Windows, `.cmd` scripts such as npm may require `cmd.exe /d /s /c`. Commands inherit a reduced environment without provider keys, and may still read files available to the OS user. Preserve project secrets locally. Git commit helpers disable hooks and external diff helpers; run project tests/release gates explicitly before committing. Pushes and deployments are not automatic.

Use a unique `request_id` for each intended command. Retries with the same ID and arguments return the original job. Output is capped at 32 MiB per job, with cursors. Default timeout is ten minutes; set `timeout_seconds` explicitly for long renders (maximum one day). Shutdown cancels owned jobs. After a crash, interrupted jobs are reported as interrupted, never silently restarted; an OS process may outlive an abrupt crash and requires local inspection.

Save a checkpoint before moving to another chat. That stores an explicit handoff; it does not increase context or synchronize automatic memory. GUI operations are serialized to avoid simultaneous clicks. User-approved commands may still conflict with each other: use separate worktrees for independent code writers.

## Stop, pause, revoke, remove

```bash
node cli.js pause
node cli.js resume
node cli.js revoke
```

Pause blocks new tool calls, not already-running processes. Use owned-job cancellation before pausing when needed. Ctrl+C stops the server and attempts to cancel its owned jobs. Revoke invalidates HTTP tokens/registrations, not an independently managed tunnel credential. Stop/revoke the tunnel in its own settings too. No startup service is installed. To remove, stop the server/transport and remove this package and its private state after preserving any wanted worktrees/backups.

Read [SECURITY.md](SECURITY.md) and [TESTING.md](TESTING.md) for boundaries and verification evidence.
