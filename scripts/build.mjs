import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
await build({entryPoints: {'setup': 'src/setup-main.ts', 'bridge': 'src/bridge-main.ts'},
  outdir: 'plugins/codex-claude-models/bin', outExtension: {'.js': '.mjs'}, bundle: true,
  platform: 'node', target: 'node22', format: 'esm', external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'},
  minify: true, sourcemap: false});
await fs.copyFile('LICENSE', 'plugins/codex-claude-models/LICENSE');
const notices = await Promise.all(['zod', '@iarna/toml'].map(async name =>
  `${name}\n${await fs.readFile(`node_modules/${name}/LICENSE`, 'utf8')}`));
await fs.writeFile('plugins/codex-claude-models/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
