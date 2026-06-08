#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const updater = path.join(root, 'scripts', 'gbrain-update-check.js');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function run(args, env) {
  const result = spawnSync(process.execPath, [updater, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fail(`updater failed: ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse updater JSON: ${err.message}\nstdout:\n${result.stdout}`);
  }
}

if (process.platform === 'win32') {
  console.log('gbrain update checker smoke skipped on Windows; bash fixtures are Unix-only.');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-gbrain-update-'));

try {
  const bin = path.join(temp, 'bin');
  const home = path.join(temp, 'home');
  const gbrainParent = path.join(temp, 'gbrain-parent');
  const gbrainData = path.join(gbrainParent, '.gbrain');
  const backupDir = path.join(temp, 'backups');
  const stateFile = path.join(temp, 'state.json');
  const logFile = path.join(temp, 'commands.log');
  const patchScript = path.join(temp, 'fake-patch.js');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gbrainData, { recursive: true });
  fs.writeFileSync(path.join(gbrainData, 'config.json'), '{"embedding_model":"fixture"}\n');

  writeExecutable(path.join(bin, 'fake-gbrain'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    printf '%s\\n' "gbrain \${GBRAIN_FAKE_VERSION:-0.1.0}"
    ;;
  check-update)
    if [[ "\${2:-}" != "--json" ]]; then
      echo "expected --json" >&2
      exit 2
    fi
    printf '%s\\n' '{"current_version":"0.1.0","latest_version":"","update_available":false,"error":"no_releases"}'
    ;;
  doctor)
    if [[ "\${2:-}" != "--json" ]]; then
      echo "expected doctor --json" >&2
      exit 2
    fi
    printf '%s\\n' '{"status":"healthy","checks":[]}'
    ;;
  upgrade)
    printf '%s\\n' "gbrain upgrade" >> "$FAKE_LOG"
    ;;
  *)
    echo "unexpected fake-gbrain args: $*" >&2
    exit 2
    ;;
esac
`);

  writeExecutable(path.join(bin, 'fake-git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "ls-remote" && "\${3:-}" == "HEAD" ]]; then
  printf '%s\\tHEAD\\n' "\${GBRAIN_FAKE_HEAD:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  exit 0
fi
echo "unexpected fake-git args: $*" >&2
exit 2
`);

  writeExecutable(path.join(bin, 'fake-npm'), `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_LOG"
exit 0
`);

  fs.writeFileSync(
    patchScript,
    "const fs = require('fs'); fs.appendFileSync(process.env.FAKE_LOG, 'patch\\n');\n",
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    HOME: home,
    GBRAIN_HOME: gbrainParent,
    GBRAIN_BIN: path.join(bin, 'fake-gbrain'),
    GIT_BIN: path.join(bin, 'fake-git'),
    NPM_BIN: path.join(bin, 'fake-npm'),
    GBRAIN_BACKUP_DIR: backupDir,
    BRIDGEBRAIN_UPDATE_PATCH_SCRIPT: patchScript,
    FAKE_LOG: logFile,
  };

  const firstHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const secondHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const readonly = run(['check', '--json', '--no-write-state', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: firstHead,
  });
  if (readonly.stateWritten !== false) fail('read-only check claimed to write state');
  if (fs.existsSync(stateFile)) fail('read-only check wrote state file');
  if (!readonly.recommendation.includes('read-only check did not update local state')) {
    fail('read-only recommendation did not match read-only behavior');
  }

  const first = run(['check', '--json', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: firstHead,
  });
  if (first.upstreamHead !== firstHead) fail('first check did not read fake upstream head');
  if (first.newSinceLastCheck !== null) fail('first check should report first-run comparison');

  const second = run(['check', '--json', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (second.upstreamHead !== secondHead) fail('second check did not read updated fake upstream head');
  if (second.newSinceLastCheck !== true) fail('second check did not detect new upstream commit');

  const applied = run(['apply', '--json', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (applied.status !== 'applied') fail('apply did not report applied status');
  if (!applied.backup || !applied.backup.backupDir) fail('apply did not create backup metadata');
  if (!fs.existsSync(path.join(applied.backup.backupDir, 'backup-manifest.json'))) {
    fail('apply did not write backup manifest');
  }
  if (!fs.existsSync(path.join(applied.backup.backupDir, 'gbrain-home-snapshot', 'config.json'))) {
    fail('apply did not snapshot local GBrain home');
  }

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.last_applied_upstream_head !== secondHead) fail('state did not record applied upstream head');
  if (!state.last_backup_dir || !state.last_backup_dir.includes('bridgebrain-gbrain-update-')) {
    fail('state did not record backup directory');
  }

  const log = fs.readFileSync(logFile, 'utf8');
  for (const expected of [
    'npm test',
    'npm run package:guard',
    'gbrain upgrade',
    'patch',
    'npm run check',
  ]) {
    if (!log.includes(expected)) fail(`apply did not run expected step: ${expected}`);
  }

  const source = fs.readFileSync(updater, 'utf8');
  for (const expected of [
    "['ls-remote', repo, 'HEAD']",
    "['doctor', '--json']",
    "['upgrade']",
    "['run', 'check']",
    'assertOutsideRepo',
  ]) {
    if (!source.includes(expected)) fail(`updater missing safety surface: ${expected}`);
  }

  console.log('gbrain update checker smoke passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
