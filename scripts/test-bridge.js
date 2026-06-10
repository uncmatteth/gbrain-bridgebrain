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
  const callsFile = path.join(temp, 'calls.txt');
  const stdinFile = path.join(temp, 'stdin.txt');

  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify({
  args,
  codexHome: process.env.CODEX_HOME || '',
}));
fs.appendFileSync(process.env.CALLS_FILE, (args[0] || '') + '\\n');

if (args[0] === 'doctor') {
  if (process.env.FAKE_CODEX_DOCTOR_SLEEP_MS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CODEX_DOCTOR_SLEEP_MS));
  }
  if (process.env.FAKE_CODEX_DOCTOR_NO_JSON === '1') {
    console.error('doctor failed before JSON');
    process.exit(9);
  }
  console.log(JSON.stringify({
    checks: {
      'auth.credentials': {
        status: 'ok',
        details: {
          'stored auth mode': process.env.FAKE_CODEX_AUTH_MODE || 'chatgpt',
          'stored ChatGPT tokens': process.env.FAKE_CODEX_CHATGPT_TOKENS || 'true',
          'stored API key': 'false',
        },
      },
    },
    overallStatus: 'ok',
  }));
  if (process.env.FAKE_CODEX_DOCTOR_FAIL === '1') {
    process.exit(9);
  }
  process.exit(0);
}

if (args[0] === 'exec') {
  const input = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(process.env.STDIN_FILE, input);
  if (process.env.FAKE_CODEX_EXEC_FAIL_ECHO === '1') {
    console.log(input);
    console.error(input);
    process.exit(1);
  }
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
    CODEX_HOME: path.join(temp, 'custom-codex-home'),
    GPT_WEB_LOGIN_CODEX_BIN: fakeCodex,
    GPT_WEB_LOGIN_CWD: temp,
    ARGV_FILE: argvFile,
    CALLS_FILE: callsFile,
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

  const argvPayload = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const argv = argvPayload.args || argvPayload;
  if (argvPayload.codexHome !== env.CODEX_HOME) fail('bridge child did not preserve CODEX_HOME');
  if (argv.some((arg) => arg.includes(privatePrompt))) fail('private prompt leaked into codex argv');
  if (argv[argv.length - 1] !== '-') fail('codex exec did not read prompt from stdin marker');
	  for (const feature of ['apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent', 'shell_snapshot', 'shell_tool']) {
    let disabled = false;
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === '--disable' && argv[i + 1] === feature) disabled = true;
    }
    if (!disabled) fail(`codex exec did not disable ${feature} with --disable`);
  }
  if (!argv.includes('web_search="disabled"')) fail('codex exec did not disable web search');
  if (fs.readFileSync(stdinFile, 'utf8') !== privatePrompt) fail('private prompt was not passed through stdin');

  fs.writeFileSync(callsFile, '');
  const argvPrompt = spawnSync(process.execPath, [bridgeScript, 'ask', privatePrompt], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
	  if (argvPrompt.status === 0) fail('bridge ask must reject argv prompt input');
	  if (`${argvPrompt.stdout}${argvPrompt.stderr}`.includes(privatePrompt)) fail('argv prompt leaked in bridge rejection output');
	  if (fs.readFileSync(callsFile, 'utf8').trim() !== '') fail('argv prompt rejection still called codex');
	  const unknownCommand = spawnSync(process.execPath, [bridgeScript, privatePrompt], {
	    env,
	    encoding: 'utf8',
	    timeout: 30_000,
	  });
	  if (unknownCommand.status === 0) fail('bridge must reject unknown commands');
	  if (`${unknownCommand.stdout}${unknownCommand.stderr}`.includes(privatePrompt)) fail('unknown command leaked raw argv text');
	  if (fs.readFileSync(callsFile, 'utf8').trim() !== '') fail('unknown command rejection still called codex');

	  fs.writeFileSync(callsFile, '');
  const largePrompt = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: 'too large',
    env: {
      ...env,
      GPT_WEB_LOGIN_MAX_STDIN_BYTES: '4',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (largePrompt.status === 0) fail('bridge ask must reject oversized stdin');
  if (fs.readFileSync(callsFile, 'utf8').trim() !== '') fail('oversized stdin rejection still called codex');

  fs.writeFileSync(callsFile, '');
  const badAuth = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: privatePrompt,
    env: {
      ...env,
      FAKE_CODEX_AUTH_MODE: 'api',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (badAuth.status !== 0) fail('bridge ask must use codex exec as the auth proof when doctor auth is stale');
  if (!fs.readFileSync(callsFile, 'utf8').includes('exec')) fail('doctor auth mismatch prevented codex exec smoke');

  fs.writeFileSync(callsFile, '');
  const nonzeroDoctorAuthOk = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: privatePrompt,
    env: {
      ...env,
      FAKE_CODEX_DOCTOR_FAIL: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (nonzeroDoctorAuthOk.status !== 0) {
    fail(`bridge ask must allow nonzero codex doctor when auth JSON is OK\\nstdout:\\n${nonzeroDoctorAuthOk.stdout}\\nstderr:\\n${nonzeroDoctorAuthOk.stderr}`);
  }
  if (!fs.readFileSync(callsFile, 'utf8').includes('exec')) fail('nonzero codex doctor with valid auth did not call codex exec');

  fs.writeFileSync(callsFile, '');
  const failedDoctor = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: privatePrompt,
    env: {
      ...env,
      FAKE_CODEX_DOCTOR_NO_JSON: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (failedDoctor.status !== 0) fail('bridge ask must not depend on codex doctor JSON');
  if (!fs.readFileSync(callsFile, 'utf8').includes('exec')) fail('failed codex doctor prevented codex exec smoke');

  fs.writeFileSync(callsFile, '');
  const hangingDoctor = spawnSync(process.execPath, [bridgeScript, 'status'], {
    env: {
      ...env,
      FAKE_CODEX_DOCTOR_SLEEP_MS: '2000',
      GPT_WEB_LOGIN_STATUS_TIMEOUT_MS: '100',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (hangingDoctor.status === 0) fail('bridge status must fail when codex doctor times out');
  if (!`${hangingDoctor.stdout}${hangingDoctor.stderr}`.includes('local provider status could not be confirmed')) {
    fail('bridge status timeout did not report status confirmation failure');
  }

  fs.writeFileSync(callsFile, '');
  const failEcho = spawnSync(process.execPath, [bridgeScript, 'ask'], {
    input: privatePrompt,
    env: {
      ...env,
      FAKE_CODEX_EXEC_FAIL_ECHO: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (failEcho.status === 0) fail('bridge ask must fail when codex exec fails');
  if (`${failEcho.stdout}${failEcho.stderr}`.includes(privatePrompt)) fail('failed codex output leaked private prompt');

  console.log('bridge CLI smoke passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
