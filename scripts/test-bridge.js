#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const bridgeScript = path.join(
  root,
  'bridge-skill',
  'unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit',
  'scripts',
  'gpt-web-login-bridge.js',
);
const privatePrompt = 'PRIVATE_EMBED_TEXT_SHOULD_NOT_BE_IN_ARGV';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-bridge-'));

try {
  const fakeCodex = path.join(temp, 'fake-codex');
  const argvFile = path.join(temp, 'argv.json');
  const stdinFile = path.join(temp, 'stdin.txt');

  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(args));

if (args[0] === 'doctor') {
  console.log(JSON.stringify({
    checks: {
      'auth.credentials': {
        status: 'ok',
        details: {
          'stored auth mode': 'chatgpt',
          'stored ChatGPT tokens': 'true',
          'stored API key': 'false',
        },
      },
    },
    overallStatus: 'ok',
  }));
  process.exit(0);
}

if (args[0] === 'exec') {
  const input = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(process.env.STDIN_FILE, input);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'BRIDGE_TEST_OK' },
  }));
  process.exit(0);
}

console.error('unexpected fake-codex args: ' + args.join(' '));
process.exit(2);
`, { mode: 0o755 });

  const env = {
    ...process.env,
    GPT_WEB_LOGIN_CODEX_BIN: fakeCodex,
    GPT_WEB_LOGIN_CWD: temp,
    ARGV_FILE: argvFile,
    STDIN_FILE: stdinFile,
  };

  const status = spawnSync(process.execPath, [bridgeScript, 'status'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (status.status !== 0) {
    fail(`bridge status smoke failed\\nstdout:\\n${status.stdout}\\nstderr:\\n${status.stderr}`);
  }

  const ask = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: privatePrompt,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (ask.status !== 0) {
    fail(`bridge ask smoke failed\\nstdout:\\n${ask.stdout}\\nstderr:\\n${ask.stderr}`);
  }
  if (ask.stdout.trim() !== 'BRIDGE_TEST_OK') fail(`unexpected bridge output: ${ask.stdout}`);

  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  if (argv.some((arg) => arg.includes(privatePrompt))) fail('private prompt leaked into codex argv');
  if (argv[argv.length - 1] !== '-') fail('codex exec did not read prompt from stdin marker');
  for (const feature of ['shell_tool', 'shell_snapshot', 'browser_use', 'apps', 'image_generation', 'multi_agent']) {
    const index = argv.indexOf('--disable');
    if (!argv.includes(feature)) fail(`codex exec did not disable ${feature}`);
    if (index === -1) fail('codex exec did not pass --disable flags');
  }
  if (!argv.includes('web_search="disabled"')) fail('codex exec did not disable web search');
  if (fs.readFileSync(stdinFile, 'utf8') !== privatePrompt) fail('private prompt was not passed through stdin');

  console.log('bridge CLI smoke passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
