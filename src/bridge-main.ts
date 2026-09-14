import { promises as fs } from 'node:fs';
import path from 'node:path';
import { locations, readState } from './setup.js';
import { inspectSdk, sdkRunner } from './sdk.js';
import { bridgeServer } from './server.js';

async function main() {
  const flag = process.argv.indexOf('--codex-home');
  const p = locations(flag < 0 ? undefined : process.argv[flag + 1]);
  const cwd = path.join(p.root, 'sdk-cwd');
  if (process.argv[2] === 'models') {console.log(JSON.stringify(await inspectSdk(cwd))); return;}
  if (process.argv[2] !== 'serve') throw new Error('Expected serve or models.');
  const state = await readState(p);
  const token = (await fs.readFile(p.token, 'utf8')).trim();
  const server = bridgeServer({token, run: sdkRunner(cwd, state.models)});
  server.on('error', error => {console.error(`Bridge listen error: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); process.exitCode = 1;});
  server.listen(state.port, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {server.closeAllConnections(); server.close(); setTimeout(() => process.exit(0), 500).unref();});
}
main().catch(error => {console.error(error instanceof Error ? error.message : 'Bridge startup failed.'); process.exitCode = 1;});
