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

function runFailure(args, env) {
  const result = spawnSync(process.execPath, [updater, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status === 0) {
    fail(`updater unexpectedly passed: ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse updater failure JSON: ${err.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
  const configFile = path.join(gbrainData, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      embedding_model: 'fixture',
      provider_base_urls: {
        litellm: 'http://127.0.0.1:4127/v1/t/raw-local-token',
        other: ['https://user:pass', 'host.invalid/embed?api_key=query-api-key&refresh_token=refresh-token&id_token=id-token&client_secret=client-secret'].join('@'),
        bareUserinfo: ['https://tokenonly', 'host.invalid/v1'].join('@'),
      },
      api_key: 'raw-api-key',
      providers: {
        openai: {
          api_key: 'nested-api-key',
          headers: {
            Authorization: 'Bearer nested-bearer-token',
          },
        },
      },
      storage: {
        serviceRoleKey: 'supabase-service-role-key',
      },
    }, null, 2),
  );
  fs.writeFileSync(path.join(gbrainData, 'brain.pglite'), 'private brain fixture\n');

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
if [[ "$*" == "run check" && -n "\${FAKE_FAIL_FINAL_CHECK:-}" ]]; then
  echo "final check failed by fixture" >&2
  exit 9
fi
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
  if (applied.backup.backupScope !== 'metadata-redacted-only') fail('default backup must be metadata-redacted-only');
  if (applied.backup.snapshotCopied) fail('default backup must not copy .gbrain data snapshot');
  if (!fs.existsSync(path.join(applied.backup.backupDir, 'backup-manifest.json'))) {
    fail('apply did not write backup manifest');
  }
  const redactedConfigPath = path.join(applied.backup.backupDir, 'config.redacted.json');
  if (!fs.existsSync(redactedConfigPath)) {
    fail('apply did not write redacted config backup');
  }
  const redactedConfig = fs.readFileSync(redactedConfigPath, 'utf8');
  for (const secret of [
    'raw-local-token',
    'raw-api-key',
    'query-api-key',
    'refresh-token',
    'id-token',
    'client-secret',
    'nested-api-key',
    'nested-bearer-token',
    'user:pass',
    'tokenonly',
    'supabase-service-role-key',
  ]) {
    if (redactedConfig.includes(secret)) fail(`redacted config backup leaked local secret: ${secret}`);
  }
  if (!redactedConfig.includes('/v1/t/<redacted>') || !redactedConfig.includes('<redacted>')) {
    fail('redacted config backup did not include expected redaction markers');
  }
  if (fs.existsSync(path.join(applied.backup.backupDir, 'gbrain-home-snapshot'))) {
    fail('default backup created full .gbrain snapshot');
  }

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.last_applied_upstream_head !== secondHead) fail('state did not record applied upstream head');
  if (state.last_backup_scope !== 'metadata-redacted-only') fail('state did not record backup scope');
  if (!state.last_backup_dir || !state.last_backup_dir.includes('bridgebrain-gbrain-update-')) {
    fail('state did not record backup directory');
  }

  fs.writeFileSync(configFile, '{"api_key": raw-malformed-token\n');
  const malformedBackup = run(['apply', '--json', '--force', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  const malformedErrorPath = path.join(malformedBackup.backup.backupDir, 'config.redacted.error.txt');
  if (!fs.existsSync(malformedErrorPath)) fail('malformed config backup did not write generic parse error');
  const malformedError = fs.readFileSync(malformedErrorPath, 'utf8');
  if (malformedError.includes('raw-malformed-token') || malformedError.includes('api_key')) {
    fail('malformed config backup leaked raw parser context');
  }

  const failedApply = runFailure(['apply', '--json', '--force', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
    FAKE_FAIL_FINAL_CHECK: '1',
  });
  if (!failedApply.backup || !failedApply.backup.backupDir) {
    fail('failed apply did not report backup path');
  }
  if (!failedApply.steps || !failedApply.steps.some((step) => step.label === 'local update backup')) {
    fail('failed apply did not report steps through backup');
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
    '--full-data-backup',
    'metadata-redacted-only',
  ]) {
    if (!source.includes(expected)) fail(`updater missing safety surface: ${expected}`);
  }

  console.log('gbrain update checker smoke passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
