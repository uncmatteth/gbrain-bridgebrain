#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

const provider = process.env.GPT_WEB_LOGIN_PROVIDER || 'codex';
const codexBin = process.env.GPT_WEB_LOGIN_CODEX_BIN || 'codex';
const bridgeCwd = process.env.GPT_WEB_LOGIN_CWD || process.cwd();
const maxStdinBytes = positiveIntEnv('GPT_WEB_LOGIN_MAX_STDIN_BYTES', 2 * 1024 * 1024);
const childTimeoutMs = positiveIntEnv('GPT_WEB_LOGIN_CHILD_TIMEOUT_MS', 300000);
const statusTimeoutMs = positiveIntEnv('GPT_WEB_LOGIN_STATUS_TIMEOUT_MS', Math.min(childTimeoutMs, 15000));

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
}

function readStdin() {
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(0, buffer, 0, buffer.length, null);
      if (n === 0) break;
      bytes += n;
      if (bytes > maxStdinBytes) {
        console.error('Prompt stdin is too large.');
        process.exit(2);
      }
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch {
    return '';
  }
}

function requirePrompt(args) {
  if (args.length > 0) {
    console.error('Prompt must be provided on stdin, not command-line arguments.');
    process.exit(2);
  }
  const prompt = readStdin();
  if (!prompt.trim()) {
    console.error('Missing prompt stdin.');
    process.exit(2);
  }
  return prompt;
}

function runCodex(args, stdin = undefined, options = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SHELL: process.env.SHELL,
    TERM: process.env.TERM,
    GPT_WEB_LOGIN_BRIDGE_CHILD: '1',
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('FAKE_CODEX_')) env[key] = value;
  }
  for (const key of ['ARGV_FILE', 'CALLS_FILE', 'STDIN_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return spawnSync(codexBin, args, {
    cwd: bridgeCwd,
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs || childTimeoutMs,
    env,
  });
}

function codexFailureDetails(result) {
  return [
    result.error ? result.error.message || String(result.error) : '',
    result.signal ? `terminated by ${result.signal}` : '',
    result.status !== 0 ? `exited ${result.status}` : '',
    result.stderr || '',
  ].filter(Boolean).join('; ');
}

function codexAuthStatus() {
  const result = runCodex(['doctor', '--all', '--json'], undefined, { timeoutMs: statusTimeoutMs });
  const output = (result.stdout || '').trim();
  if (result.error || result.signal || !output) {
    const details = codexFailureDetails(result);
    return {
      available: false,
      error: details || 'codex doctor produced no JSON',
    };
  }

  try {
    const parsed = JSON.parse(output);
    const auth = parsed.checks && parsed.checks['auth.credentials']
      ? parsed.checks['auth.credentials']
      : null;
    const details = auth && auth.details ? auth.details : {};
    const authMode = details['stored auth mode'] || 'unknown';
    const storedApiKey = details['stored API key'] || 'unknown';
    const storedChatGPTTokens = details['stored ChatGPT tokens'] || 'unknown';

    return {
      available: auth && auth.status === 'ok' && authMode === 'chatgpt' && storedChatGPTTokens === 'true',
      authStatus: auth ? auth.status : 'missing',
      authMode,
      storedApiKey,
      storedChatGPTTokens,
      doctorStatus: result.status,
      overallStatus: parsed.overallStatus || 'unknown',
    };
  } catch (error) {
    const details = codexFailureDetails(result);
    return {
      available: false,
      error: [
        `could not parse codex doctor JSON: ${error.message}`,
        details,
      ].filter(Boolean).join('; '),
    };
  }
}

function parseAgentText(jsonl) {
  const messages = [];
  for (const line of jsonl.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
      messages.push(event.item.text || '');
    }
  }
  return messages.join('\n').trim();
}

function codexAsk(prompt) {
  const result = runCodex([
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--disable',
    'apps',
    '--disable',
    'browser_use',
    '--disable',
    'browser_use_external',
    '--disable',
    'computer_use',
    '--disable',
    'image_generation',
    '--disable',
    'multi_agent',
    '--disable',
    'shell_snapshot',
    '--disable',
    'shell_tool',
    '-C',
    bridgeCwd,
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'model_reasoning_effort="low"',
    '-',
  ], prompt);

  const text = parseAgentText(result.stdout || '');
  if (result.error || result.signal || result.status !== 0 || !text) {
    throw new Error('codex exec failed');
  }
  return text;
}

function assertSupportedProvider() {
  if (provider !== 'codex') {
    throw new Error('only provider shipped by this skill is codex');
  }
}

function status() {
  if (provider !== 'codex') {
    console.log('Provider: unsupported');
    console.log('Available: false');
    console.log('Reason: only provider shipped by this skill is codex');
    process.exit(1);
  }

  const auth = codexAuthStatus();
  console.log(`Provider: codex`);
  console.log(`Available: ${auth.available ? 'true' : 'false'}`);
  if (auth.error) {
    console.log('Reason: local provider status could not be confirmed');
    process.exit(1);
  }
  console.log(`Check: ${auth.available ? 'authenticated provider available' : 'authenticated provider unavailable'}`);
  if (!auth.available) process.exit(1);
}

function usage() {
  console.log(`GPT web-login bridge

Usage:
  gpt-web-login-bridge status
  gpt-web-login-bridge smoke
  printf '%s\\n' "prompt" | gpt-web-login-bridge ask

The bridge uses an already-authenticated local CLI. It does not read or print raw credentials.
ask and smoke send prompt text to the authenticated provider account. Do not send secrets unless that provider exposure is intentional.
ask and smoke pass prompt text through stdin and disable shell/browser/app/search tools for the child model run.
`);
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command || 'help') {
    case 'status':
      status();
      break;
    case 'smoke': {
      assertSupportedProvider();
      const text = codexAsk('Return exactly GPT_WEB_LOGIN_BRIDGE_OK.');
      console.log(text);
      if (text !== 'GPT_WEB_LOGIN_BRIDGE_OK') process.exit(1);
      break;
    }
    case 'ask': {
      const prompt = requirePrompt(args);
      assertSupportedProvider();
      console.log(codexAsk(prompt));
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error('Unknown command.');
      usage();
      process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
