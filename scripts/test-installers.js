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
if [[ "$*" == "doctor --all --json" ]]; then
  printf '%s\\n' '{"checks":{"auth.credentials":{"status":"ok","details":{"stored auth mode":"chatgpt","stored ChatGPT tokens":"true","stored API key":"false"}}},"overallStatus":"ok"}'
  exit 0
fi
echo "unexpected fake-codex args: $*" >&2
exit 2
`);

  writeExecutable(path.join(bin, 'fake-gbrain'), `#!/usr/bin/env bash
set -euo pipefail
home="\${GBRAIN_HOME:-$HOME/.gbrain}"
case "\${1:-}" in
  init)
    mkdir -p "$home"
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
  *)
    echo "unexpected fake-gbrain args: $*" >&2
    exit 2
    ;;
esac
`);

  const gateway = path.join(temp, 'gateway.ts');
  fs.writeFileSync(gateway, `  // Openai-compat recipes with empty models list require a user-provided model.
  const isUserProvided = (tp as any).user_provided_models === true;
  if (
    Array.isArray(tp.models) &&
    tp.models.length === 0 &&
    (recipe.id === 'litellm' || isUserProvided)
  ) {
`);

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
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };

  for (const template of [
    path.join(root, 'systemd', 'gbrain-chatgpt-embeddings.service.template'),
    path.join(root, 'launchd', 'com.gbrain.bridgebrain.embeddings.plist.template'),
  ]) {
    const text = fs.readFileSync(template, 'utf8');
    if (!text.includes('CODEX_HOME')) fail(`${path.basename(template)} does not export CODEX_HOME`);
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

  const configFile = path.join(gbrainHome, 'config.json');
  if (!fs.existsSync(configFile)) fail('installer did not write GBRAIN_HOME/config.json');

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

  console.log('installer smoke passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
