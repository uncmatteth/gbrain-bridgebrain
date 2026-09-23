# Security boundaries

This is an owner-authorized local computer executor, **not an operating-system sandbox**. Enabling execution or desktop/browser control gives substantial access as that OS account. Use an unprivileged account; do not run as administrator/root. Only approve your own ChatGPT connection. A project file or website can contain hostile instructions: those are data, not permission to run commands or expose information.

## Protections implemented

- Read-only by default; separate local write, execution, browser and desktop grants.
- File tools restrict explicitly approved roots, reject whole-home/drive roots, traversal, symlinks, hard-linked files and common credential/Git-internal paths.
- Existing-file mutations require expected SHA-256 and preserve backups. No recursive file-tool deletion, force worktree removal or automatic deployment.
- Authenticated HTTP bound only to loopback; exact Host/Origin checks; bounded request size, concurrency and rate. Never put a token in a URL.
- OAuth PKCE S256, recognized exact callback registration, resource/client binding, local-only approval, one-use expiring codes, hashed access/refresh storage, rotating refresh and local revocation.
- HTTP tools advertise their real scopes and write/destructive annotations. Insufficient scope produces an OAuth challenge, not a hidden permission escalation. ChatGPT's own approval UI remains separate.
- No Codex subprocess, model provider, OpenAI model API call, automatic paid fallback, browser cookie/session import, or inspection of existing model credentials.
- Child environments omit inherited provider and tunnel credentials. This does not prevent an explicitly requested program from reading files or calling a paid service.
- Only this server's tracked live process trees are cancelled; arbitrary PID kill is not exposed. Retry IDs prevent accidental duplicate command execution. Stale jobs are never replayed on restart.
- Audit records contain operation, time, argument digest and result status, not plaintext input. Browser exception details are suppressed because they may contain typed data or URLs.

## Limitations you must account for

The allowlist applies to structured file tools. **Shell, Git execution, browser interaction and desktop control are trusted capabilities, not constrained by that allowlist.** They can read, modify, transmit or execute anything the OS user can. Enabling them is not appropriate for an untrusted client, and read-only OAuth scopes are not a confidentiality boundary between different projects on the same instance. Do not share an instance with other people.

Filesystem checks and optimistic hashes are not a kernel-enforced sandbox or a transaction against hostile concurrent local processes. Restrict local account access and do not treat symlink checks as protection from another process with the same user privileges. Git repositories can contain executable filters/configuration; inspect untrusted repositories before granting execution. Release hooks are not implicitly run by structured helpers.

Job output, backup bytes and checkpoints may contain private project data even though request arguments are not logged. They remain in the private state directory and must not be committed or uploaded. Each job log is capped, but total historical state is not automatically purged; review storage locally and preserve needed worktrees before cleanup. POSIX modes request private access; Windows account/ACL security must also be checked locally.

The temporary browser does not import existing profiles. Interactive websites and screenshots can still expose whatever is visibly on screen. Do not open password managers, authentication files or unrelated private material for a task. Handle login/MFA manually on the local computer. The bridge does not solve CAPTCHA or bypass website access controls.

HTTP's OAuth implementation is a limited, tested public-client implementation, not a general identity provider or a claim of certification. Public registration is bounded and accepts recognized ChatGPT callbacks only. Reverse-proxy/TLS integrity and tunnel authorization are operator responsibilities. Never remove authentication to work around a client error. A production deployment needs actual ChatGPT connection verification and OS-specific checks; unit tests are not an independent security audit.

Supported MCP revisions: 2025-11-25, 2025-06-18, 2025-03-26. JSONL stdio and JSON-response stateless Streamable HTTP support initialize/ping/tools/list/tools/call and ignore notifications without executing them. Optional MCP sampling, roots callbacks, resources, prompts, resumable SSE and later handshakes are not advertised. Tools do not change at runtime; restart/reconnect when changing local configuration or metadata.

The server does not grant OpenAI plan features, change billing, or let a user evade model/tool rate limits. Existing GBrain embeddings and the original model-login bridge remain separate and can still consume Codex allowance if independently running.
