#!/usr/bin/env node

const fs = require('fs');

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
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
