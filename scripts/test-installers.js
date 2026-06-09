#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const machineMemory = require(path.join(root, 'scripts', 'setup-machine-memory.js'));
const { buildCheckPlan } = require(path.join(root, 'scripts', 'check.js'));
const packageGuard = require(path.join(root, 'scripts', 'package-guard.js'));

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform === 'win32') {
  console.log('installer smoke skipped on Windows; install.sh requires a Unix shell.');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-install-'));

try {
  const bin = path.join(temp, 'bin');
  const home = path.join(temp, 'home');
  const codexHome = path.join(temp, 'codex');
  const gbrainHome = path.join(temp, 'gbrain');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

writeExecutable(path.join(bin, 'fake-codex'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "doctor" ]]; then
  printf '%s\\n' '{"checks":{"auth.credentials":{"status":"ok","details":{"stored auth mode":"chatgpt","stored ChatGPT tokens":"true","stored API key":"false"}}},"overallStatus":"ok"}'
  exit 0
fi
echo "unexpected fake-codex args: $*" >&2
exit 2
`);

  writeExecutable(path.join(bin, 'fake-gbrain'), `#!/usr/bin/env bash
set -euo pipefail
home_parent="\${GBRAIN_HOME:-$HOME}"
home="\${home_parent%/}/.gbrain"
case "\${1:-}" in
  init)
    mkdir -p "$home"
    if [[ "$*" == *"--no-embedding"* ]]; then
      echo "fresh init must not disable embeddings" >&2
      exit 2
    fi
    if [[ "$*" != *"--embedding-model litellm:chatgpt-bridge-semantic-hash-1536"* ]]; then
      echo "fresh init missing BridgeBrain embedding model: $*" >&2
      exit 2
    fi
    if [[ "$*" != *"--embedding-dimensions 1536"* ]]; then
      echo "fresh init missing BridgeBrain dimensions: $*" >&2
      exit 2
    fi
    if [[ "$*" != *"--skip-embed-check"* ]]; then
      echo "fresh init must skip live embedding check during schema setup" >&2
      exit 2
    fi
    if [[ ! -f "$home/config.json" ]]; then
      printf '{}\\n' > "$home/config.json"
    fi
    ;;
  call)
    if [[ "\${2:-}" == "get_brain_identity" ]]; then
      printf '%s\\n' '{"page_count":0}'
    else
      echo "unexpected fake-gbrain call args: $*" >&2
      exit 2
    fi
    ;;
  status)
    if [[ "$*" == *"--json"* ]]; then
      if [[ -n "\${GBRAIN_FAKE_STATUS_JSON:-}" ]]; then
        printf '%s\\n' "$GBRAIN_FAKE_STATUS_JSON"
      else
        printf '%s\\n' '{"schema_version":1,"sync":{"sources":[]}}'
      fi
    else
      echo "unexpected fake-gbrain status args: $*" >&2
      exit 2
    fi
    ;;
  sources)
    if [[ "\${2:-}" == "list" && "$*" == *"--json"* ]]; then
      if [[ -n "\${GBRAIN_FAKE_SOURCES_JSON:-}" ]]; then
        printf '%s\\n' "$GBRAIN_FAKE_SOURCES_JSON"
      else
        printf '%s\\n' '{"sources":[]}'
      fi
    elif [[ "\${2:-}" == "status" && "$*" == *"--json"* ]]; then
      if [[ -n "\${GBRAIN_FAKE_SOURCES_STATUS_JSON:-}" ]]; then
        printf '%s\\n' "$GBRAIN_FAKE_SOURCES_STATUS_JSON"
      else
        printf '%s\\n' '{"schema_version":1,"sources":[]}'
      fi
    elif [[ "\${2:-}" == "archived" && "$*" == *"--json"* ]]; then
      if [[ -n "\${GBRAIN_FAKE_ARCHIVED_SOURCES_JSON:-}" ]]; then
        printf '%s\\n' "$GBRAIN_FAKE_ARCHIVED_SOURCES_JSON"
      else
        printf '%s\\n' '{"archived":[]}'
      fi
    else
      echo "unexpected fake-gbrain sources args: $*" >&2
      exit 2
    fi
    ;;
  *)
    echo "unexpected fake-gbrain args: $*" >&2
    exit 2
    ;;
esac
`);

  writeExecutable(path.join(bin, 'launchctl'), `#!/usr/bin/env bash
set -euo pipefail
exit 0
`);

  const gateway = path.join(temp, 'gateway.ts');
  fs.writeFileSync(
    gateway,
    [
      '  // Openai-compat recipes with empty models list require a user-provided model.',
      '  const isUserProvided = (tp as any).user_provided_models === true;',
      '  if (',
      '    Array.isArray(tp.models) &&',
      '    tp.models.length === 0 &&',
      "    (recipe.id === 'litellm' || isUserProvided)",
      '  ) {',
      '',
    ].join('\n'),
  );
  const staleCacheGateway = path.join(temp, 'home', '.bun', 'install', 'cache', '@GH@garrytan-gbrain-stale@@@1', 'src', 'core', 'ai', 'gateway.ts');
  fs.mkdirSync(path.dirname(staleCacheGateway), { recursive: true });
  fs.writeFileSync(staleCacheGateway, 'export const stale = true;\n');
  const dimCheck = path.join(temp, 'embedding-dim-check.ts');
  fs.writeFileSync(
    dimCheck,
    [
      'function isCustomDimValidForProvider(recipe, modelId, requestedDims, dimsOptions) {',
      '  // Tier 1: recipe-declared dims_options.',
      '  if (dimsOptions && dimsOptions.length > 0) {',
      "    return { valid: true, error: '' };",
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  const staleCacheDimCheck = path.join(temp, 'home', '.bun', 'install', 'cache', '@GH@garrytan-gbrain-stale@@@1', 'src', 'core', 'embedding-dim-check.ts');
  fs.mkdirSync(path.dirname(staleCacheDimCheck), { recursive: true });
  fs.writeFileSync(staleCacheDimCheck, 'export const stale = true;\n');

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    GBRAIN_HOME: gbrainHome,
    CODEX_BIN: path.join(bin, 'fake-codex'),
    GBRAIN_BIN: path.join(bin, 'fake-gbrain'),
    GBRAIN_GATEWAY_TS: gateway,
    GBRAIN_EMBEDDING_DIM_CHECK_TS: dimCheck,
    NODE_BIN: process.execPath,
    GBRAIN_CHATGPT_EMBED_PORT: '59998',
    BRIDGEBRAIN_API_TOKEN: 'ismoketest',
    BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };

  const preflightGateway = path.join(temp, 'preflight-gateway.ts');
  const preflightBadDimCheck = path.join(temp, 'preflight-bad-dim-check.ts');
  fs.writeFileSync(
    preflightGateway,
    [
      '  // Openai-compat recipes with empty models list require a user-provided model.',
      '  const isUserProvided = (tp as any).user_provided_models === true;',
      '  if (',
      '    Array.isArray(tp.models) &&',
      '    tp.models.length === 0 &&',
      "    (recipe.id === 'litellm' || isUserProvided)",
      '  ) {',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(preflightBadDimCheck, 'export const upstreamChanged = true;\n');
  const preflightPatch = spawnSync(process.execPath, ['scripts/patch-gbrain-litellm.js'], {
    cwd: root,
    env: {
      ...env,
      GBRAIN_GATEWAY_TS: preflightGateway,
      GBRAIN_EMBEDDING_DIM_CHECK_TS: preflightBadDimCheck,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (preflightPatch.status === 0) {
    fail('gbrain patch preflight must fail when any active target is unpatchable');
  }
  if (fs.readFileSync(preflightGateway, 'utf8').includes('!parsed.modelId')) {
    fail('gbrain patch preflight modified gateway before validating dim-check target');
  }

  for (const [label, model, dimensions] of [
    ['unsupported dimensions', 'chatgpt-bridge-semantic-hash-1024', '1024'],
    ['model dimension mismatch', 'chatgpt-bridge-semantic-hash-1536', '768'],
  ]) {
    const badConfig = path.join(temp, `bad-config-${label.replace(/[^a-z]/g, '-')}.json`);
    const configResult = spawnSync(process.execPath, [
      'scripts/configure-gbrain.js',
      badConfig,
      model,
      dimensions,
      'http://127.0.0.1:59998/v1/t/redacted',
    ], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (configResult.status === 0) fail(`configure-gbrain accepted ${label}`);
    if (fs.existsSync(badConfig)) fail(`configure-gbrain wrote config for ${label}`);
  }
		  for (const [label, url] of [
		    ['remote provider URL', 'https://evil.invalid/v1/t/redacted'],
		    ['userinfo-smuggled provider URL', ['http://127.0.0.1:59998', 'evil.invalid/v1/t/redacted'].join('@')],
		    ['credentialed loopback provider URL', 'http://user:pass@127.0.0.1:59998/v1/t/redacted'],
		    ['query-string provider URL', 'http://127.0.0.1:59998/v1?token=redacted'],
		  ]) {
    const badConfig = path.join(temp, `bad-config-url-${label.replace(/[^a-z]/g, '-')}.json`);
    const configResult = spawnSync(process.execPath, [
      'scripts/configure-gbrain.js',
      badConfig,
      'chatgpt-bridge-semantic-hash-1536',
      '1536',
      url,
    ], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (configResult.status === 0) fail(`configure-gbrain accepted ${label}`);
    if (fs.existsSync(badConfig)) fail(`configure-gbrain wrote config for ${label}`);
  }
  const bareConfigDir = path.join(temp, 'bare-config-dir');
  fs.mkdirSync(bareConfigDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(bareConfigDir, 0o755);
  const bareConfigResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'configure-gbrain.js'),
    'config.json',
    'chatgpt-bridge-semantic-hash-1536',
    '1536',
    'http://127.0.0.1:59998/v1/t/redacted',
  ], {
    cwd: bareConfigDir,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (bareConfigResult.status !== 0) {
    fail(`configure-gbrain bare filename failed\\nstdout:\\n${bareConfigResult.stdout}\\nstderr:\\n${bareConfigResult.stderr}`);
  }
  if ((fs.statSync(bareConfigDir).mode & 0o777) !== 0o755) {
    fail('configure-gbrain bare filename chmodded caller directory');
  }
  const ipv6Config = path.join(temp, 'ipv6-config.json');
  const ipv6ConfigResult = spawnSync(process.execPath, [
    'scripts/configure-gbrain.js',
    ipv6Config,
    'chatgpt-bridge-semantic-hash-1536',
    '1536',
    'http://[::1]:59998/v1/t/redacted',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (ipv6ConfigResult.status !== 0) {
    fail(`configure-gbrain rejected IPv6 loopback\\nstdout:\\n${ipv6ConfigResult.stdout}\\nstderr:\\n${ipv6ConfigResult.stderr}`);
  }
  const ipv6ConfigJson = JSON.parse(fs.readFileSync(ipv6Config, 'utf8'));
  if (ipv6ConfigJson.provider_base_urls.litellm !== 'http://[::1]:59998/v1/t/redacted') {
    fail(`configure-gbrain wrote wrong IPv6 provider URL: ${JSON.stringify(ipv6ConfigJson.provider_base_urls)}`);
  }
  const nonObjectConfig = path.join(temp, 'non-object-config.json');
  fs.writeFileSync(nonObjectConfig, '[]\n');
  const nonObjectResult = spawnSync(process.execPath, [
    'scripts/configure-gbrain.js',
    nonObjectConfig,
    'chatgpt-bridge-semantic-hash-1536',
    '1536',
    'http://127.0.0.1:59998/v1/t/redacted',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (nonObjectResult.status === 0) fail('configure-gbrain accepted non-object config JSON');

  for (const template of [
    path.join(root, 'systemd', 'gbrain-chatgpt-embeddings.service.template'),
    path.join(root, 'launchd', 'com.gbrain.bridgebrain.embeddings.plist.template'),
  ]) {
    const text = fs.readFileSync(template, 'utf8');
    if (!text.includes('CODEX_HOME')) fail(`${path.basename(template)} does not export CODEX_HOME`);
  }
  for (const template of [
    path.join(root, 'systemd', 'gbrain-machine-sync.service.template'),
    path.join(root, 'systemd', 'gbrain-machine-sync.timer.template'),
    path.join(root, 'launchd', 'com.gbrain.bridgebrain.machine-sync.plist.template'),
  ]) {
    const text = fs.readFileSync(template, 'utf8');
    if (!text.includes('setup-machine-memory.js') && !text.includes('MACHINE_MEMORY_SCRIPT') && !text.includes('gbrain-machine-sync.service')) {
      fail(`${path.basename(template)} is missing machine-memory wiring`);
    }
  }
  const machineSystemd = fs.readFileSync(path.join(root, 'systemd', 'gbrain-machine-sync.service.template'), 'utf8');
  const machineSystemdTimer = fs.readFileSync(path.join(root, 'systemd', 'gbrain-machine-sync.timer.template'), 'utf8');
  const machineLaunchd = fs.readFileSync(path.join(root, 'launchd', 'com.gbrain.bridgebrain.machine-sync.plist.template'), 'utf8');
  const embeddingSystemd = fs.readFileSync(path.join(root, 'systemd', 'gbrain-chatgpt-embeddings.service.template'), 'utf8');
  if (!machineSystemd.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) {
    fail('systemd machine-memory template missing unlock environment');
  }
  if (!machineSystemd.includes('GBRAIN_HOME=@GBRAIN_HOME@')) {
    fail('systemd machine-memory template missing GBRAIN_HOME environment');
  }
  if (!machineSystemd.includes('CODEX_HOME=@CODEX_HOME@')) {
    fail('systemd machine-memory template missing CODEX_HOME environment');
  }
  if (!machineSystemd.includes('TimeoutStartSec=infinity')) {
    fail('systemd machine-memory service must let the runner own sync timeouts');
  }
  if (!machineSystemd.includes('ExecStart="@NODE_BIN@" "@MACHINE_MEMORY_SCRIPT@" sync-once')) {
    fail('systemd machine-memory ExecStart must quote rendered paths');
  }
  if (machineSystemdTimer.includes('OnBootSec=')) {
    fail('systemd machine-memory timer must not fire immediately from an elapsed boot timer');
  }
  if (!machineSystemdTimer.includes('OnActiveSec=@INTERVAL_SECONDS@s')) {
    fail('systemd machine-memory timer missing activation-relative first run');
  }
  if (!machineLaunchd.includes('<key>BRIDGEBRAIN_ENABLE_MACHINE_MEMORY</key>')) {
    fail('launchd machine-memory template missing unlock environment');
  }
  if (!machineLaunchd.includes('<key>GBRAIN_HOME</key>')) {
    fail('launchd machine-memory template missing GBRAIN_HOME environment');
  }
  if (!machineLaunchd.includes('<key>CODEX_HOME</key>')) {
    fail('launchd machine-memory template missing CODEX_HOME environment');
  }
  if (machineLaunchd.includes('<key>RunAtLoad</key>\n  <true/>')) {
    fail('launchd machine-memory must not run at load by default');
  }
  const installPs1 = fs.readFileSync(path.join(root, 'scripts', 'install.ps1'), 'utf8');
  const verifyPs1 = fs.readFileSync(path.join(root, 'scripts', 'verify.ps1'), 'utf8');
  const installSh = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  const verifySh = fs.readFileSync(path.join(root, 'scripts', 'verify.sh'), 'utf8');
  const checkSh = fs.readFileSync(path.join(root, 'scripts', 'check.sh'), 'utf8');
  const machineMemoryJs = fs.readFileSync(path.join(root, 'scripts', 'setup-machine-memory.js'), 'utf8');
  const evalJs = fs.readFileSync(path.join(root, 'scripts', 'eval.js'), 'utf8');
  const packageGuardJs = fs.readFileSync(path.join(root, 'scripts', 'package-guard.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const checkJs = fs.readFileSync(path.join(root, 'scripts', 'check.js'), 'utf8');
  const releaseGateJs = fs.readFileSync(path.join(root, 'scripts', 'release-gate.js'), 'utf8');
  const hygieneScanJs = fs.readFileSync(path.join(root, 'scripts', 'hygiene-scan.js'), 'utf8');
  if (!fs.existsSync(path.join(root, 'scripts', 'hygiene-scan.js'))) fail('Node hygiene scanner missing');
  if (!hygieneScanJs.includes('entry.isSymbolicLink()')) fail('hygiene scanner must reject symlinks');
  if (!hygieneScanJs.includes('ENCRYPTED |PRIVATE')) fail('hygiene scanner must block encrypted private key markers');
  if (!packageGuardJs.includes("['scripts/hygiene-scan.js']")) fail('package guard must run the Node hygiene scanner');
  if (!packageGuardJs.includes('sqlite3?|db)-(?:wal|shm|journal)')) fail('package guard must block sqlite sidecars');
  if (!packageGuardJs.includes('tokenized local bridge URL')) fail('package guard must block real tokenized bridge URLs');
  if (releaseGateJs.includes("['scripts/hygiene-scan.sh']")) fail('release gate must not require Bash hygiene scanner');
  if (!releaseGateJs.includes('result.error')) fail('release gate must fail when guard subprocess cannot start');
  if (!releaseGateJs.includes('result.signal')) fail('release gate must fail on signaled guard subprocess');
	  if (!checkJs.includes('result.signal')) fail('check.js must fail on signaled check runs');
	  if (!checkJs.includes("typeof result.status !== 'number'")) fail('check.js must fail on missing child exit status');
	  const winCheckSteps = buildCheckPlan('win32').map((step) => step.id);
	  for (const expectedStep of ['js-syntax', 'powershell-syntax', 'node-smoke', 'hygiene', 'release-gate']) {
	    if (!winCheckSteps.includes(expectedStep)) fail(`Windows check plan missing ${expectedStep}`);
	  }
	  if (winCheckSteps.includes('shell-syntax')) fail('Windows check plan must skip Unix shell syntax');
	  if (!checkSh.includes('node scripts/hygiene-scan.js')) fail('check.sh must explicitly run hygiene scan');
  if (!checkSh.includes('node scripts/release-gate.js')) fail('check.sh must run release gate');
  if (packageJson.scripts.test !== 'node scripts/test-node.js') fail('npm test must use the Node smoke wrapper');
  if (packageJson.scripts.check !== 'node scripts/check.js') fail('npm check must use the Node check wrapper');
  if (packageJson.scripts.hygiene !== 'node scripts/hygiene-scan.js') fail('npm hygiene must run the Node scanner');
  if (packageJson.scripts['package:guard'] !== 'node scripts/package-guard.js') {
    fail('package:guard must run the canonical package guard');
  }
  if (packageJson.scripts['release:gate'] !== 'node scripts/release-gate.js') {
    fail('release:gate must run the canonical release gate');
  }
  if (packageJson.scripts.prepack !== 'node scripts/package-guard.js') fail('prepack must run the canonical package guard');
  if (packageJson.scripts.prepublishOnly !== 'node scripts/release-gate.js --publish') {
    fail('prepublishOnly must run the publish release gate');
  }
  if (!packageGuardJs.includes('expectedFiles = new Set')) fail('package guard must pin expected package files');
  if (!packageGuardJs.includes('ENCRYPTED |PRIVATE')) fail('package guard must block encrypted private key markers');
  const expectedPackageFiles = [...packageGuard.expectedFiles];
  let packageProblems = packageGuard.packageFileProblems(expectedPackageFiles);
  if (packageProblems.unexpectedFiles.length || packageProblems.missingFiles.length || packageProblems.blockedFiles.length) {
    fail('package guard expected file allow-list must pass without blocker problems');
  }
  packageProblems = packageGuard.packageFileProblems([...expectedPackageFiles, '.clawpatch/state.json']);
  if (!packageProblems.blockedFiles.includes('.clawpatch/state.json')) {
    fail('package guard must reject blocked .clawpatch package files');
  }
  packageProblems = packageGuard.packageFileProblems([...expectedPackageFiles, 'extra.txt']);
  if (!packageProblems.unexpectedFiles.includes('extra.txt')) fail('package guard must reject unexpected package files');
  const privateKeyText = '-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n-----END ' + 'PRIVATE KEY-----\n';
  if (!packageGuard.contentPolicyHits([{ file: 'README.md', text: privateKeyText }]).some((hit) => hit.includes('private key marker'))) {
    fail('package guard must reject private-key-shaped content');
  }
  const tokenizedBridgeUrl = 'http://127.0.0.1:4127/v1/' + 't/' + 'notredactedtoken';
  if (!packageGuard.contentPolicyHits([{ file: 'README.md', text: tokenizedBridgeUrl }]).some((hit) => hit.includes('tokenized local bridge URL'))) {
    fail('package guard must reject unredacted tokenized bridge URLs');
  }
  if (!packageGuard.contentPolicyHits(
    [{ file: 'README.md', text: 'secret-owner-value' }],
    [{ label: 'private blocklist match', value: 'secret-owner-value' }],
  ).some((hit) => hit.includes('private blocklist match'))) {
    fail('package guard must reject exact private blocklist hits');
  }
  const exactPackageChecks = packageGuard.collectExactContentChecks({
    HOME: path.join(temp, 'package-home-fixture'),
    USER: 'bridgebrain-local-user-fixture',
    LOGNAME: 'bridgebrain-local-logname-fixture',
    BRIDGEBRAIN_BLOCKED_OWNER: '',
  });
  if (!exactPackageChecks.some((check) => check.label === 'current local user name')) {
    fail('package guard must collect current local user exact check');
  }
  if (!exactPackageChecks.some((check) => check.label === 'current local logname')) {
    fail('package guard must collect current local logname exact check');
  }
  if (!packageGuard.contentPolicyHits(
    [{ file: 'README.md', text: 'bridgebrain-local-user-fixture' }],
    exactPackageChecks,
  ).some((hit) => hit.includes('current local user name'))) {
    fail('package guard must reject current local user exact hits');
  }
  const hygieneUserCheck = spawnSync(process.execPath, [path.join(root, 'scripts', 'hygiene-scan.js')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: path.join(temp, 'hygiene-home-fixture'),
      USER: 'bridgebrain-local-user-fixture',
      LOGNAME: 'bridgebrain-local-logname-fixture',
      BRIDGEBRAIN_BLOCKED_OWNER: '',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (hygieneUserCheck.status === 0) fail('hygiene scan must reject current local user/logname exact hits');
  if (!hygieneUserCheck.stderr.includes('current local user name')) {
    fail(`hygiene scan user-name failure missing exact-check label: ${hygieneUserCheck.stderr}`);
  }
  if (!hygieneUserCheck.stderr.includes('current local logname')) {
    fail(`hygiene scan logname failure missing exact-check label: ${hygieneUserCheck.stderr}`);
  }
  try {
    packageGuard.ensurePublishAllowed({ publishMode: true, packagePrivate: true, allowPublicPublish: '1' });
    fail('package guard must reject publish mode while package.json remains private');
  } catch (error) {
    if (!/private=true/.test(error.message)) throw error;
  }
  try {
    packageGuard.ensurePublishAllowed({ publishMode: true, packagePrivate: false, allowPublicPublish: '' });
    fail('package guard must require explicit public publish unlock');
  } catch (error) {
    if (!/public publish is locked/.test(error.message)) throw error;
  }
  if (!installSh.includes('--machine-memory')) fail('install.sh missing machine-memory flag');
  if (!installSh.includes('--dry-run')) fail('install.sh missing dry-run flag');
  if (!installSh.includes('sed_xml_escape')) fail('install.sh missing launchd XML escaping helper');
  if (!installSh.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) fail('install.sh missing machine-memory unlock guard');
  if (!installSh.includes('GBRAIN_MACHINE_TERMINATE_SERVE must be none or all')) {
    fail('install.sh must reject invalid terminate-serve mode');
  }
  if (!installSh.includes('is_default_blocked_wide_root')) {
    fail('install.sh missing default external-drive root block');
  }
  if (!installSh.includes('private_root_reason')) {
    fail('install.sh missing private machine-memory root block');
  }
  if (!installSh.includes('^/run/media/')) {
    fail('install.sh missing /run/media external-drive root block');
  }
  if (!installPs1.includes('MachineMemory')) fail('install.ps1 missing MachineMemory switch');
  if (!installPs1.includes('[switch]$DryRun')) fail('install.ps1 missing DryRun switch');
  if (!installPs1.includes('Test-NodeVersion $NodeBin')) fail('install.ps1 must enforce Node.js 18+');
  if (!installPs1.includes('Test-PositiveInteger "GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS"')) {
    fail('install.ps1 must validate machine-memory interval');
  }
  if (!installPs1.includes('Wait-BridgeBrainAuthenticated $Port')) {
    fail('install.ps1 installer must validate configured token against service');
  }
  if (!installPs1.includes('Write-DryRunPlan')) fail('install.ps1 missing dry-run plan output');
  if (!installPs1.includes('ConvertTo-PowerShellLiteral')) fail('install.ps1 missing generated-runner literal quoting helper');
  if (!installPs1.includes('OrdinalIgnoreCase')) fail('install.ps1 Windows path containment must be case-insensitive');
  if (!installPs1.includes('BRIDGEBRAIN_PROFILE must be quality, compat, or mock')) fail('install.ps1 must reject unsupported profile values');
  if (!installPs1.includes('New-ScheduledTaskSettingsSet -RestartCount')) fail('install.ps1 service task missing restart settings');
  if (!installPs1.includes('Wait-BridgeBrainHealth $Port')) fail('install.ps1 installer must poll service health');
  if (!installPs1.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) fail('install.ps1 missing machine-memory unlock guard');
  if (!installPs1.includes('$env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY = "1"')) fail('install.ps1 machine-memory scheduled runner missing unlock env');
  if (!installPs1.includes('$env:GBRAIN_HOME = $GbrainHomeParentLiteral')) fail('install.ps1 machine-memory scheduled runner missing literal GBRAIN_HOME env');
  if (!installPs1.includes('$env:CODEX_HOME = $CodexHomeLiteral')) fail('install.ps1 machine-memory scheduled runner missing literal CODEX_HOME env');
  if (!installPs1.includes('$env:GBRAIN_MACHINE_ROOTS = $MachineMemoryRootsLiteral')) fail('install.ps1 machine-memory scheduled runner missing literal roots env');
  if (!installPs1.includes('else { "none" }')) fail('install.ps1 machine-memory terminate default must be none');
  if (!installPs1.includes('GBRAIN_MACHINE_TERMINATE_SERVE=all is not supported on Windows')) {
    fail('install.ps1 must reject unsupported Windows terminate-serve mode');
  }
  if (!installPs1.includes('Test-DefaultBlockedWideRoot')) {
    fail('install.ps1 missing default external-drive root block');
  }
	  if (!installPs1.includes('Test-PrivateBlockedRoot')) {
	    fail('install.ps1 missing private machine-memory root block');
	  }
	  if (!installPs1.includes('Test-PathWithin $ResolvedPrivate $ResolvedPath')) {
	    fail('install.ps1 must block broad roots that contain private Codex/GBrain trees');
	  }
	  if (!installPs1.includes('$Resolved = Resolve-InstallPath $RootEntry')) {
	    fail('install.ps1 must resolve machine-memory roots through final filesystem targets');
	  }
	  if (!installPs1.includes('$Item.Target')) {
	    fail('install.ps1 must inspect reparse-point or symlink targets during root validation');
	  }
	  if (!installPs1.includes('machine memory root does not exist or is unreadable')) {
	    fail('install.ps1 must reject missing machine-memory roots');
	  }
  if (!installPs1.includes('^/run/media/')) {
    fail('install.ps1 missing /run/media external-drive root block');
  }
  if (!installPs1.includes('GBrain Machine Memory Sync')) fail('install.ps1 missing machine-memory Scheduled Task');
  if (!machineMemoryJs.includes("terminateServe: process.env.GBRAIN_MACHINE_TERMINATE_SERVE || 'none'")) {
    fail('machine-memory runner default terminate mode must be none');
  }
  for (const commandLine of [
    'gbrain serve',
    '/usr/local/bin/gbrain serve --port 1234',
    'bun /opt/garrytan/gbrain/src/cli.ts serve',
    'node /opt/@garrytan/gbrain/dist/cli.js serve',
    'npx gbrain serve',
  ]) {
    if (!machineMemory.isGbrainServeProcess(commandLine)) {
      fail(`machine-memory runner did not detect gbrain serve process: ${commandLine}`);
    }
  }
	  for (const commandLine of [
	    'node /tmp/not-gbrain.js serve',
	    'grep gbrain serve',
	    'bash -lc gbrain serve',
	  ]) {
	    if (machineMemory.isGbrainServeProcess(commandLine)) {
	      fail(`machine-memory runner falsely detected gbrain serve process: ${commandLine}`);
	    }
	  }
	  let killCalled = false;
	  let sleepCalls = 0;
	  try {
	    machineMemory.terminateServe('all', { dryRun: false, json: true }, {
	      findServeProcesses: () => [{ pid: 4242, ppid: 1, args: 'gbrain serve' }],
	      kill: (pid, signal) => {
	        if (pid !== 4242 || signal !== 'SIGTERM') fail('terminateServe sent wrong signal');
	        killCalled = true;
	      },
	      sleep: () => { sleepCalls += 1; },
	    });
	    fail('terminateServe must fail when gbrain serve survives SIGTERM');
	  } catch (err) {
	    if (!/could not terminate gbrain serve/.test(err.message)) throw err;
	  }
	  if (!killCalled || sleepCalls === 0) {
	    fail('terminateServe did not signal and wait for survivor before failing');
	  }
	  if (machineMemoryJs.includes("'stale'")) {
	    fail('machine-memory runner must not advertise unimplemented stale mode');
	  }
  if (!machineMemoryJs.includes("ext === '.cmd' || ext === '.bat'")) {
    fail('machine-memory runner missing Windows cmd shim handling');
  }
  if (!machineMemoryJs.includes('function quoteCmdArg')) {
    fail('machine-memory runner missing Windows cmd argument quoting helper');
  }
  if (!machineMemoryJs.includes("[command, ...args].map(quoteCmdArg).join(' ')")) {
    fail('machine-memory runner must pass a single quoted command line to cmd.exe');
  }
  if (machineMemoryJs.includes("args: ['/d', '/s', '/c', command, ...args]")) {
    fail('machine-memory runner must not pass untrusted args raw through cmd.exe');
  }
  if (!machineMemoryJs.includes("ext === '.ps1'")) {
    fail('machine-memory runner missing Windows PowerShell shim handling');
  }
  if (machineMemoryJs.includes("gbrain(['sources', 'status', '--json']")) {
    fail('machine-memory runner must not run the live probing sources status command');
  }
  if (!machineMemoryJs.includes("gbrain(['status', '--json', '--section', 'sync']")) {
    fail('machine-memory runner must confirm sync-enabled source status before sync');
  }
	  if (!machineMemoryJs.includes('const syncStatusIndex = dryRunPlannedOnly ? buildSourceIndex([])')) {
	    fail('machine-memory dry-run must not query live sync status for planned sources');
	  }
	  if (!machineMemoryJs.includes('const configSourceIndex = dryRunPlannedOnly ? buildSourceIndex([])')) {
	    fail('machine-memory planned dry-run must not read private GBrain config');
	  }
	  if (!machineMemoryJs.includes('sourceIdForRepo(repo, hashLength)')) {
	    fail('machine-memory registration must retry deterministic source-id collisions');
	  }
  if (!evalJs.includes("live ? 300000 : 8000")) {
    fail('eval.js must use a longer default HTTP timeout for live bridge-backed evals');
  }
  if (!evalJs.includes('BRIDGEBRAIN_EVAL_ALLOW_REMOTE')) fail('eval.js live mode must require opt-in for remote eval URLs');
  if (!evalJs.includes('hit_rate_at_k')) fail('eval.js must report hit_rate_at_k separately from recall_at_k');
  if (!packageGuardJs.includes('.env(\\/|\\.|$)')) fail('package guard must block .env directories');
  if (!installSh.includes('wait_for_health')) fail('install.sh installer must poll service health');
  if (!installSh.includes('wait_for_authenticated_embeddings')) fail('install.sh installer must validate configured token against service');
  if (!installSh.includes('check_node_version')) fail('install.sh must enforce Node.js 18+');
  if (!installSh.includes('protect_gbrain_config')) fail('install.sh must protect tokenized GBrain config file');
  if (!installSh.includes('validate_token()')) fail('install.sh missing token validation helper');
  if (!installSh.includes('BridgeBrain token must be 8..256 URL-safe characters.')) {
    fail('install.sh token validation must reject unsafe token values');
  }
  if (!installSh.includes('machine memory root does not exist or is unreadable')) {
    fail('install.sh must reject missing machine-memory roots before scheduler install');
  }
  if (!installSh.includes('if resolved="$(cd "$value"')) fail('install.sh must separate path resolution fallback from command output');
  if (!installSh.includes('systemd unit values must not contain newlines')) fail('install.sh must reject unsafe systemd substitutions');
  if (!installSh.includes('CODEX_HOME_SYSTEMD_ESC')) fail('install.sh must systemd-escape machine-memory env values');
  if (!installSh.includes('launchctl start com.gbrain.bridgebrain.machine-sync') || installSh.includes('launchctl start com.gbrain.bridgebrain.machine-sync || true')) {
    fail('install.sh machine-memory sync-now must not silently ignore launchctl start failure');
  }
  if (!embeddingSystemd.includes('ExecStart="@NODE_BIN@"')) fail('systemd embedding service must quote ExecStart paths');
  if (!embeddingSystemd.includes('Environment="CODEX_HOME=@CODEX_HOME@"')) fail('systemd embedding service must quote environment assignments');
  if (!embeddingSystemd.includes('Environment="BRIDGEBRAIN_ALLOW_PATH_TOKEN=1"')) {
    fail('systemd embedding service must explicitly opt into tokenized path compatibility');
  }
  if (!machineLaunchd.includes('<key>CODEX_HOME</key>')) {
    fail('launchd machine-memory template missing CODEX_HOME environment');
  }
  const embeddingLaunchd = fs.readFileSync(path.join(root, 'launchd', 'com.gbrain.bridgebrain.embeddings.plist.template'), 'utf8');
  if (!embeddingLaunchd.includes('<key>BRIDGEBRAIN_ALLOW_PATH_TOKEN</key>')) {
    fail('launchd embedding service must explicitly opt into tokenized path compatibility');
  }
  if (!installSh.includes('MACHINE_MEMORY_SCRIPT_SYSTEMD_ESC')) {
    fail('install.sh must render quoted systemd machine-memory script path');
  }
  if (!machineMemoryJs.includes("gbrain(['sources', 'archived', '--json']")) {
    fail('machine-memory runner must check archived sources before sync');
  }
  if (!machineMemoryJs.includes("--terminate-serve=all is not supported on Windows")) {
    fail('machine-memory runner must reject unsupported Windows terminate-serve mode');
  }
  if (installPs1.includes('--no-embedding')) fail('install.ps1 must not use --no-embedding for fresh init');
  if (!installPs1.includes('function Test-BridgeBrainToken($Value)')) fail('install.ps1 missing token validation helper');
  if (!installPs1.includes('BridgeBrain token must be 8..256 URL-safe characters.')) {
    fail('install.ps1 token validation must reject unsafe token values');
  }
	  if (!installPs1.includes('"--embedding-model", "litellm:$ModelName"')) fail('install.ps1 missing embedding model init flag');
	  if (!installPs1.includes('--skip-embed-check')) fail('install.ps1 missing skip embed check init flag');
	  if (!installPs1.includes('Protect-LocalSecretPath $ConfigFile')) fail('install.ps1 does not protect tokenized config file');
	  if (!installPs1.includes('/remove:g $BroadPrincipal')) fail('install.ps1 must remove broad explicit ACL principals');
	  for (const broadPrincipal of ['*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11', '*S-1-5-32-546']) {
	    if (!installPs1.includes(broadPrincipal)) fail(`install.ps1 missing broad ACL removal for ${broadPrincipal}`);
	  }
	  if (!installPs1.includes('$env:BRIDGEBRAIN_ALLOW_PATH_TOKEN = "1"')) {
    fail('install.ps1 service runner must explicitly opt into tokenized path compatibility');
  }
  if (!installPs1.includes('if ($SkipService -and -not $DryRun -and -not $TokenSupplied)')) {
    fail('install.ps1 dry-run skip-service path must not require a real token');
  }
  if ((installPs1.match(/function Fail\(\$Message\)/g) || []).length !== 1) {
    fail('install.ps1 must define Fail exactly once before early validation');
  }
  if (!verifyPs1.includes('Join-Path $GbrainConfigDir "config.json"')) fail('verify.ps1 must use GBRAIN_HOME/.gbrain config path');
  if (!verifyPs1.includes('$env:GPT_WEB_LOGIN_CODEX_BIN = $CodexBin')) fail('verify.ps1 does not honor CODEX_BIN for bridge status');
  if (!verifyPs1.includes('BRIDGEBRAIN_VERIFY_ALLOW_REMOTE')) fail('verify.ps1 must reject non-loopback provider URLs by default');
	  if (!verifyPs1.includes('remote provider URLs must use https when credentials would be sent')) {
	    fail('verify.ps1 must reject remote HTTP credential-bearing provider URLs');
	  }
	  if (!verifyPs1.includes('Get-ServiceHealthUrl $BaseUrl $RequestAuthToken')) {
	    fail('verify.ps1 must include bearer auth in remote HTTP credential checks');
	  }
	  if (!verifyPs1.includes('if ($Token)') || !verifyPs1.includes('Test-CredentialUrl $BaseUriForAuth')) {
	    fail('verify.ps1 must send bearer auth for configured non-tokenized base URLs');
	  }
	  if (!verifySh.includes('base_url_path_token')) fail('verify.sh must parse tokenized provider base URLs explicitly');
	  if (!verifySh.includes('does not match tokenized provider base URL')) {
	    fail('verify.sh must reject mismatched env token plus tokenized provider URL');
	  }
  if (!verifySh.includes('remote provider URLs must use https when credentials would be sent')) {
    fail('verify.sh must reject remote HTTP credential-bearing provider URLs');
  }
	  if (!verifySh.includes('hasCredentialMaterial(url) || hasHeaderCredential')) {
	    fail('verify.sh must include bearer auth in remote HTTP credential checks');
	  }
  if (!verifySh.includes('node_http_json')) fail('verify.sh must keep tokenized provider URLs out of HTTP subprocess argv');
  if (!verifySh.includes('function healthPath(url)') || !verifySh.includes('return `${prefix}/health`;')) {
    fail('verify.sh must preserve provider base path when deriving health URL');
  }
  if (!verifyPs1.includes('function Get-HealthPath($Parsed)') || !verifyPs1.includes("$PathPrefix = $Parsed.AbsolutePath -replace '/v1(/t/[^/]+)?/?$', ''")) {
    fail('verify.ps1 must preserve provider base path when deriving health URL');
  }
	  if (!verifyPs1.includes('-TimeoutSec 20')) fail('verify.ps1 HTTP probes must have bounded timeouts');
	  if (!verifyPs1.includes('Invoke-CaptureChecked "GBrain doctor" $GbrainBin @("doctor", "--json")')) fail('verify.ps1 does not honor GBRAIN_BIN for doctor');
	  if (!installSh.includes('GBRAIN_INSTALL_SPEC') || !installPs1.includes('$GbrainInstallSpec')) {
	    fail('installers must pin optional GBrain install source by default');
	  }
  if (installPs1.indexOf('if ($DryRun) {') > installPs1.indexOf('if (-not $NodeBin)')) {
    fail('install.ps1 dry-run must happen before dependency checks');
  }

  const result = spawnSync('bash', ['scripts/install.sh', '--skip-service', '--skip-verify'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.status !== 0) {
    fail(`install.sh smoke failed\\nstdout:\\n${result.stdout}\\nstderr:\\n${result.stderr}`);
  }

  const configFile = path.join(gbrainHome, '.gbrain', 'config.json');
  if (!fs.existsSync(configFile)) fail('installer did not write GBRAIN_HOME/.gbrain/config.json');

  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.embedding_dimensions !== 1536) fail(`unexpected dimensions: ${config.embedding_dimensions}`);
  if (config.embedding_model !== 'litellm:chatgpt-bridge-semantic-hash-1536') {
    fail(`unexpected embedding model: ${config.embedding_model}`);
  }
  const expectedFixtureBaseUrl = ['http://127.0.0.1:59998/v1', 'ismoketest'].join('/t/');
  if (!config.provider_base_urls || config.provider_base_urls.litellm !== expectedFixtureBaseUrl) {
    fail(`unexpected litellm base URL: ${JSON.stringify(config.provider_base_urls)}`);
  }

  const patchedGateway = fs.readFileSync(gateway, 'utf8');
  if (!patchedGateway.includes('!parsed.modelId')) fail('gateway patch smoke did not patch fake gateway.ts');
  const patchedDimCheck = fs.readFileSync(dimCheck, 'utf8');
  if (!patchedDimCheck.includes('BridgeBrain proxy recipes declare their own vector width')) {
    fail('dim-check patch smoke did not patch fake embedding-dim-check.ts');
  }
  if (!fs.existsSync(path.join(codexHome, 'services', 'gbrain-chatgpt-embeddings', 'server.js'))) {
    fail('installer did not copy service server.js into CODEX_HOME');
  }

  const repoRoot = path.join(temp, 'repos');
  const repoOne = path.join(repoRoot, 'Example Repo');
  const genericNamedRepo = path.join(repoRoot, 'build');
  const codexRepo = path.join(repoRoot, '.codex', 'Private Repo');
  fs.mkdirSync(path.join(repoOne, '.git'), { recursive: true });
  fs.mkdirSync(path.join(genericNamedRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(codexRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'not-a-repo'), { recursive: true });

  const lockedInstallHome = path.join(temp, 'locked-home');
  const lockedCodexHome = path.join(temp, 'locked-codex');
  fs.mkdirSync(lockedInstallHome, { recursive: true });
  const lockedInstall = spawnSync('bash', ['scripts/install.sh', '--machine-memory', '--skip-service', '--skip-verify'], {
    cwd: root,
    env: {
      ...env,
      HOME: lockedInstallHome,
      CODEX_HOME: lockedCodexHome,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '',
      GBRAIN_MACHINE_ROOTS: repoRoot,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (lockedInstall.status === 0) {
    fail('install.sh --machine-memory must fail without BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1');
  }
  if (fs.existsSync(path.join(lockedCodexHome, 'services', 'gbrain-chatgpt-embeddings', 'server.js'))) {
    fail('locked machine-memory install copied service files before guard failure');
  }

  const invalidTerminateHome = path.join(temp, 'invalid-terminate-home');
  const invalidTerminateCodexHome = path.join(temp, 'invalid-terminate-codex');
  fs.mkdirSync(invalidTerminateHome, { recursive: true });
  const invalidTerminate = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--machine-memory',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: invalidTerminateHome,
      CODEX_HOME: invalidTerminateCodexHome,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
      GBRAIN_MACHINE_ROOTS: repoRoot,
      GBRAIN_MACHINE_TERMINATE_SERVE: 'stale',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (invalidTerminate.status === 0) {
    fail('install.sh --machine-memory must fail on invalid GBRAIN_MACHINE_TERMINATE_SERVE');
  }
  if (fs.existsSync(invalidTerminateCodexHome)) {
    fail('invalid terminate dry-run wrote Codex fixture files');
  }

  const missingRootHome = path.join(temp, 'missing-root-home');
  const missingRootCodexHome = path.join(temp, 'missing-root-codex');
  fs.mkdirSync(missingRootHome, { recursive: true });
  const missingRootInstall = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--machine-memory',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: missingRootHome,
      CODEX_HOME: missingRootCodexHome,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
      GBRAIN_MACHINE_ROOTS: path.join(temp, 'does-not-exist'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (missingRootInstall.status === 0) {
    fail('install.sh --machine-memory must fail on missing machine-memory root');
  }
  if (fs.existsSync(missingRootCodexHome)) {
    fail('missing root dry-run wrote Codex fixture files');
  }

  const dryHome = path.join(temp, 'dry-home');
  const dryCodexHome = path.join(temp, 'dry-codex');
  const dryGbrainHome = path.join(temp, 'dry-gbrain');
  const dryRepoRoot = path.join(temp, 'dry-repos');
  fs.mkdirSync(path.join(dryRepoRoot, 'Dry Repo', '.git'), { recursive: true });
  const dryRun = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--machine-memory',
    '--machine-memory-sync-now',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: dryHome,
      CODEX_HOME: dryCodexHome,
      GBRAIN_HOME: dryGbrainHome,
      BRIDGEBRAIN_INSTALL_OS: 'Darwin',
      GBRAIN_MACHINE_ROOTS: dryRepoRoot,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (dryRun.status !== 0) {
    fail(`install.sh dry-run failed\\nstdout:\\n${dryRun.stdout}\\nstderr:\\n${dryRun.stderr}`);
  }
  if (!dryRun.stdout.includes('Platform: Darwin')) fail('dry-run did not honor fixture platform');
  if (!dryRun.stdout.includes('No files will be written')) fail('dry-run output missing no-write guarantee');
  if (dryRun.stdout.includes('ismoketest')) fail('dry-run leaked token value');
  if (fs.existsSync(dryCodexHome) || fs.existsSync(path.join(dryGbrainHome, '.gbrain'))) {
    fail('dry-run wrote Codex or GBrain fixture files');
  }

  const noDepsBin = path.join(temp, 'no-deps-bin');
  const noDepsHome = path.join(temp, 'no-deps-home');
  const noDepsCodexHome = path.join(temp, 'no-deps-codex');
  const noDepsGbrainHome = path.join(temp, 'no-deps-gbrain');
  fs.mkdirSync(noDepsBin, { recursive: true });
  fs.mkdirSync(noDepsHome, { recursive: true });
  fs.symlinkSync('/usr/bin/cat', path.join(noDepsBin, 'cat'));
  fs.symlinkSync('/usr/bin/dirname', path.join(noDepsBin, 'dirname'));
  fs.symlinkSync('/usr/bin/uname', path.join(noDepsBin, 'uname'));
  const noDepsDryRun = spawnSync('/bin/bash', [
    'scripts/install.sh',
    '--dry-run',
  ], {
    cwd: root,
    env: {
      HOME: noDepsHome,
      CODEX_HOME: noDepsCodexHome,
      GBRAIN_HOME: noDepsGbrainHome,
      PATH: noDepsBin,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (noDepsDryRun.status !== 0) {
    fail(`install.sh dry-run must not require Node/Codex/GBrain\nstdout:\n${noDepsDryRun.stdout}\nstderr:\n${noDepsDryRun.stderr}`);
  }
  if (!noDepsDryRun.stdout.includes('BridgeBrain dry-run plan')) {
    fail('dependency-free dry-run output missing dry-run plan');
  }
  if (fs.existsSync(noDepsCodexHome) || fs.existsSync(path.join(noDepsGbrainHome, '.gbrain'))) {
    fail('dependency-free dry-run wrote Codex or GBrain fixture files');
  }

  const invalidTokenHome = path.join(temp, 'invalid-token-home');
  const invalidTokenCodexHome = path.join(temp, 'invalid-token-codex');
  const invalidTokenGbrainHome = path.join(temp, 'invalid-token-gbrain');
  fs.mkdirSync(invalidTokenHome, { recursive: true });
  const invalidTokenDryRun = spawnSync('/bin/bash', [
    'scripts/install.sh',
    '--dry-run',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: invalidTokenHome,
      CODEX_HOME: invalidTokenCodexHome,
      GBRAIN_HOME: invalidTokenGbrainHome,
      BRIDGEBRAIN_API_TOKEN: 'bad/token',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (invalidTokenDryRun.status === 0) {
    fail('install.sh dry-run accepted invalid supplied token');
  }
  if (fs.existsSync(invalidTokenCodexHome) || fs.existsSync(path.join(invalidTokenGbrainHome, '.gbrain'))) {
    fail('invalid token dry-run wrote Codex or GBrain fixture files');
  }

  const dryInstallGbrainHome = path.join(temp, 'dry-install-gbrain-home');
  const dryInstallGbrainCodexHome = path.join(temp, 'dry-install-gbrain-codex');
  const dryInstallGbrainGbrainHome = path.join(temp, 'dry-install-gbrain-gbrain');
  fs.mkdirSync(dryInstallGbrainHome, { recursive: true });
  const dryInstallGbrain = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--install-gbrain',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: dryInstallGbrainHome,
      CODEX_HOME: dryInstallGbrainCodexHome,
      GBRAIN_HOME: dryInstallGbrainGbrainHome,
      GBRAIN_BIN: '',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (dryInstallGbrain.status !== 0) {
    fail(`install.sh dry-run install-gbrain path failed\nstdout:\n${dryInstallGbrain.stdout}\nstderr:\n${dryInstallGbrain.stderr}`);
  }
  if (!dryInstallGbrain.stdout.includes('Install GBrain: would install if missing')) {
    fail('dry-run install-gbrain output missing install plan');
  }
  if (fs.existsSync(dryInstallGbrainCodexHome) || fs.existsSync(path.join(dryInstallGbrainGbrainHome, '.gbrain'))) {
    fail('dry-run install-gbrain path wrote Codex or GBrain fixture files');
  }

  const macHome = path.join(temp, 'mac & home');
  const macCodexHome = path.join(temp, 'mac & codex');
  const macGbrainHome = path.join(temp, 'mac & gbrain');
  const macRepoRoot = path.join(temp, 'R&D Roots');
  fs.mkdirSync(macHome, { recursive: true });
  fs.mkdirSync(path.join(macRepoRoot, 'Repo One', '.git'), { recursive: true });
  const macInstall = spawnSync('bash', ['scripts/install.sh', '--machine-memory', '--skip-service', '--skip-verify'], {
    cwd: root,
    env: {
      ...env,
      HOME: macHome,
      CODEX_HOME: macCodexHome,
      GBRAIN_HOME: macGbrainHome,
      BRIDGEBRAIN_INSTALL_OS: 'Darwin',
      GBRAIN_MACHINE_ROOTS: macRepoRoot,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (macInstall.status !== 0) {
    fail(`macOS fixture install failed\\nstdout:\\n${macInstall.stdout}\\nstderr:\\n${macInstall.stderr}`);
  }
  const machinePlist = fs.readFileSync(
    path.join(macHome, 'Library', 'LaunchAgents', 'com.gbrain.bridgebrain.machine-sync.plist'),
    'utf8',
  );
  if (!machinePlist.includes('R&amp;D Roots')) fail('machine-memory launchd plist did not XML-escape roots');
  if (!machinePlist.includes('mac &amp; gbrain')) fail('machine-memory launchd plist did not XML-escape GBRAIN_HOME');
  if (machinePlist.includes('R&D Roots') || machinePlist.includes('mac & gbrain')) {
    fail('machine-memory launchd plist contains raw XML metacharacters');
  }

  const lockedCandidates = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    repoRoot,
    '--json',
  ], {
    cwd: root,
    env: { ...env, BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (lockedCandidates.status === 0) {
    fail('machine-memory discovery must fail without BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1');
  }
  const candidates = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    repoRoot,
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (candidates.status !== 0) {
    fail(`machine-memory candidates smoke failed\\nstdout:\\n${candidates.stdout}\\nstderr:\\n${candidates.stderr}`);
  }
  const candidateJson = JSON.parse(candidates.stdout);
  if (!candidateJson.repos.includes(repoOne)) fail('machine-memory discovery did not find fake git repo');
  if (candidateJson.repos.includes(genericNamedRepo)) {
    fail('machine-memory discovery must skip generated/build directory names even when they contain .git');
  }
  if (candidateJson.repos.includes(codexRepo)) fail('machine-memory discovery must not traverse .codex');

  const privateParent = path.join(temp, 'private-parent');
  const publicUnderParent = path.join(privateParent, 'Public Repo');
  const customCodexHome = path.join(privateParent, 'codex-home');
  const privateUnderCodex = path.join(customCodexHome, 'Private Repo');
  fs.mkdirSync(path.join(publicUnderParent, '.git'), { recursive: true });
  fs.mkdirSync(path.join(privateUnderCodex, '.git'), { recursive: true });
  const privatePrune = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    privateParent,
    '--json',
  ], {
    cwd: root,
    env: { ...env, CODEX_HOME: customCodexHome },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (privatePrune.status !== 0) {
    fail(`machine-memory private prune smoke failed\\nstdout:\\n${privatePrune.stdout}\\nstderr:\\n${privatePrune.stderr}`);
  }
  const privatePruneJson = JSON.parse(privatePrune.stdout);
  if (!privatePruneJson.repos.includes(publicUnderParent)) {
    fail(`machine-memory private prune missed public repo: ${privatePrune.stdout}`);
  }
  if (privatePruneJson.repos.includes(privateUnderCodex)) {
    fail('machine-memory discovery traversed custom CODEX_HOME under parent root');
  }

  const wideRoot = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    home,
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (wideRoot.status === 0) {
    fail('machine-memory discovery must block whole-home roots by default');
  }
  const codexPrivateRoot = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    codexHome,
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (codexPrivateRoot.status === 0) {
    fail('machine-memory discovery must block explicit CODEX_HOME roots by default');
  }
  const gbrainPrivateRoot = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    path.join(gbrainHome, '.gbrain'),
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (gbrainPrivateRoot.status === 0) {
    fail('machine-memory discovery must block explicit GBrain data roots by default');
  }
  const externalRoot = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    path.join('/', 'media', 'bridgebrain-test', 'External Drive'),
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (externalRoot.status === 0) {
    fail('machine-memory discovery must block external-drive roots by default');
  }
  const runMediaRoot = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'candidates',
    '--roots',
    path.join('/', 'run', 'media', 'bridgebrain-test', 'External Drive'),
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (runMediaRoot.status === 0) {
    fail('machine-memory discovery must block /run/media external-drive roots by default');
  }

  const externalInstallHome = path.join(temp, 'external-install-home');
  const externalInstallCodexHome = path.join(temp, 'external-install-codex');
  fs.mkdirSync(externalInstallHome, { recursive: true });
  const externalInstall = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--machine-memory',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: externalInstallHome,
      CODEX_HOME: externalInstallCodexHome,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
      GBRAIN_MACHINE_ROOTS: path.join('/', 'run', 'media', 'bridgebrain-test', 'External Drive'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (externalInstall.status === 0) {
    fail('install.sh --machine-memory must block external-drive roots by default');
  }
  if (fs.existsSync(externalInstallCodexHome)) {
    fail('external-drive dry-run wrote Codex fixture files');
  }

  const privateInstallHome = path.join(temp, 'private-install-home');
  const privateInstallCodexHome = path.join(temp, 'private-install-codex');
  fs.mkdirSync(privateInstallHome, { recursive: true });
  const privateInstall = spawnSync('bash', [
    'scripts/install.sh',
    '--dry-run',
    '--machine-memory',
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: privateInstallHome,
      CODEX_HOME: privateInstallCodexHome,
      BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
      GBRAIN_MACHINE_ROOTS: privateInstallCodexHome,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (privateInstall.status === 0) {
    fail('install.sh --machine-memory must block private CODEX_HOME roots by default');
  }
  if (fs.existsSync(privateInstallCodexHome)) {
    fail('private-root dry-run wrote Codex fixture files');
  }

  const registerDryRun = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'register',
    '--roots',
    repoRoot,
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (registerDryRun.status !== 0) {
    fail(`machine-memory register dry-run failed\\nstdout:\\n${registerDryRun.stdout}\\nstderr:\\n${registerDryRun.stderr}`);
  }
  const registerJson = JSON.parse(registerDryRun.stdout);
  const registeredPaths = registerJson.registered.map((item) => item.path);
  if (!registeredPaths.includes(repoOne)) {
    fail(`machine-memory register dry-run missed expected repos: ${registerDryRun.stdout}`);
  }
  if (registeredPaths.includes(genericNamedRepo)) {
    fail(`machine-memory register dry-run must skip generated/build directory names: ${registerDryRun.stdout}`);
  }
  if (registerJson.registered.some((item) => !/^mm-/.test(item.id))) {
    fail(`machine-memory register dry-run returned unexpected summary: ${registerDryRun.stdout}`);
  }

  const freshSyncRoot = path.join(temp, 'fresh-sync-repos');
  const freshSyncRepo = path.join(freshSyncRoot, 'Fresh Repo');
  fs.mkdirSync(path.join(freshSyncRepo, '.git'), { recursive: true });
  const firstRunDryRun = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'sync-once',
    '--roots',
    freshSyncRoot,
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (firstRunDryRun.status !== 0) {
    fail(`machine-memory first-run dry-run failed\\nstdout:\\n${firstRunDryRun.stdout}\\nstderr:\\n${firstRunDryRun.stderr}`);
  }
  const firstRunJson = JSON.parse(firstRunDryRun.stdout);
  if (firstRunJson.registered.length !== 1 || firstRunJson.registered[0].path !== freshSyncRepo) {
    fail(`first-run dry-run did not plan source registration: ${firstRunDryRun.stdout}`);
  }
	  const firstRunSync = firstRunJson.sync.find((item) => item.id === firstRunJson.registered[0].id);
	  if (!firstRunSync || firstRunSync.status !== 'dry_run') {
	    fail(`first-run dry-run did not preview planned source sync: ${firstRunDryRun.stdout}`);
	  }
	  const malformedDryRunGbrainHome = path.join(temp, 'malformed-dryrun-gbrain');
	  fs.mkdirSync(path.join(malformedDryRunGbrainHome, '.gbrain'), { recursive: true });
	  fs.writeFileSync(path.join(malformedDryRunGbrainHome, '.gbrain', 'config.json'), '{"api_key": raw-private-token\n');
	  const malformedConfigDryRun = spawnSync(process.execPath, [
	    'scripts/setup-machine-memory.js',
	    'sync-once',
	    '--roots',
	    freshSyncRoot,
	    '--dry-run',
	    '--json',
	  ], {
	    cwd: root,
	    env: {
	      ...env,
	      GBRAIN_HOME: malformedDryRunGbrainHome,
	    },
	    encoding: 'utf8',
	    timeout: 30_000,
	  });
	  if (malformedConfigDryRun.status !== 0) {
	    fail(`planned dry-run read private GBrain config\\nstdout:\\n${malformedConfigDryRun.stdout}\\nstderr:\\n${malformedConfigDryRun.stderr}`);
	  }

	  const staleRepo = path.join(temp, 'stale-repo');
  const disabledRepo = path.join(repoRoot, 'Disabled Repo');
  const implicitRepo = path.join(repoRoot, 'Implicit Repo');
  const legacyDisabledRepo = path.join(repoRoot, 'Legacy Disabled Repo');
  const statusDisabledRepo = path.join(repoRoot, 'Status Disabled Repo');
  const archivedRepo = path.join(repoRoot, 'Archived Repo');
  fs.mkdirSync(path.join(staleRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(disabledRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(implicitRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(legacyDisabledRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(statusDisabledRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(archivedRepo, '.git'), { recursive: true });
  const disabledGbrainHome = path.join(temp, 'disabled-gbrain');
  fs.mkdirSync(path.join(disabledGbrainHome, '.gbrain'), { recursive: true });
  fs.writeFileSync(
    path.join(disabledGbrainHome, '.gbrain', 'config.json'),
    JSON.stringify({
      sources: {
        'mm-disabled-33333333': {
          local_path: disabledRepo,
          syncEnabled: false,
        },
      },
      source_configs: {
        'mm-legacy-disabled-77777777': {
          local_path: legacyDisabledRepo,
          sync_enabled: false,
        },
      },
    }),
  );
  const syncDryRun = spawnSync(process.execPath, [
    'scripts/setup-machine-memory.js',
    'sync-once',
    '--roots',
    repoRoot,
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    env: {
      ...env,
      GBRAIN_HOME: disabledGbrainHome,
      GBRAIN_FAKE_SOURCES_JSON: JSON.stringify({
        sources: [
          { id: 'mm-current-11111111', local_path: repoOne },
          { id: 'mm-stale-22222222', local_path: staleRepo },
          { sourceId: 'mm-disabled-33333333', path: disabledRepo },
          { id: 'mm-implicit-66666666', local_path: implicitRepo },
          { id: 'mm-legacy-disabled-77777777', local_path: legacyDisabledRepo },
          { id: 'mm-archived-44444444', local_path: archivedRepo },
          { id: 'mm-status-disabled-55555555', local_path: statusDisabledRepo },
        ],
      }),
      GBRAIN_FAKE_SOURCES_STATUS_JSON: JSON.stringify({
        schema_version: 1,
        sources: [
          { source_id: 'mm-current-11111111', local_path: repoOne },
          { source_id: 'mm-disabled-33333333', local_path: disabledRepo },
          {
            source_id: 'mm-status-disabled-55555555',
            local_path: statusDisabledRepo,
            config: { syncEnabled: false },
          },
        ],
      }),
      GBRAIN_FAKE_STATUS_JSON: JSON.stringify({
        schema_version: 1,
        sync: {
          sources: [
            { source_id: 'mm-current-11111111', local_path: repoOne, sync_enabled: true },
            { source_id: 'mm-disabled-33333333', local_path: disabledRepo, sync_enabled: true },
            { source_id: 'mm-implicit-66666666', local_path: implicitRepo },
            { source_id: 'mm-legacy-disabled-77777777', local_path: legacyDisabledRepo, sync_enabled: true },
            { source_id: 'mm-archived-44444444', local_path: archivedRepo, sync_enabled: true },
            { source_id: 'mm-status-disabled-55555555', local_path: statusDisabledRepo, sync_enabled: false },
          ],
        },
      }),
      GBRAIN_FAKE_ARCHIVED_SOURCES_JSON: JSON.stringify({
        archived: [
          { id: 'mm-archived-44444444', name: 'Archived Repo' },
        ],
      }),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (syncDryRun.status !== 0) {
    fail(`machine-memory sync dry-run failed\\nstdout:\\n${syncDryRun.stdout}\\nstderr:\\n${syncDryRun.stderr}`);
  }
  const syncJson = JSON.parse(syncDryRun.stdout);
  const syncIds = syncJson.sync.map((item) => item.id);
  if (!syncIds.includes('mm-current-11111111')) fail(`sync dry-run missed current source: ${syncDryRun.stdout}`);
  if (syncIds.includes('mm-stale-22222222')) fail(`sync dry-run included stale out-of-root source: ${syncDryRun.stdout}`);
  const disabledResult = syncJson.sync.find((item) => item.id === 'mm-disabled-33333333');
  if (!disabledResult || disabledResult.status !== 'skipped' || disabledResult.reason !== 'sync disabled') {
    fail(`sync dry-run did not skip config-disabled source: ${syncDryRun.stdout}`);
  }
  const implicitResult = syncJson.sync.find((item) => item.id === 'mm-implicit-66666666');
  if (!implicitResult || implicitResult.status !== 'skipped' || implicitResult.reason !== 'sync not explicitly enabled') {
    fail(`sync dry-run did not skip implicitly enabled source: ${syncDryRun.stdout}`);
  }
  const legacyDisabledResult = syncJson.sync.find((item) => item.id === 'mm-legacy-disabled-77777777');
  if (!legacyDisabledResult || legacyDisabledResult.status !== 'skipped' || legacyDisabledResult.reason !== 'sync disabled') {
    fail(`sync dry-run did not skip legacy config-disabled source: ${syncDryRun.stdout}`);
  }
  const statusDisabledResult = syncJson.sync.find((item) => item.id === 'mm-status-disabled-55555555');
  if (!statusDisabledResult || statusDisabledResult.status !== 'skipped') {
    fail(`sync dry-run did not skip status-disabled source: ${syncDryRun.stdout}`);
  }
  const archivedResult = syncJson.sync.find((item) => item.id === 'mm-archived-44444444');
  if (!archivedResult || archivedResult.status !== 'skipped' || archivedResult.reason !== 'archived source') {
    fail(`sync dry-run did not skip archived source: ${syncDryRun.stdout}`);
  }

  console.log('installer smoke passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
