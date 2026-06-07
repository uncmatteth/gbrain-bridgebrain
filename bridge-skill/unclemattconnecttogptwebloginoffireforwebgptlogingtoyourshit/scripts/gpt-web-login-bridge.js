#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

const provider = process.env.GPT_WEB_LOGIN_PROVIDER || 'codex';
const codexBin = process.env.GPT_WEB_LOGIN_CODEX_BIN || 'codex';
const bridgeCwd = process.env.GPT_WEB_LOGIN_CWD || process.cwd();

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function requirePrompt(args) {
  const prompt = args.join(' ').trim() || readStdin().trim();
  if (!prompt) {
    console.error('Missing prompt argument or stdin.');
    process.exit(2);
  }
  return prompt;
}

function runCodex(args) {
  return spawnSync(codexBin, args, {
    cwd: bridgeCwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GPT_WEB_LOGIN_BRIDGE_CHILD: '1',
    },
  });
}

function codexAuthStatus() {
  const result = runCodex(['doctor', '--all', '--json']);
  const output = (result.stdout || '').trim();
  if (!output) {
    return {
      available: false,
      error: (result.stderr || result.error || 'codex doctor produced no JSON').toString().trim(),
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
      overallStatus: parsed.overallStatus || 'unknown',
    };
  } catch (error) {
    return {
      available: false,
      error: `could not parse codex doctor JSON: ${error.message}`,
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
    '-C',
    bridgeCwd,
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'model_reasoning_effort="low"',
    prompt,
  ]);

  const text = parseAgentText(result.stdout || '');
  if (result.status !== 0 || !text) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(details || `codex exec failed with status ${result.status}`);
  }
  return text;
}

function status() {
  if (provider !== 'codex') {
    console.log(`Provider: ${provider}`);
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
  gpt-web-login-bridge ask "prompt"

The bridge uses an already-authenticated local CLI. It does not read or print raw credentials.
ask and smoke send prompt text to the authenticated provider account. Do not send secrets unless that provider exposure is intentional.
`);
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command || 'help') {
    case 'status':
      status();
      break;
    case 'smoke': {
      const text = codexAsk('Return exactly GPT_WEB_LOGIN_BRIDGE_OK.');
      console.log(text);
      if (text !== 'GPT_WEB_LOGIN_BRIDGE_OK') process.exit(1);
      break;
    }
    case 'ask':
      console.log(codexAsk(requirePrompt(args)));
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
