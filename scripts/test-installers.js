#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

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

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    GBRAIN_HOME: gbrainHome,
    CODEX_BIN: path.join(bin, 'fake-codex'),
    GBRAIN_BIN: path.join(bin, 'fake-gbrain'),
    GBRAIN_GATEWAY_TS: gateway,
    NODE_BIN: process.execPath,
    GBRAIN_CHATGPT_EMBED_PORT: '59998',
    BRIDGEBRAIN_API_TOKEN: 'install-smoke-token',
    BRIDGEBRAIN_ENABLE_MACHINE_MEMORY: '1',
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };

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
  if (!machineSystemd.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) {
    fail('systemd machine-memory template missing unlock environment');
  }
  if (!machineSystemd.includes('GBRAIN_HOME=@GBRAIN_HOME@')) {
    fail('systemd machine-memory template missing GBRAIN_HOME environment');
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
  if (machineLaunchd.includes('<key>RunAtLoad</key>\n  <true/>')) {
    fail('launchd machine-memory must not run at load by default');
  }
  const installPs1 = fs.readFileSync(path.join(root, 'scripts', 'install.ps1'), 'utf8');
  const verifyPs1 = fs.readFileSync(path.join(root, 'scripts', 'verify.ps1'), 'utf8');
  const installSh = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  const machineMemoryJs = fs.readFileSync(path.join(root, 'scripts', 'setup-machine-memory.js'), 'utf8');
  if (!installSh.includes('--machine-memory')) fail('install.sh missing machine-memory flag');
  if (!installSh.includes('--dry-run')) fail('install.sh missing dry-run flag');
  if (!installSh.includes('sed_xml_escape')) fail('install.sh missing launchd XML escaping helper');
  if (!installSh.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) fail('install.sh missing machine-memory unlock guard');
  if (!installSh.includes('GBRAIN_MACHINE_TERMINATE_SERVE must be none or all')) {
    fail('install.sh must reject invalid terminate-serve mode');
  }
  if (!installPs1.includes('MachineMemory')) fail('install.ps1 missing MachineMemory switch');
  if (!installPs1.includes('[switch]$DryRun')) fail('install.ps1 missing DryRun switch');
  if (!installPs1.includes('Write-DryRunPlan')) fail('install.ps1 missing dry-run plan output');
  if (!installPs1.includes('ConvertTo-PowerShellLiteral')) fail('install.ps1 missing generated-runner literal quoting helper');
  if (!installPs1.includes('BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1')) fail('install.ps1 missing machine-memory unlock guard');
  if (!installPs1.includes('$env:BRIDGEBRAIN_ENABLE_MACHINE_MEMORY = "1"')) fail('install.ps1 machine-memory scheduled runner missing unlock env');
  if (!installPs1.includes('$env:GBRAIN_HOME = $GbrainHomeParentLiteral')) fail('install.ps1 machine-memory scheduled runner missing literal GBRAIN_HOME env');
  if (!installPs1.includes('$env:GBRAIN_MACHINE_ROOTS = $MachineMemoryRootsLiteral')) fail('install.ps1 machine-memory scheduled runner missing literal roots env');
  if (!installPs1.includes('else { "none" }')) fail('install.ps1 machine-memory terminate default must be none');
  if (!installPs1.includes('GBRAIN_MACHINE_TERMINATE_SERVE=all is not supported on Windows')) {
    fail('install.ps1 must reject unsupported Windows terminate-serve mode');
  }
  if (!installPs1.includes('GBrain Machine Memory Sync')) fail('install.ps1 missing machine-memory Scheduled Task');
  if (!machineMemoryJs.includes("terminateServe: process.env.GBRAIN_MACHINE_TERMINATE_SERVE || 'none'")) {
    fail('machine-memory runner default terminate mode must be none');
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
  if (!installPs1.includes('--embedding-model "litellm:$ModelName"')) fail('install.ps1 missing embedding model init flag');
  if (!installPs1.includes('--skip-embed-check')) fail('install.ps1 missing skip embed check init flag');
  if (!installPs1.includes('Protect-LocalSecretPath $ConfigFile')) fail('install.ps1 does not protect tokenized config file');
  if (!verifyPs1.includes('Join-Path $GbrainConfigDir "config.json"')) fail('verify.ps1 must use GBRAIN_HOME/.gbrain config path');
  if (!verifyPs1.includes('$env:GPT_WEB_LOGIN_CODEX_BIN = $CodexBin')) fail('verify.ps1 does not honor CODEX_BIN for bridge status');
  if (!verifyPs1.includes('& $GbrainBin doctor --json')) fail('verify.ps1 does not honor GBRAIN_BIN for doctor');
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
  if (!config.provider_base_urls || config.provider_base_urls.litellm !== 'http://127.0.0.1:59998/v1/t/install-smoke-token') {
    fail(`unexpected litellm base URL: ${JSON.stringify(config.provider_base_urls)}`);
  }

  const patchedGateway = fs.readFileSync(gateway, 'utf8');
  if (!patchedGateway.includes('!parsed.modelId')) fail('gateway patch smoke did not patch fake gateway.ts');
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
  if (dryRun.stdout.includes('install-smoke-token')) fail('dry-run leaked token value');
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
  if (!candidateJson.repos.includes(genericNamedRepo)) {
    fail('machine-memory discovery must not skip real repos with generic directory names');
  }
  if (candidateJson.repos.includes(codexRepo)) fail('machine-memory discovery must not traverse .codex');

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
  if (!registeredPaths.includes(repoOne) || !registeredPaths.includes(genericNamedRepo)) {
    fail(`machine-memory register dry-run missed expected repos: ${registerDryRun.stdout}`);
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

  const staleRepo = path.join(temp, 'stale-repo');
  const disabledRepo = path.join(repoRoot, 'Disabled Repo');
  const statusDisabledRepo = path.join(repoRoot, 'Status Disabled Repo');
  const archivedRepo = path.join(repoRoot, 'Archived Repo');
  fs.mkdirSync(path.join(staleRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(disabledRepo, '.git'), { recursive: true });
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
          { id: 'mm-disabled-33333333', local_path: disabledRepo },
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
  if (!disabledResult || disabledResult.status !== 'skipped') {
    fail(`sync dry-run did not skip config-disabled source: ${syncDryRun.stdout}`);
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
