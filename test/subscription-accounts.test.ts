import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {accountModelRunner, inspectAccountModels, readSubscriptionAccounts, type SubscriptionAccount} from '../src/subscription-accounts.js';
import {codexCatalog} from '../src/catalog.js';
import {BridgeError, requestSchema, type RunStep} from '../src/contracts.js';
import {installConfig, locations, readState} from '../src/setup.js';

const base = {id: 'claude-sdk-opus', sdkModel: 'opus', resolvedModel: 'claude-opus-5-5',
  displayName: 'Claude Agent · Opus', description: 'fixture', efforts: ['medium']};
const accounts: SubscriptionAccount[] = [
  {id: 'a', label: 'A · Max', fingerprint: 'a'.repeat(64)},
  {id: 'b', label: 'B · Pro', configDir: '/private/fixture-secondary', fingerprint: 'b'.repeat(64)},
];
const inspect: Parameters<typeof inspectAccountModels>[3] = async (_cwd, runtime) => ({
  authenticated: true, subscriptionType: 'pro', guardCoverage: 'test_injected',
  accountId: runtime?.expectedAccount ?? accounts[0]!.fingerprint, models: [base],
});

test('account catalog keeps legacy IDs, creates isolated choices, and excludes private registration data from the menu', async () => {
  const metadata = await inspectAccountModels('/fixture', {}, accounts, inspect);
  assert.deepEqual(metadata.models.map(model => model.id), ['claude-sdk-opus', 'claude-sdk-opus-account-a', 'claude-sdk-opus-account-b']);
  const menu = codexCatalog(metadata.models).models;
  assert.deepEqual(menu.map(model => model.visibility), ['hide', 'list', 'list']);
  assert.match(menu[1]!.display_name, /A · Max/);
  assert.match(menu[2]!.display_name, /B · Pro/);
  assert.equal(menu[1]!.context_window, menu[2]!.context_window);
  for (const hidden of [accounts[1]!.configDir!, accounts[0]!.fingerprint, accounts[1]!.fingerprint]) {
    assert.ok(!JSON.stringify(menu).includes(hidden));
  }
  assert.deepEqual((await inspectAccountModels('/fixture', {}, [], inspect)).models, [base]);
});

test('catalog refresh refuses an account that was signed out or replaced', async () => {
  for (const result of [{authenticated: false}, {accountId: 'c'.repeat(64)}]) {
    const changed: typeof inspect = async (...args) => ({...await inspect(...args), subscriptionType: 'pro', ...(args[1]?.expectedAccount ? result : {})});
    await assert.rejects(inspectAccountModels('/fixture', {}, accounts, changed),
      (error: unknown) => error instanceof BridgeError && error.code === 'subscription_account_changed');
  }
});

test('each model has its account choices next to one another in the menu', async () => {
  const multiple: typeof inspect = async (...args) => ({...await inspect(...args), subscriptionType: 'pro', models: [base,
    {...base, id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent · Sonnet'}]});
  const result = await inspectAccountModels('/fixture', {}, accounts, multiple);
  assert.deepEqual(result.models.filter(model => model.account).map(model => [model.sdkModel, model.account!.id]),
    [['opus', 'a'], ['opus', 'b'], ['sonnet', 'a'], ['sonnet', 'b']]);
});

test('account choices never cross to the legacy paid runner after a subscription failure', async () => {
  const models = (await inspectAccountModels('/fixture', {}, accounts, inspect)).models;
  const selected: string[] = [];
  let legacyCalls = 0;
  const subscription: RunStep = async request => {selected.push(request.model); throw new BridgeError(429, 'subscription_quota', 'fixture quota');};
  const legacy: RunStep = async () => {legacyCalls++; throw new BridgeError(401, 'legacy_fixture', 'fixture');};
  const run = accountModelRunner(models, subscription, legacy);
  for (const model of models.slice(1)) {
    await assert.rejects(run(requestSchema.parse({model: model.id, input: 'fixture'}), new AbortController().signal), /fixture quota/);
  }
  assert.equal(legacyCalls, 0);
  assert.deepEqual(selected, models.slice(1).map(model => model.id));
  await assert.rejects(run(requestSchema.parse({model: base.id, input: 'fixture'}), new AbortController().signal), /fixture/);
  assert.equal(legacyCalls, 1);
});

test('account registration requires private metadata and unique account routes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-accounts-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'subscription-accounts.json');
  assert.deepEqual(await readSubscriptionAccounts(root), []);
  await fs.writeFile(file, JSON.stringify({schema_version: 1, accounts}), {mode: 0o600});
  assert.deepEqual(await readSubscriptionAccounts(root), accounts);
  await fs.chmod(file, 0o644);
  await assert.rejects(readSubscriptionAccounts(root), /private/);
  await fs.chmod(file, 0o600);
  for (const duplicate of [{...accounts[1]!, id: 'a'}, {...accounts[1]!, configDir: undefined}]) {
    await fs.writeFile(file, JSON.stringify({schema_version: 1, accounts: [accounts[0], duplicate]}));
    await assert.rejects(readSubscriptionAccounts(root), /unique/);
  }
});

test('install and reinstall retain both account agent profiles and the legacy profile', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-account-install-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  await fs.mkdir(p.root, {recursive: true});
  await fs.writeFile(p.config, 'model = "gpt-fixture"\n');
  await fs.writeFile(p.token, 'test-local-token');
  const models = (await inspectAccountModels(root, {}, accounts, inspect)).models;
  await installConfig(p, models, 47842, {models: [{slug: 'gpt-fixture'}]});
  await installConfig(p, models, 47842, {models: [{slug: 'gpt-fixture'}]});
  assert.deepEqual((await readState(p)).models, models);
  for (const [name, model] of [['claude_opus', base.id], ['claude_sdk_opus_account_a', models[1]!.id], ['claude_sdk_opus_account_b', models[2]!.id]]) {
    assert.ok((await fs.readFile(path.join(root, 'agents', `${name}.toml`), 'utf8')).includes(`model = "${model}"`));
  }
});
