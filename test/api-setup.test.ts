import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {locations, setupMain} from '../src/setup.js';
import {loadApiConfig, readApiCredentials} from '../src/api-settings.js';
import {inspectSubscriptionAccount} from '../src/sdk.js';
import {accountFingerprint} from '../src/subscription-limits.js';
import {FallbackStore} from '../src/fallback-store.js';

const exec = promisify(execFile);
const fakeKey = 'sk-ant-fixture-only-never-an-actual-key';
const account = {apiProvider: 'firstParty', subscriptionType: 'pro', email: 'setup@example.invalid', organization: 'fixture-org'};
const saveCredential = (home: string, workspace = 'wrkspc_fixture') => exec('/usr/bin/python3', ['-c',
  'import runpy,sys; m=runpy.run_path(sys.argv[1]); m["save_credentials"](sys.argv[2], "sk-ant-fixture-only-never-an-actual-key", sys.argv[3])',
  path.resolve('scripts/enter-api-key.py'), home, workspace]);
async function fixture(t: TestContext) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-setup-')));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const p = locations(home), root = path.join(p.root, 'api');
  await fs.mkdir(root, {recursive: true, mode: 0o700});
  await fs.writeFile(path.join(root, 'credentials.json'), JSON.stringify({schema_version: 1, api_key: fakeKey}), {mode: 0o600});
  const output: string[] = [];
  return {home, p, root, output, log: (message: string) => output.push(message)};
}
const enable = ['api-enable', '--daily-usd', '2', '--per-request-usd', '0.5', '--total-usd', '3'];

test('API enable binds the live subscription account without delivering a prompt or paid request', async t => {
  const f = await fixture(t);
  let prompts = 0, accountChecks = 0, closed = 0;
  const query = ((args: any) => {
    void (async () => {for await (const _ of args.prompt) prompts++;})();
    return {accountInfo: async () => {accountChecks++; return account;}, close() {closed++;}};
  }) as unknown as Parameters<typeof inspectSubscriptionAccount>[2];
  await setupMain([...enable, '--codex-home', f.home, '--max-output-tokens', '2048', '--cache', 'off'], {
    log: f.log,
    inspectAccount: async (cwd, runtime) => {
      assert.equal(cwd, path.join(f.p.root, 'sdk-cwd'));
      assert.equal(runtime.runtimePolicyPath, path.join(f.p.root, 'runtime-policy.json'));
      return inspectSubscriptionAccount(cwd, {...runtime, guard: async () => ({coverage: 'test_injected'})}, query);
    },
  });
  const config = await loadApiConfig(f.root);
  assert.equal(config?.confirmedSubscriptionAccount, accountFingerprint(account));
  assert.equal(config?.dailyLimitUsd, 2);
  assert.equal(config?.totalLimitUsd, 3);
  assert.equal(config?.perRequestLimitUsd, 0.5);
  assert.equal(config?.maxOutputTokens, 2048);
  assert.equal(config?.cache, 'off');
  assert.equal(prompts, 0); assert.equal(accountChecks, 1); assert.equal(closed, 1);
  assert.equal(JSON.parse(f.output[0]!).status, 'configured_unverified');
  assert.ok(!f.output.join('').includes(fakeKey));
});

test('API status is disabled by default and disable survives damaged optional configuration without an account call', async t => {
  const f = await fixture(t);
  const inspectAccount = async () => {throw new Error('An account call was not expected');};
  await setupMain(['api-status', '--codex-home', f.home], {log: f.log, inspectAccount});
  assert.equal(JSON.parse(f.output.pop()!).status, 'disabled');
  await fs.writeFile(path.join(f.root, 'config.json'), '{broken', {mode: 0o600});
  await setupMain(['api-status', '--codex-home', f.home], {log: f.log, inspectAccount});
  assert.equal(JSON.parse(f.output.pop()!).status, 'blocked');
  await fs.writeFile(path.join(f.root, 'credentials.json'), '{broken', {mode: 0o600});
  await fs.writeFile(path.join(f.root, 'fallback-store.json'), '{broken', {mode: 0o600});
  await setupMain(['api-disable', '--codex-home', f.home], {log: f.log, inspectAccount});
  assert.equal(await loadApiConfig(f.root), null);
  assert.equal(JSON.parse(f.output.pop()!).status, 'disabled');
});

test('invalid enable flags and missing credentials cannot silently enable API spending', async t => {
  const f = await fixture(t);
  let checks = 0;
  const options = {log: f.log, inspectAccount: async () => {checks++; return 'a'.repeat(64);}};
  for (const flags of [
    ['api-enable'],
    ['api-enable', '--daily-usd', 'NaN', '--per-request-usd', '0.1'],
    ['api-enable', '--daily-usd', '0.1', '--per-request-usd', '1'],
    [...enable, '--daily-usd', '4'],
    [...enable, '--cache', '1h'],
    [...enable, '--max-output-tokens', '1'],
    [...enable, '--api-key', fakeKey],
  ]) await assert.rejects(setupMain([...flags, '--codex-home', f.home], options), error => !String(error).includes(fakeKey));
  assert.equal(checks, 0);
  await fs.unlink(path.join(f.root, 'credentials.json'));
  await assert.rejects(setupMain([...enable, '--codex-home', f.home], options));
  assert.equal(checks, 0);
  assert.equal(await loadApiConfig(f.root), null);
});

test('enable refuses an unidentifiable account and keeps the previous disabled state', async t => {
  const f = await fixture(t);
  await setupMain(['api-disable', '--codex-home', f.home], {log: f.log});
  await assert.rejects(setupMain([...enable, '--codex-home', f.home], {log: f.log, inspectAccount: async () => null}));
  assert.equal(await loadApiConfig(f.root), null);
});

test('default enable asks only the installed bridge account command', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.p.runtime, {recursive: true, mode: 0o700});
  await fs.writeFile(path.join(f.p.runtime, 'bridge.mjs'), `
    if (process.argv[2] !== 'account' || process.argv[3] !== '--codex-home' || process.argv[4] !== ${JSON.stringify(f.home)}) throw Error('Unexpected runtime operation');
    console.log(JSON.stringify({accountId: '${'b'.repeat(64)}'}));
  `);
  await setupMain([...enable, '--codex-home', f.home], {log: f.log});
  assert.equal((await loadApiConfig(f.root))?.confirmedSubscriptionAccount, 'b'.repeat(64));
  assert.equal((await loadApiConfig(f.root))?.maxOutputTokens, 8192);
});

test('credential entry writes privately without enabling fallback and rejects symlink destinations', async t => {
  const f = await fixture(t);
  const result = await saveCredential(f.home);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const credentials = await readApiCredentials(f.root);
  assert.equal(credentials.workspace_id, 'wrkspc_fixture');
  assert.equal((await fs.stat(path.join(f.root, 'credentials.json'))).mode & 0o777, 0o600);
  assert.equal(await loadApiConfig(f.root), null);
  await fs.rename(path.join(f.root, 'credentials.json'), path.join(f.root, 'original.json'));
  await fs.symlink(path.join(f.root, 'original.json'), path.join(f.root, 'credentials.json'));
  await assert.rejects(saveCredential(f.home));
  const original = JSON.parse(await fs.readFile(path.join(f.root, 'original.json'), 'utf8'));
  assert.equal(original.api_key, fakeKey);
});

test('credential entry rejects symlink ancestors before creating a destination and validates workspace IDs', async t => {
  const f = await fixture(t), target = path.join(f.home, 'outside'), linked = path.join(f.home, 'alias');
  await fs.mkdir(target, {mode: 0o700});
  await fs.symlink(target, linked);
  await assert.rejects(saveCredential(linked));
  await assert.rejects(fs.access(path.join(target, 'claude-models')));
  await assert.rejects(saveCredential(f.home, 'workspace_fixture'));
});

test('credential CLI refuses noninteractive secret entry without echoing stdin', async t => {
  const f = await fixture(t);
  await assert.rejects(exec('/usr/bin/python3', [path.resolve('scripts/enter-api-key.py'), '--codex-home', f.home]),
    (error: any) => String(error.stderr).includes('interactive terminal') && !String(error.stderr).includes(fakeKey));
});

test('credential CLI never echoes a key mistakenly passed as an unsupported argument', async t => {
  const f = await fixture(t);
  await assert.rejects(exec('/usr/bin/python3', [path.resolve('scripts/enter-api-key.py'), '--codex-home', f.home, '--api-key', fakeKey]),
    (error: any) => !String(error.stderr).includes(fakeKey));
});

test('doctor reports API configuration while invoking only subscription model inspection', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.p.runtime, {recursive: true, mode: 0o700});
  await fs.writeFile(f.p.state, JSON.stringify({models: [], port: 47832}));
  await fs.writeFile(path.join(f.p.runtime, 'bridge.mjs'), `
    if (process.argv[2] !== 'models') throw Error('Unexpected runtime operation');
    console.log(JSON.stringify({authenticated: true, models: []}));
  `);
  await setupMain(['doctor', '--codex-home', f.home], {log: f.log, inspectAccount: async () => {throw new Error('Not expected');}});
  const status = JSON.parse(f.output[0]!);
  assert.equal(status.apiFallback.status, 'disabled');
  assert.equal(status.authenticated, true);
  assert.equal(status.bridgeRunning, false);
});

test('API status exposes estimated liabilities and quota resets without leasing a recovery probe', async t => {
  const f = await fixture(t), accountId = accountFingerprint(account)!;
  await setupMain([...enable, '--codex-home', f.home], {log: f.log, inspectAccount: async () => accountId});
  const store = new FallbackStore(f.root), resetsAt = Date.now() - 1000;
  await store.reserve({id: 'unknown-status-request', amountUsd: 0.4, dailyLimitUsd: 2, scope: 'fixture'});
  await store.settle('unknown-status-request', null);
  await store.recordQuota(accountId, [{type: 'five_hour', resetsAt}]);
  await setupMain(['api-status', '--codex-home', f.home], {log: f.log, inspectAccount: async () => {throw new Error('Not expected');}});
  const status = JSON.parse(f.output.at(-1)!);
  assert.equal(status.status, 'configured_unverified');
  assert.equal(status.budget.totalUsd, 0.4);
  assert.equal(status.budget.reservedUsd, 0.4);
  assert.equal(status.budget.dailyRemainingUsd, 1.6);
  assert.equal(status.quota.windows[0].resetsAt, resetsAt);
  assert.equal(status.quota.probePending, false);
  assert.ok((await store.route(accountId, 'claude-opus-4-6')).probeId);
  assert.ok(!f.output.at(-1)!.includes(accountId));
  assert.ok(!f.output.at(-1)!.includes(fakeKey));
});
