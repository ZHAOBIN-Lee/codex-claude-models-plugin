import { promises as fs } from 'node:fs';
import path from 'node:path';
import { locations, readState } from './setup.js';
import { inspectSdk, inspectSubscriptionAccount, sdkRunner, type RuntimeOptions } from './sdk.js';
import { fallbackRunner } from './fallback.js';
import { bridgeServer } from './server.js';
import { openaiForwarder } from './openai.js';
import {accountModelRunner, inspectAccountModels, readSubscriptionAccounts} from './subscription-accounts.js';

async function main() {
  const flag = process.argv.indexOf('--codex-home');
  const p = locations(flag < 0 ? undefined : process.argv[flag + 1]);
  const cwd = path.join(p.root, 'sdk-cwd');
  // The private policy and receipts always live under the Codex home's claude-models directory.
  const runtime: RuntimeOptions = {runtimePolicyPath: path.join(p.root, 'runtime-policy.json'), receiptsDir: path.join(p.root, 'receipts')};
  // Inspection accepts a profile directory so a native login can be enrolled without copying credentials.
  const profileFlag = process.argv.indexOf('--claude-config-dir');
  if (profileFlag >= 0) {
    if (!['models', 'account'].includes(process.argv[2] ?? '') || !process.argv[profileFlag + 1]) throw new Error('--claude-config-dir is only available for account inspection.');
    runtime.configDir = process.argv[profileFlag + 1];
  }
  if (process.argv[2] === 'models') {
    const metadata = runtime.configDir ? await inspectSdk(cwd, runtime)
      : await inspectAccountModels(cwd, runtime, await readSubscriptionAccounts(p.root));
    console.log(JSON.stringify(metadata)); return;
  }
  if (process.argv[2] === 'account') {console.log(JSON.stringify({accountId: await inspectSubscriptionAccount(cwd, runtime)})); return;}
  if (process.argv[2] !== 'serve') throw new Error('Expected serve, models or account.');
  const state = await readState(p);
  const token = (await fs.readFile(p.token, 'utf8')).trim();
  const subscription = sdkRunner(cwd, state.models, undefined, runtime);
  const legacy = fallbackRunner({root: path.join(p.root, 'api'), models: state.models,
    subscription,
    account: signal => inspectSubscriptionAccount(cwd, runtime, undefined, signal)});
  const server = bridgeServer({token, run: accountModelRunner(state.models, subscription, legacy),
    ...(state.openaiModels ? {openai: {models: new Set(state.openaiModels), forward: openaiForwarder()}} : {})});
  server.on('error', error => {console.error(`Bridge listen error: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); process.exitCode = 1;});
  server.listen(state.port, '127.0.0.1');
  // Stopping no longer cuts off chats: new connections are refused at once, steps in flight finish, then the process exits.
  // A second signal exits immediately.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    void server.drain().then(() => process.exit(0));
  });
}
main().catch(error => {console.error(error instanceof Error ? error.message : 'Bridge startup failed.'); process.exitCode = 1;});
