'use strict';

// This is a tool executor, not a model client. Shell access is an explicit trust
// grant, NOT an operating-system sandbox. See SECURITY.md before enabling it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = () => crypto.randomUUID();
const LIMIT = 2 * 1024 * 1024;
const PROTECTED = /(^|\/)(\.git|\.ssh|\.gnupg|\.aws|\.azure|\.codex|\.gbrain|\.openclaw|\.kube|\.config|\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|cookies(?:\..*)?|session(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)|[^/]*\.(?:pem|key|p12|pfx|sqlite3?|db))($|\/)/i;
const SKIP = new Set(['node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build', '.cache']);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
function fail(message) { throw new Error(message); }
function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function jsonRead(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function atomic(file, data, mode = 0o600) {
  const tmp = `${file}.${uuid()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function jsonWrite(file, data) { atomic(file, `${JSON.stringify(data, null, 2)}\n`); }
function cleanEnv(extra = {}) {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'];
  const env = {};
  for (const key of names) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(OPENAI|CODEX|ANTHROPIC|BRIDGEBRAIN|CONTROL_PLANE|NODE_OPTIONS|PYTHONPATH|LD_|DYLD_)/i.test(key)) fail('Sensitive/provider/runtime environment overrides are not accepted');
    if (typeof value !== 'string' || value.includes('\0')) fail('Environment values must be NUL-free strings');
    env[key] = value;
  }
  return env;
}
const str = (maxLength = 16384) => ({ type: 'string', maxLength });
const num = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const arr = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const enumeration = (...values) => ({ type: 'string', enum: values });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const bool = { type: 'boolean' };
function validate(schema, value, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
    for (const key of schema.required || []) if (!(key in value)) fail(`${label}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`Unexpected ${label}.${key}`);
      validate(schema.properties[key], item, `${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail(`${label} has invalid array size`);
    value.forEach((item, index) => validate(schema.items, item, `${label}[${index}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) fail(`${label} is outside its integer range`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.includes('\0') || value.length > (schema.maxLength || LIMIT)) fail(`${label} must be a bounded NUL-free string`);
    if (schema.enum && !schema.enum.includes(value)) fail(`${label} has an invalid value`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail(`${label} must be boolean`);
}

class DirectBridge {
  constructor(config, configFile) {
    this.config = config;
    this.configFile = configFile;
    this.state = path.resolve(config.stateDir);
    privateDir(this.state);
    for (const dir of ['jobs', 'backups', 'checkpoints', 'worktrees', 'empty-hooks']) privateDir(path.join(this.state, dir));
    this.id = config.instanceId;
    this.projects = new Map();
    for (const entry of config.projects || []) this.addProject(entry.id, entry.path);
    if (!this.projects.size) fail('At least one explicitly approved project root is required');
    this.worktreeFile = path.join(this.state, 'worktrees.json');
    this.worktrees = jsonRead(this.worktreeFile, {});
    for (const [id, entry] of Object.entries(this.worktrees)) {
      if (inside(path.join(this.state, 'worktrees'), entry.path) && fs.existsSync(entry.path)) this.projects.set(id, fs.realpathSync(entry.path));
    }
    this.jobs = new Map();
    this.dedupe = new Map();
    this.locks = new Map();
    this.tools = [];
    this.handlers = new Map();
    this.helper = null;
    this.helperPending = new Map();
    this.helperSeq = 0;
    this.helperQueue = Promise.resolve();
    this.registerTools();
  }
  recoverJobs() {
    // Call only after the single-instance server lock is acquired, never from
    // doctor, OAuth approval, or another read-only CLI command.
    for (const name of fs.readdirSync(path.join(this.state, 'jobs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const job = jsonRead(path.join(this.state, 'jobs', name), null);
      if (job && job.status === 'running') { job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); this.saveJob(job); }
    }
  }
  addProject(id, root) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || this.projects.has(id)) fail('Project IDs must be unique simple names');
    const real = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(real).isDirectory()) fail('Project root is not a directory');
    if (inside(real, os.homedir()) || real === path.parse(real).root || inside(real, this.state) || inside(this.state, real)) fail('Whole-home, whole-drive and bridge-state project roots are forbidden');
    if (PROTECTED.test(real.replaceAll(path.sep, '/'))) fail('Sensitive directories cannot be project roots');
    this.projects.set(id, real);
  }
  project(id) { const root = this.projects.get(id); if (!root) fail(`Unknown project: ${id}. Call project_list first.`); if (fs.realpathSync(root) !== root) fail('Project root was replaced by a symlink'); return root; }
  enabled(permission) {
    const current = this.configFile ? jsonRead(this.configFile, this.config) : this.config;
    if (current.paused) fail('Bridge is paused locally');
    if (permission !== 'read' && !current.permissions?.[permission]) fail(`${permission} is disabled. Only the local operator can enable it.`);
  }
  resolve(id, relative = '.', { allowRoot = false } = {}) {
    const root = this.project(id);
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').includes('..')) fail('Use a project-relative path without traversal');
    if (PROTECTED.test(relative)) fail('Sensitive/authentication/Git-internal paths are blocked');
    const target = path.resolve(root, relative);
    if (!inside(root, target) || (!allowRoot && target === root)) fail('Path must be inside the project, not its root');
    if (inside(this.state, target) && !this.worktrees[id]) fail('Bridge state is not exposed');
    let current = root;
    for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) fail('Symlinks are not followed by file tools');
        if (stat.isFile() && stat.nlink > 1) fail('Hard-linked files are not exposed by file tools');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  readBytes(id, relative) {
    const file = this.resolve(id, relative);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LIMIT) fail('Expected a regular file no larger than 2 MiB');
    return fs.readFileSync(file);
  }
  audit(tool, args, outcome) {
    const record = { at: new Date().toISOString(), tool, argumentHash: hash(JSON.stringify(args)), outcome };
    const file = path.join(this.state, 'audit.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 4 * LIMIT) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
  async locked(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  backup(project, relative, bytes) {
    const id = uuid();
    const base = path.join(this.state, 'backups', id);
    fs.writeFileSync(`${base}.data`, bytes, { mode: 0o600, flag: 'wx' });
    jsonWrite(`${base}.json`, { project, path: relative, sha256: hash(bytes), at: new Date().toISOString() });
    return id;
  }
  writeFile(a) {
    return this.locked(`file:${a.project}:${a.path}`, () => {
      const file = this.resolve(a.project, a.path);
      let prior = null;
      try { prior = this.readBytes(a.project, a.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const current = prior === null ? '' : hash(prior);
      if (a.expected_sha256 !== current) fail('File changed or already exists. Read it again and supply the current SHA-256.');
      const bytes = a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : Buffer.from(a.content, 'utf8');
      if (a.encoding === 'base64' && bytes.toString('base64') !== a.content) fail('Base64 must be canonical');
      if (bytes.length > LIMIT) fail('File is larger than 2 MiB');
      if (!fs.existsSync(path.dirname(file))) fail('Parent directory is missing. Use file_mkdir first.');
      const backupId = prior === null ? null : this.backup(a.project, a.path, prior);
      const mode = prior === null ? 0o600 : fs.statSync(file).mode & 0o777;
      atomic(file, bytes, mode);
      return { project: a.project, path: a.path, bytes: bytes.length, sha256: hash(bytes), backup_id: backupId };
    });
  }
  tool(name, description, schema, permission, readOnly, handler) {
    this.tools.push({ name, description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: ['exec', 'browser', 'desktop'].includes(permission) } });
    this.handlers.set(name, { schema, permission, handler });
  }
  async call(name, args = {}, scopes = null) {
    const entry = this.handlers.get(name);
    if (!entry) fail(`Unknown tool: ${name}`);
    validate(entry.schema, args);
    this.enabled(entry.permission);
    if (scopes && name === 'browser' && args.operation === 'download' && !scopes.includes('bridge.write')) fail('OAuth grant lacks bridge.write for downloads');
    if (scopes && !scopes.includes(`bridge.${entry.permission}`)) fail(`OAuth grant lacks bridge.${entry.permission}`);
    try {
      const value = await entry.handler(args);
      this.audit(name, args, 'ok');
      return value;
    } catch (error) { this.audit(name, args, 'error'); throw error; }
  }
  registerTools() {
    const p = { project: str(64) }, f = { ...p, path: str(1024) };
    const add = (...args) => this.tool(...args);
    add('bridge_status', 'Use first to identify the actual machine, granted capabilities and no-model-call architecture. Does not claim ChatGPT plan eligibility.', obj({}), 'read', true, () => ({
      instance_id: this.id, hostname: os.hostname(), platform: process.platform, node: process.version,
      permissions: (this.configFile ? jsonRead(this.configFile, this.config) : this.config).permissions, projects: [...this.projects.keys()], model_provider: null,
      invokes_codex: false, makes_model_api_calls: false, chatgpt_entitlements: 'controlled by ChatGPT, not this server',
      execution_boundary: 'commands and GUI run as the local OS user; file allowlists are not a shell sandbox',
    }));
    add('project_list', 'List only roots explicitly selected by the local operator. Never searches the home folder.', obj({}), 'read', true, () => [...this.projects].map(([id, root]) => ({ id, root, permanent_worktree: !!this.worktrees[id] })));
    add('project_context', 'Read bounded root AGENTS.md and project identity before making changes. Nested instructions must also be read before editing their directories.', obj(p, ['project']), 'read', true, async a => {
      let instructions = null;
      try { instructions = this.readBytes(a.project, 'AGENTS.md').toString('utf8').slice(0, 32000); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let git;
      try { git = await this.git(a.project, ['status', '--short', '--branch']); } catch { git = { error: 'Not a usable Git repository' }; }
      return { instance_id: this.id, project: a.project, cwd: this.project(a.project), instructions, git };
    });
    add('file_list', 'List a project directory without following links or exposing credential files.', obj({ ...f, limit: num(1, 500) }, ['project']), 'read', true, a => {
      const dir = this.resolve(a.project, a.path || '.', { allowRoot: true });
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !PROTECTED.test(e.name) && !e.isSymbolicLink()).sort((x, y) => x.name.localeCompare(y.name));
      return { entries: entries.slice(0, a.limit || 200).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > (a.limit || 200) };
    });
    add('file_read', 'Read a bounded text file with SHA-256 for safe editing, or a base64 byte range for artifacts. Authentication files are never exposed.', obj({ ...f, encoding: enumeration('utf8', 'base64'), offset: num(0, Number.MAX_SAFE_INTEGER), length: num(1, LIMIT) }, ['project', 'path']), 'read', true, a => {
      const file = this.resolve(a.project, a.path);
      const stat = fs.statSync(file);
      if (!stat.isFile()) fail('Expected a regular file');
      if (a.encoding !== 'base64') {
        const bytes = this.readBytes(a.project, a.path);
        if (bytes.includes(0)) fail('Binary file: request base64 instead');
        return { path: a.path, content: bytes.toString('utf8'), sha256: hash(bytes), bytes: bytes.length };
      }
      const offset = a.offset || 0;
      const buffer = Buffer.alloc(Math.min(a.length || 65536, Math.max(0, stat.size - offset)));
      const fd = fs.openSync(file, 'r');
      let count; try { count = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
      return { content: buffer.subarray(0, count).toString('base64'), offset, next_offset: offset + count, total_bytes: stat.size, eof: offset + count >= stat.size };
    });
    add('file_search', 'Search literal text inside the selected project only; bounded and skips dependency, build, credential and binary files.', obj({ ...p, query: str(4096), path: str(1024), limit: num(1, 200), case_sensitive: bool }, ['project', 'query']), 'read', true, a => {
      if (!a.query) fail('Search text must not be empty');
      const matches = []; let examined = 0; let directories = 0; let truncated = false;
      const visit = (relative, depth = 0) => {
        if (++directories > 10000 || depth > 64 || examined >= 10000 || matches.length >= (a.limit || 100)) { truncated = true; return; }
        const dir = this.resolve(a.project, relative, { allowRoot: true });
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (examined >= 10000 || matches.length >= (a.limit || 100)) { truncated = true; break; }
          if (entry.isSymbolicLink() || SKIP.has(entry.name) || PROTECTED.test(entry.name)) continue;
          const rel = path.posix.join(relative, entry.name);
          if (entry.isDirectory()) { visit(rel, depth + 1); continue; }
          examined++;
          let bytes; try { bytes = this.readBytes(a.project, rel); } catch { continue; }
          if (bytes.includes(0)) continue;
          const needle = a.case_sensitive ? a.query : a.query.toLowerCase();
          const lines = bytes.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if ((a.case_sensitive ? lines[i] : lines[i].toLowerCase()).includes(needle)) matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 2000) });
            if (matches.length >= (a.limit || 100)) { truncated = true; break; }
          }
        }
      };
      visit(a.path || '.'); return { matches, examined, truncated };
    });
    add('file_mkdir', 'Create a directory beneath an approved project root.', obj(f, ['project', 'path']), 'write', false, a => { const dir = this.resolve(a.project, a.path); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return { path: a.path }; });
    add('file_write', 'Create or atomically replace a file. expected_sha256 is empty only for a new file. Existing bytes are backed up locally; stale edits fail.', obj({ ...f, content: str(3 * LIMIT), expected_sha256: str(64), encoding: enumeration('utf8', 'base64') }, ['project', 'path', 'content', 'expected_sha256']), 'write', false, a => this.writeFile(a));
    add('file_edit', 'Apply exact text replacements guarded by the current SHA-256. Each old string must occur exactly once; ambiguous or stale edits fail.', obj({ ...f, expected_sha256: str(64), edits: arr(obj({ old: str(LIMIT), new: str(LIMIT) }, ['old', 'new']), 100) }, ['project', 'path', 'expected_sha256', 'edits']), 'write', false, async a => {
      const bytes = this.readBytes(a.project, a.path);
      if (hash(bytes) !== a.expected_sha256) fail('Stale file hash');
      if (bytes.includes(0) || !a.edits.length) fail('Expected text and at least one edit');
      let text = bytes.toString('utf8');
      for (const edit of a.edits) {
        if (!edit.old || text.split(edit.old).length !== 2) fail('Each old string must occur exactly once');
        text = text.replace(edit.old, () => edit.new);
      }
      return this.writeFile({ ...a, content: text });
    });
    add('file_delete', 'Delete one file only after SHA-256 verification, preserving a recoverable backup. No recursive directory deletion.', obj({ ...f, expected_sha256: str(64) }, ['project', 'path', 'expected_sha256']), 'write', false, a => this.locked(`file:${a.project}:${a.path}`, () => {
      const bytes = this.readBytes(a.project, a.path);
      if (hash(bytes) !== a.expected_sha256) fail('Stale file hash');
      const backupId = this.backup(a.project, a.path, bytes);
      fs.unlinkSync(this.resolve(a.project, a.path)); return { deleted: a.path, backup_id: backupId };
    }));
    add('file_restore', 'Restore a bridge-created backup to its original project path, with conflict detection.', obj({ backup_id: str(36), expected_sha256: str(64) }, ['backup_id', 'expected_sha256']), 'write', false, a => {
      if (!/^[a-f0-9-]{36}$/.test(a.backup_id)) fail('Invalid backup ID');
      const base = path.join(this.state, 'backups', a.backup_id);
      const info = jsonRead(`${base}.json`, null); if (!info) fail('Unknown backup');
      const content = fs.readFileSync(`${base}.data`).toString('base64');
      return this.writeFile({ project: info.project, path: info.path, content, expected_sha256: a.expected_sha256, encoding: 'base64' });
    });
    add('image_view', 'Return an existing PNG, JPEG or WebP project image as an MCP image, without a model/API request.', obj(f, ['project', 'path']), 'read', true, a => {
      const bytes = this.readBytes(a.project, a.path);
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
      if (!mime) fail('Not a supported image');
      return { _image: bytes.toString('base64'), mimeType: mime };
    });
    add('command_start', 'Start a LOCAL command or script, not an AI agent. Requires trusted execution. Returns a tracked job immediately; use job_read for progress. Commands can access the OS user account outside project roots.', obj({ ...p, argv: arr(str(65536), 128), cwd: str(1024), timeout_seconds: num(1, 86400), request_id: str(128), stdin: str(65536) }, ['project', 'argv', 'request_id']), 'exec', false, a => this.startJob(a));
    add('job_list', 'List tracked bridge jobs, not unrelated system processes.', obj({}), 'read', true, () => fs.readdirSync(path.join(this.state, 'jobs')).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => jsonRead(path.join(this.state, 'jobs', n), null)).filter(Boolean).slice(-200));
    add('job_read', 'Read bounded output with a durable byte cursor, exit code and real running/finished status. Does not restart jobs.', obj({ job_id: str(36), offset: num(0, Number.MAX_SAFE_INTEGER), max_bytes: num(1, 262144) }, ['job_id']), 'read', true, a => this.readJob(a));
    add('job_input', 'Write stdin to a live tracked job, optionally closing stdin. Pipe interaction only, not a pseudo-terminal.', obj({ job_id: str(36), text: str(65536), close: bool }, ['job_id', 'text']), 'exec', false, a => {
      const runtime = this.jobs.get(a.job_id); if (!runtime || runtime.job.status !== 'running' || runtime.child.stdin.destroyed) fail('No writable stdin for this job');
      if (a.close) runtime.child.stdin.end(a.text); else runtime.child.stdin.write(a.text);
      return { written: Buffer.byteLength(a.text), stdin_closed: !!a.close };
    });
    add('job_cancel', 'Stop only the named process tree created by this bridge. Never targets arbitrary PIDs.', obj({ job_id: str(36) }, ['job_id']), 'exec', false, a => this.stopJob(a.job_id, 'cancelled'));
    add('git_read', 'Inspect Git status/diff/log/branches/worktrees without external diff drivers, textconv or optional index writes.', obj({ ...p, operation: enumeration('status', 'diff', 'staged_diff', 'log', 'branches', 'worktrees') }, ['project', 'operation']), 'read', true, a => {
      const commands = { status: ['status', '--short', '--branch'], diff: ['diff', '--no-ext-diff', '--no-textconv'], staged_diff: ['diff', '--cached', '--no-ext-diff', '--no-textconv'], log: ['log', '-20', '--oneline'], branches: ['branch', '--list'], worktrees: ['worktree', 'list', '--porcelain'] };
      return this.git(a.project, commands[a.operation]);
    });
    add('git_branch', 'Create and switch to a new branch only with a clean working tree. No force/reset.', obj({ ...p, branch: str(128) }, ['project', 'branch']), 'exec', false, a => this.locked(`git:${a.project}`, async () => {
      this.checkRef(a.branch); await this.requireClean(a.project); return this.git(a.project, ['switch', '-c', a.branch]);
    }));
    add('git_commit', 'Commit only explicitly listed files after HEAD verification. Refuses unrelated staged changes. Hooks are disabled: run project release gates explicitly first.', obj({ ...p, paths: arr(str(1024), 100), message: str(4096), expected_head: str(64) }, ['project', 'paths', 'message', 'expected_head']), 'exec', false, a => this.locked(`git:${a.project}`, async () => {
      if (!a.paths.length || !a.message.trim()) fail('Selected paths and a commit message are required');
      for (const relative of a.paths) { const file = this.resolve(a.project, relative); if (fs.existsSync(file) && !fs.statSync(file).isFile()) fail('Select individual files, not directories'); }
      if ((await this.git(a.project, ['rev-parse', 'HEAD'])).stdout.trim() !== a.expected_head) fail('HEAD changed');
      if ((await this.git(a.project, ['diff', '--cached', '--name-only'])).stdout.trim()) fail('Index already contains staged changes. Review them explicitly first.');
      await this.git(a.project, ['add', '--', ...a.paths]);
      return this.git(a.project, ['commit', '-m', a.message]);
    }));
    add('worktree_create', 'Create and register a persistent isolated Git working directory and new branch. Does not copy ignored media, environments or dependencies.', obj({ ...p, name: str(64), branch: str(128), base_ref: str(128) }, ['project', 'name', 'branch']), 'exec', false, a => this.locked('worktrees', async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a.name) || this.projects.has(a.name)) fail('Worktree name is invalid or already in use');
      this.checkRef(a.branch); if (a.base_ref) this.checkRef(a.base_ref);
      const dest = path.join(this.state, 'worktrees', a.name);
      if (fs.existsSync(dest)) fail('Worktree destination already exists');
      await this.git(a.project, ['worktree', 'add', '-b', a.branch, dest, a.base_ref || 'HEAD']);
      this.worktrees[a.name] = { source: this.worktrees[a.project]?.source || a.project, path: dest, branch: a.branch, permanent: true };
      jsonWrite(this.worktreeFile, this.worktrees); this.projects.set(a.name, fs.realpathSync(dest));
      return { project: a.name, path: dest, branch: a.branch, permanent: true };
    }));
    add('worktree_remove', 'Remove only a bridge-created worktree that is completely clean. Never force, never delete its branch.', obj(p, ['project']), 'exec', false, a => this.locked('worktrees', async () => {
      const entry = this.worktrees[a.project]; if (!entry) fail('Only bridge-created worktrees can be removed');
      await this.requireClean(a.project);
      if ((await this.git(a.project, ['ls-files', '--others', '--ignored', '--exclude-standard'])).stdout.trim()) fail('Worktree contains ignored local files; preserve or remove them explicitly before removing the worktree');
      const result = await this.git(entry.source, ['worktree', 'remove', entry.path]);
      delete this.worktrees[a.project]; this.projects.delete(a.project); jsonWrite(this.worktreeFile, this.worktrees); return result;
    }));
    add('checkpoint_get', 'Read a saved project handoff/plan. This is explicit durable state, not automatic ChatGPT memory or extra context capacity.', obj(p, ['project']), 'read', true, a => { this.project(a.project); return jsonRead(path.join(this.state, 'checkpoints', `${a.project}.json`), { revision: 0, text: '' }); });
    add('checkpoint_save', 'Save a bounded handoff/plan with revision conflict detection for continuing in another chat. Does not create an AI subagent.', obj({ ...p, text: str(65536), expected_revision: num(0, Number.MAX_SAFE_INTEGER) }, ['project', 'text', 'expected_revision']), 'write', false, a => this.locked(`checkpoint:${a.project}`, () => {
      this.project(a.project); const file = path.join(this.state, 'checkpoints', `${a.project}.json`);
      const old = jsonRead(file, { revision: 0 }); if (old.revision !== a.expected_revision) fail('Checkpoint revision changed');
      const value = { revision: old.revision + 1, text: a.text, at: new Date().toISOString() }; jsonWrite(file, value); return value;
    }));
    add('browser', 'Use Playwright in a separate temporary browser session for tabs, page text, screenshots and interaction. Optional Python dependencies required. No ChatGPT cookies, tokens or API/model calls.', obj({ operation: enumeration('start', 'tabs', 'new_tab', 'navigate', 'snapshot', 'screenshot', 'click', 'fill', 'press', 'select', 'scroll', 'upload', 'download', 'close_tab', 'stop'), tab: str(64), url: str(4096), selector: str(4096), text: str(16384), key: str(128), x: num(-10000, 10000), y: num(-10000, 10000), headless: bool, ...f }, ['operation']), 'browser', false, async a => {
      const args = { ...a, kind: 'browser' };
      if (['upload', 'download'].includes(a.operation)) {
        if (!a.project || !a.path) fail('project and path are required for upload/download');
        args.file = this.resolve(a.project, a.path);
        if (a.operation === 'upload') { if (!fs.statSync(args.file).isFile()) fail('Upload requires a regular file'); }
        else { this.enabled('write'); if (fs.existsSync(args.file)) fail('Download destination already exists'); if (!fs.existsSync(path.dirname(args.file))) fail('Download parent is missing'); }
      }
      return this.ui(args);
    });
    add('desktop', 'Use the optional local GUI backend for screen/mouse/keyboard. Requires a visible session and OS permissions. Linux Wayland is not supported by this backend. Does not grant OpenAI native Computer Use.', obj({ operation: enumeration('status', 'screenshot', 'move', 'click', 'double_click', 'drag', 'scroll', 'press', 'hotkey', 'type'), x: num(0, 65535), y: num(0, 65535), amount: num(-100, 100), key: str(64), keys: arr(str(64), 8), text: str(16384), button: enumeration('left', 'middle', 'right') }, ['operation']), 'desktop', false, a => this.ui({ ...a, kind: 'desktop' }));
  }
  checkRef(ref) { if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.includes('//')) fail('Invalid Git reference'); }
  async git(project, args) {
    const result = await execFileAsync('git', ['--no-pager', '--literal-pathspecs', '-c', `core.hooksPath=${path.join(this.state, 'empty-hooks')}`, '-c', 'core.fsmonitor=false', '-C', this.project(project), ...args], { timeout: 30000, maxBuffer: LIMIT, env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
    return { stdout: result.stdout, stderr: result.stderr };
  }
  async requireClean(project) { if ((await this.git(project, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) fail('Working tree is not clean; nothing was removed or overwritten'); }
  saveJob(job) { jsonWrite(path.join(this.state, 'jobs', `${job.id}.json`), job); }
  startJob(a) {
    if (!a.argv.length || !a.argv[0]) fail('argv must contain an executable');
    if (!a.request_id) fail('request_id must be nonempty for retry deduplication');
    if (/^(codex|claude|aider|opencode)(\.exe|\.cmd)?$/i.test(path.basename(a.argv[0]))) fail('This direct bridge does not launch AI agents. Use local build/test/render commands.');
    const signature = hash(JSON.stringify(a));
    const key = `${a.project}:${a.request_id}`;
    const requestFile = path.join(this.state, 'jobs', `request-${hash(key)}.json`);
    const recorded = jsonRead(requestFile, null);
    const previous = this.dedupe.get(key) || (recorded ? { signature: recorded.signature, job: jsonRead(path.join(this.state, 'jobs', `${recorded.job_id}.json`), null) } : null);
    if (previous) { if (previous.signature !== signature) fail('request_id was already used for different arguments'); return { ...previous.job, duplicate: true }; }
    if ([...this.jobs.values()].filter(j => j.job.status === 'running').length >= 8) fail('Eight jobs are already running');
    const cwd = this.resolve(a.project, a.cwd || '.', { allowRoot: true });
    if (!fs.statSync(cwd).isDirectory()) fail('cwd is not a directory');
    const job = { id: uuid(), project: a.project, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, signal: null, output_bytes: 0, output_truncated: false, command_hash: signature };
    const log = path.join(this.state, 'jobs', `${job.id}.log`);
    fs.writeFileSync(log, '', { flag: 'wx', mode: 0o600 });
    this.saveJob(job);
    jsonWrite(requestFile, { signature, job_id: job.id }); // reserve before execution; never auto-replay after a crash
    const child = spawn(a.argv[0], a.argv.slice(1), { cwd, env: cleanEnv(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const runtime = { child, job, timer: null, stopTimer: null };
    this.jobs.set(job.id, runtime); this.dedupe.set(key, { signature, job }); this.saveJob(job);
    jsonWrite(requestFile, { signature, job_id: job.id });
    const append = data => {
      const remaining = 16 * LIMIT - job.output_bytes;
      if (data.length > remaining) job.output_truncated = true;
      if (remaining > 0) { const part = data.subarray(0, remaining); fs.appendFileSync(log, part); job.output_bytes += part.length; }
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    child.on('error', error => { append(Buffer.from(`Process start failed: ${error.code || 'unknown'}\n`)); job.status = 'failed'; });
    child.on('close', (code, signal) => {
      clearTimeout(runtime.timer); clearTimeout(runtime.stopTimer);
      job.exitCode = code; job.signal = signal; job.finishedAt = new Date().toISOString();
      if (job.status === 'running') job.status = job.terminationRequested || (code === 0 ? 'completed' : 'failed');
      this.saveJob(job);
    });
    runtime.timer = setTimeout(() => this.stopJob(job.id, 'timed_out'), (a.timeout_seconds || 600) * 1000);
    if (a.stdin) child.stdin.write(a.stdin);
    return { ...job, cwd, note: 'Use job_read for output and completion. No independent AI agent is running.' };
  }
  readJob(a) {
    if (!/^[a-f0-9-]{36}$/.test(a.job_id)) fail('Invalid job ID');
    const job = this.jobs.get(a.job_id)?.job || jsonRead(path.join(this.state, 'jobs', `${a.job_id}.json`), null);
    if (!job) fail('Unknown job');
    const file = path.join(this.state, 'jobs', `${a.job_id}.log`);
    const size = fs.statSync(file).size;
    const offset = a.offset || 0;
    const buffer = Buffer.alloc(Math.min(a.max_bytes || 65536, Math.max(0, size - offset)));
    const fd = fs.openSync(file, 'r'); let count;
    try { count = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
    return { ...job, output_bytes: size, output: buffer.subarray(0, count).toString('utf8'), offset, next_offset: offset + count, eof: offset + count >= size };
  }
  stopJob(id, reason) {
    const runtime = this.jobs.get(id);
    if (!runtime) fail('Only jobs owned by this live bridge can be cancelled');
    if (runtime.job.status !== 'running') return { ...runtime.job };
    if (runtime.job.terminationRequested) return { ...runtime.job };
    runtime.job.terminationRequested = reason;
    const kill = force => {
      if (!runtime.child.pid || runtime.child.exitCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(runtime.child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore', env: cleanEnv() });
        killer.on('error', () => runtime.child.kill());
      } else { try { process.kill(-runtime.child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
    };
    kill(false); runtime.stopTimer = setTimeout(() => kill(true), 1500); runtime.stopTimer.unref();
    this.saveJob(runtime.job); return { ...runtime.job };
  }
  ui(args) {
    // A single ordered GUI lane prevents two concurrent clicks or typing actions
    // from racing on the same desktop/browser session.
    const task = this.helperQueue.catch(() => {}).then(() => this.uiRequest(args));
    this.helperQueue = task; return task;
  }
  uiRequest(args) {
    if (!this.helper) {
      const child = spawn(this.config.python || (process.platform === 'win32' ? 'python' : 'python3'), [path.join(__dirname, 'ui_backend.py'), '--state', this.state, ...(this.config.chromiumExecutable ? ['--chromium-executable', this.config.chromiumExecutable] : [])], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.helper = child; let buffered = '';
      const dead = () => {
        if (this.helper === child) this.helper = null;
        for (const pending of this.helperPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('UI backend stopped; run the local doctor and inspect OS permissions/dependencies')); }
        this.helperPending.clear();
      };
      child.on('error', dead); child.on('exit', dead); child.stdin.on('error', () => {});
      child.stderr.on('data', () => {}); // No browser paths, login data or typed text in logs.
      child.stdout.on('data', data => {
        buffered += data.toString('utf8');
        if (buffered.length > 8 * LIMIT) { child.kill(); return; }
        for (;;) {
          const end = buffered.indexOf('\n'); if (end < 0) break;
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { child.kill(); break; }
          const pending = this.helperPending.get(message.id); if (!pending) continue;
          this.helperPending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        }
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.helperSeq;
      const timer = setTimeout(() => { this.helperPending.delete(id); this.helper?.kill(); reject(new Error('UI operation timed out; no successful action is claimed')); }, 45000);
      this.helperPending.set(id, { resolve, reject, timer });
      this.helper.stdin.write(`${JSON.stringify({ id, ...args })}\n`);
    });
  }
  async close() {
    for (const [id, runtime] of this.jobs) if (runtime.job.status === 'running') this.stopJob(id, 'interrupted');
    if (this.helper) { this.helper.stdin.end(); this.helper = null; }
    let timer;
    try { await Promise.race([Promise.all([...this.jobs.values()].filter(r => !r.job.finishedAt).map(r => new Promise(resolve => r.child.once('close', resolve)))), new Promise(resolve => { timer = setTimeout(resolve, 2200); })]); }
    finally { clearTimeout(timer); }
  }
}
module.exports = { DirectBridge, hash, inside, privateDir, atomic, jsonRead, jsonWrite, cleanEnv, validate, LIMIT };
