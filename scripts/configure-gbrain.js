#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [file, model, dimsRaw, baseUrl] = process.argv.slice(2);

if (!file || !model || !dimsRaw || !baseUrl) {
  console.error('Usage: configure-gbrain.js <config.json> <model> <dimensions> <base-url>');
  process.exit(2);
}

const dimensions = Number(dimsRaw);
if (!Number.isInteger(dimensions) || dimensions <= 0) {
  console.error(`Invalid embedding dimensions: ${dimsRaw}`);
  process.exit(2);
}

const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
delete cfg.embedding_disabled;
cfg.embedding_model = `litellm:${model}`;
cfg.embedding_dimensions = dimensions;
cfg.provider_base_urls = { ...(cfg.provider_base_urls || {}), litellm: baseUrl };
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(path.dirname(file), 0o700);
} catch {
  // chmod may fail on some filesystems.
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
try {
  fs.chmodSync(file, 0o600);
} catch {
  // chmod may fail on some filesystems.
}
