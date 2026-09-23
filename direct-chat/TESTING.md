# Verification record

Verified September 23, 2026 in an isolated Linux build environment, not on the user's machines or inside a connected ordinary ChatGPT session.

## Results

- **41 Node tests passed**, zero failures/skips, with the optional real-browser test enabled.
- **7 Python tests passed**, zero failures/skips: six mocked desktop validation tests and one real Chromium in-memory interaction test.
- JavaScript syntax checks passed for core, transport and CLI.
- No Codex or model API was used by these tests. The core has no runtime npm dependency.

Commands from `direct-chat/`:

```bash
npm run check
BRIDGEBRAIN_UI_TESTS=1 BRIDGEBRAIN_TEST_CHROMIUM=/path/to/chromium npm run check
BRIDGEBRAIN_UI_TESTS=1 BRIDGEBRAIN_TEST_CHROMIUM=/path/to/chromium python3 -m unittest discover -s test -p 'test_*.py'
```

Omit the executable override when using Playwright's normal installed browser. Without `BRIDGEBRAIN_UI_TESTS=1`, optional real-browser tests explicitly skip; do not report them as passed.

Test environment: Node 22.16.0, Python 3.13, installed Chromium, Playwright 1.57.0, PyAutoGUI 0.9.54, Pillow 12.3.0. Pinned UI requirements reflect the tested environment, not a claim of newest available versions.

## Coverage

File CAS, concurrent/stale edits, exact replacements, binary limits/cursors, backups/restoration, credential/traversal/symlink/hardlink rejection, literal search boundaries, schema validation, permissions/pause, durable checkpoints, real process output/exit codes, deduplication, filtered provider environment, stdin/EOF, timeouts/cancellation, failed execution, selected-file Git commits, dirty-tree refusal and isolated permanent worktrees.

MCP JSON-RPC negotiation/validation, notification non-execution, stdio framing, loopback HTTP authentication, hostile Origin/Host rejection, protocol/header validation, real OAuth discovery/registration/local approval, PKCE/resource/client binding, one-use authorization code, hashed token storage, refresh rotation, read-only grant enforcement, expiry and revocation. CLI initialization/dry-run, no overwrite, no credential output, diagnostics, single-instance locking and lock release.

Real Chromium was started through the actual Node-to-Python MCP tool path; tabs, snapshot, screenshot image metadata and stop passed. Browser fill/click/select/upload/download and screenshots passed against an **in-memory HTML/Blob fixture** using the actual Python backend and real Chromium. Desktop key/coordinate/Wayland/ASCII validation used mocks and never moved a real mouse.

## Not verified

- Actual ordinary ChatGPT Pro custom-app eligibility, tool exposure, OAuth callback/refresh interoperability and usage-meter behavior.
- A live Secure MCP Tunnel, public HTTPS proxy or a connection to the user's computer.
- Real Mac/Windows desktop permissions, interactive Linux X11 desktop, multiple monitors or Windows process-tree cancellation.
- Network website navigation end to end. The build environment rejected Chromium navigation to localhost with `ERR_BLOCKED_BY_ADMINISTRATOR`; no policy bypass was attempted. Tests used in-memory fixtures instead. Target-machine navigation remains a deployment check.
- The pre-existing GBrain root suite/package guard. Original package files, installer, embedding code and whitelist are unchanged. The new `direct-chat/` package is outside the original root package whitelist and has its own tests. No GitHub Actions or paid runners were added.

This is repository implementation plus isolated runtime verification, not a claim that the user's ChatGPT session is already connected or that every proprietary Codex feature has been reproduced.
