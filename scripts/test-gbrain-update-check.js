#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const updater = path.join(root, 'scripts', 'gbrain-update-check.js');
const { commandFor } = require(updater);

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

function assertLogOrder(log, expected) {
  let cursor = -1;
  for (const entry of expected) {
    const next = log.indexOf(entry, cursor + 1);
    if (next === -1) fail(`apply log missing expected ordered step: ${entry}\nlog:\n${log}`);
    if (next < cursor) fail(`apply log ordered step moved backwards: ${entry}\nlog:\n${log}`);
    cursor = next;
  }
}

function assertNoSecrets(label, text, secrets) {
  for (const secret of secrets) {
    if (text.includes(secret)) fail(`${label} leaked local secret: ${secret}`);
  }
}

function assertWindowsCommandShimHandling() {
  if (commandFor('npm', 'win32') !== 'npm.cmd') fail('Windows npm command should use npm.cmd');
  if (commandFor('gbrain', 'win32') !== 'gbrain.cmd') fail('Windows gbrain command should use gbrain.cmd');
  if (commandFor('custom-tool.cmd', 'win32') !== 'custom-tool.cmd') fail('Windows commandFor must preserve explicit .cmd shim');
  if (commandFor('npm', 'linux') !== 'npm') fail('non-Windows npm command should stay npm');
}

assertWindowsCommandShimHandling();

if (process.platform === 'win32') {
  console.log('gbrain update checker Unix fixture skipped on Windows; command shim smoke passed.');
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
  const upstreamRepoWithSecrets = [
    'https://repo-user:repo-password',
    'host.invalid/gbrain.git?pat=repo-pat&jwt=repo-jwt&access_key=repo-access-key&private_key=repo-private-key&service_role_key=repo-service-role-key',
  ].join('@');
  const upstreamSecrets = [
    'repo-user:repo-password',
    'repo-pat',
    'repo-jwt',
    'repo-access-key',
    'repo-private-key',
    'repo-service-role-key',
  ];
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gbrainData, { recursive: true });
  const configFile = path.join(gbrainData, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      embedding_model: 'fixture',
      provider_base_urls: {
        litellm: 'http://127.0.0.1:4127/v1/t/rawtok',
        other: ['https://user:pass', 'host.invalid/embed?api_key=query-api-key&refresh_token=refresh-token&id_token=id-token&client_secret=client-secret'].join('@'),
        bareUserinfo: ['https://tokenonly', 'host.invalid/v1'].join('@'),
        extraSecrets: 'https://host.invalid/embed?jwt=query-jwt&pat=query-pat&access_key=query-access-key&private_key=query-private-key&service_role_key=query-service-role-key',
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
    if [[ -n "\${GBRAIN_FAKE_DOCTOR_JSON:-}" ]]; then
      printf '%s\\n' "$GBRAIN_FAKE_DOCTOR_JSON"
    else
      printf '%s\\n' '{"status":"healthy","checks":[{"name":"connection","status":"ok"}]}'
    fi
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
    GBRAIN_UPSTREAM_REPO: upstreamRepoWithSecrets,
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
  assertNoSecrets('first check JSON', JSON.stringify(first), upstreamSecrets);
  if (first.newSinceLastCheck !== null) fail('first check should report first-run comparison');
  const firstState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (firstState.bridgebrain_update_state !== true) fail('check state file missing BridgeBrain ownership marker');
  assertNoSecrets('update state', JSON.stringify(firstState), upstreamSecrets);

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
  assertLogOrder(fs.readFileSync(logFile, 'utf8'), [
    'npm test',
    'npm run package:guard',
    'gbrain upgrade',
    'patch',
    'npm run check',
  ]);
  if (!applied.backup || !applied.backup.backupDir) fail('apply did not create backup metadata');
  if (applied.backup.backupScope !== 'metadata-redacted-only') fail('default backup must be metadata-redacted-only');
  if (applied.backup.snapshotCopied) fail('default backup must not copy .gbrain data snapshot');
  if (!fs.existsSync(path.join(applied.backup.backupDir, 'backup-manifest.json'))) {
    fail('apply did not write backup manifest');
  }
  const backupManifest = fs.readFileSync(path.join(applied.backup.backupDir, 'backup-manifest.json'), 'utf8');
  assertNoSecrets('backup manifest', backupManifest, upstreamSecrets);
  const redactedStatePath = path.join(applied.backup.backupDir, 'update-state-before.json');
  if (!fs.existsSync(redactedStatePath)) {
    fail('apply did not write redacted update state backup');
  }
  assertNoSecrets('redacted update state backup', fs.readFileSync(redactedStatePath, 'utf8'), upstreamSecrets);
  const redactedConfigPath = path.join(applied.backup.backupDir, 'config.redacted.json');
  if (!fs.existsSync(redactedConfigPath)) {
    fail('apply did not write redacted config backup');
  }
  const redactedConfig = fs.readFileSync(redactedConfigPath, 'utf8');
  for (const secret of [
    'rawtok',
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
    'query-jwt',
    'query-pat',
    'query-access-key',
    'query-private-key',
    'query-service-role-key',
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
  if (state.last_applied_upstream_head !== secondHead) fail('state did not record applied upstream head after success');
  if (state.last_upgrade_attempted_upstream_head !== secondHead) fail('state did not record attempted upstream head');
  if (state.last_applied_gbrain_version !== applied.versionAfter) fail('state did not record verified installed version');
  if (state.last_backup_scope !== 'metadata-redacted-only') fail('state did not record backup scope');
  if (!state.last_backup_dir || !state.last_backup_dir.includes('bridgebrain-gbrain-update-')) {
    fail('state did not record backup directory');
  }
  if (state.bridgebrain_update_state !== true) fail('apply state file missing BridgeBrain ownership marker');
  assertNoSecrets('applied update state', JSON.stringify(state), upstreamSecrets);

  fs.writeFileSync(logFile, '');
  const fakeDefaultBasenameStateFile = path.join(temp, 'bridgebrain-gbrain-update-state.json');
  fs.writeFileSync(fakeDefaultBasenameStateFile, '{"not":"bridgebrain"}\n');
  const fakeDefaultCheck = runFailure(['check', '--json', '--state-file', fakeDefaultBasenameStateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (!/not a BridgeBrain update-state file/.test(fakeDefaultCheck.error || '')) {
    fail(`custom same-basename state check did not reject unowned file: ${JSON.stringify(fakeDefaultCheck)}`);
  }
  if (!fs.readFileSync(fakeDefaultBasenameStateFile, 'utf8').includes('"not"')) {
    fail('custom same-basename state check overwrote unowned file');
  }

  fs.writeFileSync(logFile, '');
  runFailure(['check', '--json', '--state-file', path.join(root, 'bridgebrain-update-state.json')], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  runFailure(['check', '--json', '--state-file', configFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  for (const sidecarName of ['brain.sqlite-wal', 'brain.sqlite-shm', 'brain.sqlite3-wal', 'brain.db-journal']) {
    const sidecarStateFile = path.join(temp, sidecarName);
    const sidecarCheck = runFailure(['check', '--json', '--state-file', sidecarStateFile], {
      ...env,
      GBRAIN_FAKE_HEAD: secondHead,
    });
    if (!/private config or database path/.test(sidecarCheck.error || '')) {
      fail(`sqlite sidecar state-file gate did not explain database block: ${JSON.stringify(sidecarCheck)}`);
    }
    if (fs.existsSync(sidecarStateFile)) fail(`sqlite sidecar state-file gate wrote ${sidecarName}`);
  }
  if (fs.existsSync(path.join(root, 'bridgebrain-update-state.json'))) {
    fail('repo-local check state-file gate wrote inside repo');
  }

  fs.writeFileSync(logFile, '');
  const repeatedApply = runFailure(['apply', '--json', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (!/already attempted/.test(repeatedApply.error || '')) {
    fail(`repeat apply failure did not explain force gate: ${JSON.stringify(repeatedApply)}`);
  }
  const repeatLog = fs.readFileSync(logFile, 'utf8');
  for (const forbidden of ['npm test', 'npm run package:guard', 'gbrain upgrade']) {
    if (repeatLog.includes(forbidden)) fail(`repeat apply force gate happened after side effect: ${forbidden}`);
  }

  fs.writeFileSync(logFile, '');
  const badStateFile = path.join(root, 'bridgebrain-update-state.json');
  runFailure(['apply', '--json', '--force', '--state-file', badStateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('repo-local state file failure happened after upgrade side effect');
  }

  fs.writeFileSync(logFile, '');
  runFailure(['apply', '--json', '--force', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
    GBRAIN_FAKE_DOCTOR_JSON: '{}',
  });
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('empty doctor JSON failure happened after upgrade side effect');
  }

  fs.writeFileSync(logFile, '');
  runFailure(['apply', '--json', '--force', '--full-data-backup', '--state-file', stateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
    GBRAIN_BACKUP_DIR: path.join(gbrainData, 'backups'),
  });
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('invalid full-data backup path failure happened after upgrade side effect');
  }

  fs.writeFileSync(logFile, '');
  runFailure(['apply', '--json', '--force', '--state-file', configFile], {
    ...env,
    GBRAIN_FAKE_HEAD: secondHead,
  });
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('private config state-file failure happened after upgrade side effect');
  }

  fs.writeFileSync(logFile, '');
  const lockedStateFile = path.join(temp, 'locked-state.json');
  const globalLock = path.join(gbrainData, 'bridgebrain-gbrain-update-state.json.lock');
  fs.mkdirSync(globalLock, { recursive: true });
  try {
    const lockedApply = runFailure(['apply', '--json', '--state-file', lockedStateFile], {
      ...env,
      GBRAIN_FAKE_HEAD: secondHead,
    });
    if (!/appears to be running/.test(lockedApply.error || '')) {
      fail(`locked apply failure did not explain lock gate: ${JSON.stringify(lockedApply)}`);
    }
  } finally {
    fs.rmSync(globalLock, { recursive: true, force: true });
  }
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('locked apply failure happened after upgrade side effect');
  }

  fs.writeFileSync(logFile, '');
  const liveLock = path.join(gbrainData, 'pglite.lock');
  fs.writeFileSync(liveLock, 'live fixture\n');
  try {
    const liveBackup = runFailure(['apply', '--json', '--force', '--full-data-backup', '--state-file', stateFile], {
      ...env,
      GBRAIN_FAKE_HEAD: secondHead,
    });
    if (!/full-data backup refused while live database indicators exist/.test(liveBackup.error || '')) {
      fail(`full-data live indicator failure did not explain consistency gate: ${JSON.stringify(liveBackup)}`);
    }
  } finally {
    fs.rmSync(liveLock, { force: true });
  }
  if (fs.readFileSync(logFile, 'utf8').includes('gbrain upgrade')) {
    fail('full-data live indicator failure happened after upgrade side effect');
  }

  const fullDefaultEnv = { ...env, GBRAIN_FAKE_HEAD: secondHead };
  delete fullDefaultEnv.GBRAIN_BACKUP_DIR;
  const fullDefault = run(['apply', '--json', '--force', '--full-data-backup', '--state-file', stateFile], fullDefaultEnv);
  if (!fullDefault.backup.snapshotCopied) fail('full-data backup did not copy snapshot');
  if (fullDefault.backup.backupDir.startsWith(gbrainData)) fail('full-data default backup directory was inside .gbrain');
  if (!fs.existsSync(path.join(fullDefault.backup.backupDir, 'gbrain-home-snapshot', 'brain.pglite'))) {
    fail('full-data backup did not copy private brain fixture outside source');
  }

  const failedHead = 'cccccccccccccccccccccccccccccccccccccccc';
  const failingStateFile = path.join(temp, 'failing-state.json');
  fs.writeFileSync(logFile, '');
  const freshFailedApply = runFailure(['apply', '--json', '--state-file', failingStateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: failedHead,
    FAKE_FAIL_FINAL_CHECK: '1',
  });
  if (!freshFailedApply.backup || !freshFailedApply.backup.backupDir) {
    fail('fresh failed apply did not report backup path');
  }
  const failedState = JSON.parse(fs.readFileSync(failingStateFile, 'utf8'));
  if (failedState.last_upgrade_attempted_upstream_head !== failedHead || failedState.last_apply_status !== 'attempted') {
    fail('fresh failed apply did not record attempted upstream head before failing');
  }
  fs.writeFileSync(logFile, '');
  const blockedAfterFailure = runFailure(['apply', '--json', '--state-file', failingStateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: failedHead,
  });
  if (!/already attempted/.test(blockedAfterFailure.error || '')) {
    fail(`repeat after failed apply did not explain force gate: ${JSON.stringify(blockedAfterFailure)}`);
  }
  const blockedAfterFailureLog = fs.readFileSync(logFile, 'utf8');
  for (const forbidden of ['npm test', 'npm run package:guard', 'gbrain upgrade']) {
    if (blockedAfterFailureLog.includes(forbidden)) fail(`failed-apply repeat gate happened after side effect: ${forbidden}`);
  }

  const unhealthyStateFile = path.join(temp, 'unhealthy-state.json');
  const unhealthyDoctor = JSON.stringify({
    status: 'unhealthy',
    checks: [
      {
        name: 'auth',
        status: 'fail',
        message: `bad ${['http://user:secret', 'host.invalid/v1/t/rawtok?api_key=query-api-key'].join('@')} Authorization Bearer nested-bearer-token`,
      },
    ],
  });
  const unhealthyResult = runFailure(['apply', '--json', '--force', '--allow-unhealthy-before', '--state-file', unhealthyStateFile], {
    ...env,
    GBRAIN_FAKE_HEAD: 'dddddddddddddddddddddddddddddddddddddddd',
    GBRAIN_FAKE_DOCTOR_JSON: unhealthyDoctor,
  });
  const unhealthyText = JSON.stringify(unhealthyResult);
  for (const secret of ['rawtok', 'query-api-key', 'user:secret', 'nested-bearer-token']) {
    if (unhealthyText.includes(secret)) fail(`allowed-unhealthy doctor JSON leaked local secret: ${secret}`);
  }
  if (!unhealthyText.includes('/v1/t/<redacted>') || !unhealthyText.includes('<redacted>')) {
    fail('allowed-unhealthy doctor JSON did not include expected redaction markers');
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
  if (/rawtok|raw-api-key|query-api-key|nested-bearer-token/.test(JSON.stringify(failedApply))) {
    fail('failed apply JSON leaked local secrets');
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
    'validateApplyPaths',
    '--full-data-backup',
    'metadata-redacted-only',
    'last_upgrade_attempted_upstream_head',
    'redactString',
  ]) {
    if (!source.includes(expected)) fail(`updater missing safety surface: ${expected}`);
  }

  console.log('gbrain update checker smoke passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
