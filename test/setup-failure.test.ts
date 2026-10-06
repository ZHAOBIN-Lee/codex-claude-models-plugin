import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, type PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { activate, activateRouter, deactivate, failedInstallOutcome, installCommitted, installConfig, locations, readState, trustRouterStartup, uninstallConfig } from '../src/setup.js';

const haiku = {id: 'claude-sdk-haiku', sdkModel: 'haiku', displayName: 'Claude Agent · Haiku', description: 'Fast', efforts: []};
const sonnet = {id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent · Sonnet', description: 'Balanced', efforts: ['medium']};
const openai = {models: [{slug: 'gpt-original'}]} as any;
const realRename = fs.rename.bind(fs);
const realWriteFile = fs.writeFile.bind(fs);
const realReadFile = fs.readFile.bind(fs);

type Paths = ReturnType<typeof locations>;
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as any;
const readToml = async (file: string) => TOML.parse(await fs.readFile(file, 'utf8')) as any;
const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function fixture(t: TestContext, prefix: string, config: Record<string, unknown> = {model: 'gpt-original', web_search: 'cached'}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `claude-${prefix}-`));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(path.join(root, 'home'));
  await fs.mkdir(p.root, {recursive: true});
  await fs.writeFile(p.token, 'test-token');
  await fs.writeFile(p.config, TOML.stringify(config as TOML.JsonMap));
  return p;
}

// Fail the Nth..(N+times)th rename whose destination matches. Production code carries no failure flags.
function failRename(t: TestContext, match: (to: string) => boolean, {skip = 0, times = 1} = {}) {
  let seen = 0, failed = 0;
  const mocked = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    if (match(String(to)) && seen++ >= skip && failed < times) {failed++; throw Object.assign(new Error('injected rename failure'), {code: 'EIO'});}
    return realRename(from, to);
  });
  return {restore: () => mocked.mock.restore(), failures: () => failed};
}

// Several independent failure rules on one rename mock; `times: Infinity` models a failure that never clears.
function failRenames(t: TestContext, rules: {match: (to: string) => boolean; skip?: number; times?: number}[]) {
  const counts = rules.map(() => ({seen: 0, failed: 0}));
  const mocked = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    for (const [index, rule] of rules.entries()) {
      if (!rule.match(String(to))) continue;
      const count = counts[index]!;
      if (count.seen++ >= (rule.skip ?? 0) && count.failed < (rule.times ?? 1)) {count.failed++; throw Object.assign(new Error('injected rename failure'), {code: 'EIO'});}
    }
    return realRename(from, to);
  });
  return {restore: () => mocked.mock.restore()};
}

// Reads of matching files fail with EIO until restored; a file that exists but cannot be read is not the same as a missing one.
function failRead(t: TestContext, match: (file: string) => boolean) {
  const mocked = t.mock.method(fs, 'readFile', async (file: any, ...rest: any[]) => {
    if (match(String(file))) throw Object.assign(new Error('injected read failure'), {code: 'EIO'});
    return (realReadFile as any)(file, ...rest);
  });
  return {restore: () => mocked.mock.restore()};
}

// Same-port reinstall that adds a model, interrupted before config.toml changes: the sonnet agent is never written, and
// neither the file rollback nor the state rollback can succeed. Leaves a pending journal, partial files and an old config.
async function interruptedSamePortReinstall(t: TestContext, prefix: string) {
  const p = await fixture(t, prefix);
  await installConfig(p, [haiku], 47842, openai);
  const sonnetAgent = path.join(p.home, 'agents', 'claude_sonnet.toml');
  const snapshot = {catalog: await fs.readFile(p.catalog, 'utf8'), combined: await fs.readFile(p.combined, 'utf8'),
    claudeConfig: await fs.readFile(path.join(p.home, 'claude.config.toml'), 'utf8'), config: await fs.readFile(p.config, 'utf8')};
  const failing = failRenames(t, [{match: to => to === sonnetAgent},
    {match: to => to === p.catalog, skip: 1, times: Infinity}, {match: to => to === p.state, skip: 1, times: Infinity}]);
  await assert.rejects(installConfig(p, [haiku, sonnet], 47842, openai), /injected rename failure/);
  failing.restore();
  assert.equal(await fs.readFile(p.config, 'utf8'), snapshot.config);
  assert.notEqual(await fs.readFile(p.catalog, 'utf8'), snapshot.catalog, 'the catalog must be left partially replaced');
  assert.ok((await readJson(p.state)).pendingInstall);
  return {p, sonnetAgent, snapshot};
}

// Simulates another editor changing config.toml after setup read it but before it commits.
function editAfterStateJournal(t: TestContext, p: Paths, edit: () => Promise<void>) {
  let done = false;
  const mocked = t.mock.method(fs, 'writeFile', async (file: any, ...rest: any[]) => {
    await (realWriteFile as any)(file, ...rest);
    if (!done && String(file).startsWith(`${p.state}.`)) {done = true; await edit();}
  });
  return {restore: () => mocked.mock.restore()};
}

// A real executable standing in for `codex app-server`, selected through CODEX_BIN.
async function fakeCodex(t: TestContext, p: Paths, mode: 'ok' | 'error' | 'apply-then-error') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-fake-codex-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const bin = path.join(dir, 'codex');
  const control = path.join(dir, 'control.json');
  const hookKey = 'hook-key-1';
  await fs.writeFile(bin, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';
const control = JSON.parse(fs.readFileSync(process.env.FIXTURE_CONTROL, 'utf8'));
const TOML = createRequire(control.projectRoot + '/')('@iarna/toml');
const reply = (id, body) => process.stdout.write(JSON.stringify({id, ...body}) + '\\n');
const apply = params => {
  const key = JSON.parse(params.keyPath.slice('hooks.state.'.length));
  const config = TOML.parse(fs.readFileSync(control.config, 'utf8'));
  config.hooks ??= {}; config.hooks.state ??= {}; config.hooks.state[key] = params.value;
  fs.writeFileSync(control.config, TOML.stringify(config));
};
readline.createInterface({input: process.stdin}).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'config/read') return reply(id, {result: {layers: [{name: {type: 'user'}, version: 'v1'}]}});
  if (method === 'hooks/list') return reply(id, {result: {data: [{hooks: [{key: control.hookKey, command: control.command, sourcePath: control.config,
    currentHash: 'hash-1', eventName: 'sessionStart', isManaged: false}]}]}});
  if (method === 'config/value/write') {
    if (control.mode === 'error') return reply(id, {error: {message: 'write refused'}});
    apply(params);
    if (control.mode === 'apply-then-error') return reply(id, {error: {message: 'response lost after write'}});
    return reply(id, {result: {}});
  }
  reply(id, {result: {}});
});
`, {mode: 0o755});
  const setControl = async (next: typeof mode) => {
    const hook = (await readState(p)).startHook;
    assert.ok(hook, 'the router startup hook must be installed before the fake Codex is configured');
    await fs.writeFile(control, JSON.stringify({mode: next, hookKey, config: p.config, command: hook.hooks[0].command,
      projectRoot: process.cwd()}));
  };
  await setControl(mode);
  const saved = {CODEX_BIN: process.env.CODEX_BIN, FIXTURE_CONTROL: process.env.FIXTURE_CONTROL};
  process.env.CODEX_BIN = bin; process.env.FIXTURE_CONTROL = control;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
  });
  return {hookKey, setControl};
}

test('select that fails to commit config leaves state describing the applied mode, including after a concurrent edit', {timeout: 20000}, async t => {
  const p = await fixture(t, 'select-fail');
  await installConfig(p, [haiku], 47842, openai);
  const original = await fs.readFile(p.config, 'utf8');
  const before = await readJson(p.state);

  const rename = failRename(t, to => to === p.config);
  await assert.rejects(activate(p), /injected rename failure/);
  rename.restore();
  assert.equal(await fs.readFile(p.config, 'utf8'), original);
  let state = await readJson(p.state);
  assert.equal(state.selected, undefined);
  assert.equal(state.previous, undefined);
  assert.deepEqual(state.files, before.files);

  const edit = editAfterStateJournal(t, p, async () => {
    const config = await readToml(p.config); config.apps = {example: {note: 'concurrent'}};
    await realWriteFile(p.config, TOML.stringify(config));
  });
  await assert.rejects(activate(p), /changed during setup/);
  edit.restore();
  state = await readJson(p.state);
  assert.equal(state.selected, undefined);
  assert.equal(state.previous, undefined);
  let config = await readToml(p.config);
  assert.equal(config.model_provider, undefined);
  assert.equal(config.apps.example.note, 'concurrent');

  await activate(p);
  assert.equal((await readToml(p.config)).model_provider, 'claude_agent_sdk');
  await deactivate(p);
  config = await readToml(p.config);
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.model_provider, undefined);
  assert.equal(config.apps.example.note, 'concurrent');
  assert.equal((await readJson(p.state)).selected, undefined);
});

test('select that commits config but fails to save state is reconciled by the next operation', {timeout: 20000}, async t => {
  const p = await fixture(t, 'select-state-fail');
  await installConfig(p, [haiku], 47842, openai);
  const rename = failRename(t, to => to === p.state, {skip: 1});
  await assert.rejects(activate(p), /injected rename failure/);
  rename.restore();
  assert.equal(rename.failures(), 1);
  assert.equal((await readToml(p.config)).model_provider, 'claude_agent_sdk');

  const config = await readToml(p.config); config.apps = {example: {note: 'kept'}};
  await fs.writeFile(p.config, TOML.stringify(config));
  await deactivate(p);
  const restored = await readToml(p.config);
  assert.equal(restored.model, 'gpt-original');
  assert.equal(restored.model_provider, undefined);
  assert.equal(restored.web_search, 'cached');
  assert.equal(restored.apps.example.note, 'kept');
  assert.equal((await readJson(p.state)).selected, undefined);
});

test('router-to-claude switch keeps hook trust ownership when the config write fails', {timeout: 30000}, async t => {
  const p = await fixture(t, 'switch-trust');
  await installConfig(p, [haiku], 47842, openai);
  const fake = await fakeCodex(t, p, 'ok');
  await activateRouter(p);
  await trustRouterStartup(p);
  const routed = await fs.readFile(p.config, 'utf8');
  assert.equal((await readToml(p.config)).hooks.state[fake.hookKey].trusted_hash, 'hash-1');

  const rename = failRename(t, to => to === p.config);
  await assert.rejects(activate(p), /injected rename failure/);
  rename.restore();
  assert.equal(await fs.readFile(p.config, 'utf8'), routed);
  const state = await readJson(p.state);
  assert.equal(state.selected.model_provider, 'codex_model_router');
  assert.equal(state.hookTrust.key, fake.hookKey);

  await deactivate(p);
  const config = await readToml(p.config);
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.hooks, undefined);
  assert.equal(config.features, undefined);
});

test('deactivate whose state save fails can be repeated and preserves unrelated edits', {timeout: 20000}, async t => {
  const p = await fixture(t, 'deactivate-fail', {model: 'gpt-original', apps: {example: {enabled: false}}});
  await installConfig(p, [haiku], 47842);
  await activate(p);
  const rename = failRename(t, to => to === p.state);
  await assert.rejects(deactivate(p), /injected rename failure/);
  rename.restore();
  let config = await readToml(p.config);
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.model_provider, undefined);
  assert.ok((await readJson(p.state)).selected);

  config.apps.example.later = 'user edit after the partial failure';
  await fs.writeFile(p.config, TOML.stringify(config));
  await deactivate(p);
  config = await readToml(p.config);
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.apps.example.later, 'user edit after the partial failure');
  assert.equal((await readJson(p.state)).selected, undefined);

  await activate(p);
  await deactivate(p);
  assert.equal((await readToml(p.config)).model, 'gpt-original');
});

test('deactivate still refuses to overwrite a conflicting user edit of an owned key', {timeout: 20000}, async t => {
  const p = await fixture(t, 'deactivate-conflict');
  await installConfig(p, [haiku], 47842);
  await activate(p);
  const config = await readToml(p.config); config.web_search = 'live';
  await fs.writeFile(p.config, TOML.stringify(config));
  const edited = await fs.readFile(p.config, 'utf8');
  await assert.rejects(deactivate(p), /web_search was edited/);
  assert.equal(await fs.readFile(p.config, 'utf8'), edited);
  assert.ok((await readJson(p.state)).selected);
});

test('first install that fails while writing owned files leaves nothing installed and can be retried', {timeout: 20000}, async t => {
  const p = await fixture(t, 'install-first-fail');
  const original = await fs.readFile(p.config, 'utf8');
  const agent = path.join(p.home, 'agents', 'claude_haiku.toml');
  const rename = failRename(t, to => to === agent);
  await assert.rejects(installConfig(p, [haiku], 47842, openai), /injected rename failure/);
  rename.restore();
  assert.equal(await fs.readFile(p.config, 'utf8'), original);
  assert.equal(await exists(p.catalog), false);
  assert.equal(await exists(path.join(p.home, 'claude.config.toml')), false);
  await assert.rejects(readState(p), /not installed/);

  await installConfig(p, [haiku], 47842, openai);
  assert.equal((await readToml(p.config)).model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47842/v1');
  assert.equal((await readJson(p.state)).port, 47842);
});

test('reinstall that fails before config commit keeps state, files and config consistent and is retryable', {timeout: 20000}, async t => {
  const p = await fixture(t, 'install-precommit');
  await installConfig(p, [haiku], 47842, openai);
  const configBefore = await fs.readFile(p.config, 'utf8');
  const catalogBefore = await fs.readFile(p.catalog, 'utf8');
  const stateBefore = await readJson(p.state);
  const sonnetAgent = path.join(p.home, 'agents', 'claude_sonnet.toml');

  const rename = failRename(t, to => to === p.config);
  await assert.rejects(installConfig(p, [haiku, sonnet], 47900, openai), /injected rename failure/);
  rename.restore();
  assert.equal(await fs.readFile(p.config, 'utf8'), configBefore);
  assert.equal(await fs.readFile(p.catalog, 'utf8'), catalogBefore);
  assert.equal(await exists(sonnetAgent), false);
  const state = await readJson(p.state);
  assert.equal(state.port, 47842);
  assert.deepEqual(state.models.map((m: any) => m.id), ['claude-sdk-haiku']);
  assert.deepEqual(state.files, stateBefore.files);

  await installConfig(p, [haiku, sonnet], 47900, openai);
  const config = await readToml(p.config);
  assert.equal(config.model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47900/v1');
  assert.equal(config.model_providers.codex_model_router.base_url, 'http://127.0.0.1:47900/v1');
  assert.equal(await exists(sonnetAgent), true);
  assert.equal((await readJson(p.state)).port, 47900);
});

test('reinstall racing a concurrent config edit rejects, preserves the edit, and can be retried', {timeout: 20000}, async t => {
  const p = await fixture(t, 'install-concurrent');
  await installConfig(p, [haiku], 47842, openai);
  const edit = editAfterStateJournal(t, p, async () => {
    const config = await readToml(p.config); config.apps = {example: {note: 'concurrent'}};
    await realWriteFile(p.config, TOML.stringify(config));
  });
  await assert.rejects(installConfig(p, [haiku, sonnet], 47900, openai), /changed during setup/);
  edit.restore();
  let config = await readToml(p.config);
  assert.equal(config.apps.example.note, 'concurrent');
  assert.equal(config.model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47842/v1');
  assert.equal((await readJson(p.state)).port, 47842);

  await installConfig(p, [haiku, sonnet], 47900, openai);
  config = await readToml(p.config);
  assert.equal(config.apps.example.note, 'concurrent');
  assert.equal(config.model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47900/v1');
});

test('install whose state commit fails after the config commit is reconciled by retry and uninstall', {timeout: 20000}, async t => {
  const p = await fixture(t, 'install-postcommit');
  const original = await readToml(p.config);
  const rename = failRename(t, to => to === p.state, {skip: 1});
  await assert.rejects(installConfig(p, [haiku], 47842, openai), /injected rename failure/);
  rename.restore();
  assert.equal(rename.failures(), 1);
  assert.equal((await readToml(p.config)).model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47842/v1');

  await installConfig(p, [haiku], 47842, openai);
  assert.equal((await readJson(p.state)).port, 47842);

  const second = await fixture(t, 'install-postcommit-uninstall');
  const failing = failRename(t, to => to === second.state, {skip: 1});
  await assert.rejects(installConfig(second, [haiku, sonnet], 47843, openai), /injected rename failure/);
  failing.restore();
  const config = await readToml(second.config); config.apps = {example: {note: 'kept'}};
  await fs.writeFile(second.config, TOML.stringify(config));
  await uninstallConfig(second);
  assert.deepEqual(await readToml(second.config), {...original, apps: {example: {note: 'kept'}}});
  assert.equal(await exists(second.state), false);
  assert.equal(await exists(second.catalog), false);
  assert.equal(await exists(path.join(second.home, 'agents', 'claude_sonnet.toml')), false);
});

test('an edited provider is never overwritten while recovering from an interrupted install', {timeout: 20000}, async t => {
  const p = await fixture(t, 'install-edited-provider');
  await installConfig(p, [haiku], 47842, openai);
  const rename = failRename(t, to => to === p.config);
  await assert.rejects(installConfig(p, [haiku], 47900, openai), /injected rename failure/);
  rename.restore();
  const config = await readToml(p.config);
  config.model_providers.claude_agent_sdk.name = 'user renamed provider';
  await fs.writeFile(p.config, TOML.stringify(config));
  const edited = await fs.readFile(p.config, 'utf8');
  await assert.rejects(installConfig(p, [haiku], 47900, openai), /unmanaged or edited Claude provider/);
  await assert.rejects(uninstallConfig(p), /provider was edited/);
  assert.equal(await fs.readFile(p.config, 'utf8'), edited);
});

test('hook trust write that is refused leaves config unchanged and does not shadow a later user entry', {timeout: 30000}, async t => {
  const p = await fixture(t, 'trust-refused');
  await installConfig(p, [haiku], 47842, openai);
  const fake = await fakeCodex(t, p, 'error');
  await activateRouter(p);
  await assert.rejects(trustRouterStartup(p), /write refused/);
  assert.equal((await readToml(p.config)).hooks.state, undefined);

  const config = await readToml(p.config);
  config.hooks.state = {[fake.hookKey]: {enabled: false, trusted_hash: 'user-hash'}};
  await fs.writeFile(p.config, TOML.stringify(config));
  await fake.setControl('ok');
  await trustRouterStartup(p);
  assert.equal((await readToml(p.config)).hooks.state[fake.hookKey].trusted_hash, 'hash-1');

  await deactivate(p);
  const restored = await readToml(p.config);
  assert.deepEqual(restored.hooks.state[fake.hookKey], {enabled: false, trusted_hash: 'user-hash'});
  assert.equal(restored.hooks.SessionStart, undefined);
  assert.equal(restored.model, 'gpt-original');
});

test('hook trust write that lands but reports failure is still restored by deactivate', {timeout: 30000}, async t => {
  const p = await fixture(t, 'trust-landed');
  await installConfig(p, [haiku], 47842, openai);
  const fake = await fakeCodex(t, p, 'apply-then-error');
  await activateRouter(p);
  await assert.rejects(trustRouterStartup(p), /response lost after write/);
  assert.equal((await readToml(p.config)).hooks.state[fake.hookKey].trusted_hash, 'hash-1');

  await deactivate(p);
  const config = await readToml(p.config);
  assert.equal(config.hooks, undefined);
  assert.equal(config.model, 'gpt-original');
  assert.equal((await readJson(p.state)).hookTrust, undefined);
});

test('an interrupted activation whose provider was then set to a third value conflicts everywhere and reconciles once restored', {timeout: 30000}, async t => {
  const p = await fixture(t, 'select-third');
  await installConfig(p, [haiku], 47842, openai);
  const rename = failRename(t, to => to === p.state, {skip: 1});
  await assert.rejects(activate(p), /injected rename failure/);
  rename.restore();
  assert.ok((await readJson(p.state)).pendingSelect);
  assert.equal((await readToml(p.config)).model_provider, 'claude_agent_sdk');

  const config = await readToml(p.config);
  config.model_provider = 'third_party'; config.apps = {example: {note: 'kept'}};
  await fs.writeFile(p.config, TOML.stringify(config));
  const edited = await fs.readFile(p.config, 'utf8');
  const journal = await fs.readFile(p.state, 'utf8');

  const operations: Record<string, () => Promise<unknown>> = {
    activate: () => activate(p), activateRouter: () => activateRouter(p), deactivate: () => deactivate(p),
    trustRouterStartup: () => trustRouterStartup(p), uninstallConfig: () => uninstallConfig(p),
    installConfig: () => installConfig(p, [haiku], 47842, openai),
  };
  for (const [name, run] of Object.entries(operations)) {
    await assert.rejects(run(), /model_provider was edited after an interrupted mode switch/, name);
    assert.equal(await fs.readFile(p.config, 'utf8'), edited, `${name} must not touch config.toml`);
    assert.equal(await fs.readFile(p.state, 'utf8'), journal, `${name} must keep the pending journal`);
  }
  assert.ok((await readJson(p.state)).pendingSelect);

  // The owner restores the interrupted target value: the journal is adopted and deactivate restores the original mode.
  const restored = await readToml(p.config); restored.model_provider = 'claude_agent_sdk';
  await fs.writeFile(p.config, TOML.stringify(restored));
  await deactivate(p);
  const after = await readToml(p.config);
  assert.equal(after.model, 'gpt-original');
  assert.equal(after.model_provider, undefined);
  assert.equal(after.web_search, 'cached');
  assert.equal(after.apps.example.note, 'kept');
  const state = await readJson(p.state);
  assert.equal(state.selected, undefined);
  assert.equal(state.pendingSelect, undefined);

  // The owner restores every original value instead: the journal is dropped and a new activation proceeds.
  const second = await fixture(t, 'select-third-original');
  await installConfig(second, [haiku], 47842, openai);
  const failing = failRename(t, to => to === second.state, {skip: 1});
  await assert.rejects(activate(second), /injected rename failure/);
  failing.restore();
  const edit = await readToml(second.config); edit.model_provider = 'third_party'; edit.apps = {example: {note: 'kept'}};
  await fs.writeFile(second.config, TOML.stringify(edit));
  await assert.rejects(activate(second), /interrupted mode switch/);
  const original = await readToml(second.config);
  original.model = 'gpt-original'; original.web_search = 'cached';
  delete original.model_provider; delete original.model_catalog_json; delete original.agents;
  await fs.writeFile(second.config, TOML.stringify(original));
  await activate(second);
  assert.equal((await readToml(second.config)).model_provider, 'claude_agent_sdk');
  assert.equal((await readToml(second.config)).apps.example.note, 'kept');
  const next = await readJson(second.state);
  assert.equal(next.pendingSelect, undefined);
  assert.equal(next.selected.model_provider, 'claude_agent_sdk');
  await deactivate(second);
  assert.equal((await readToml(second.config)).model, 'gpt-original');
});

test('the next activation repairs a partial same-port reinstall, still selects the old model and keeps unrelated edits', {timeout: 30000}, async t => {
  const {p, sonnetAgent, snapshot} = await interruptedSamePortReinstall(t, 'repair-partial');
  const config = await readToml(p.config); config.apps = {example: {note: 'kept'}};
  await fs.writeFile(p.config, TOML.stringify(config));

  await activate(p);
  const state = await readJson(p.state);
  assert.equal(state.pendingInstall, undefined);
  assert.deepEqual(state.models.map((m: any) => m.id), ['claude-sdk-haiku']);
  assert.equal(state.selected.model, 'claude-sdk-haiku');
  assert.equal(await fs.readFile(p.catalog, 'utf8'), snapshot.catalog);
  assert.equal(await fs.readFile(path.join(p.home, 'claude.config.toml'), 'utf8'), snapshot.claudeConfig);
  assert.equal(await fs.readFile(p.combined, 'utf8'), snapshot.combined);
  assert.equal(await exists(sonnetAgent), false);
  const active = await readToml(p.config);
  assert.equal(active.model, 'claude-sdk-haiku');
  assert.equal(active.model_provider, 'claude_agent_sdk');
  assert.equal(active.apps.example.note, 'kept');

  await deactivate(p);
  const restored = await readToml(p.config);
  assert.equal(restored.model, 'gpt-original');
  assert.equal(restored.apps.example.note, 'kept');
});

test('recovery of a partial reinstall refuses to overwrite a user edit of an owned file and proceeds once it is restored', {timeout: 30000}, async t => {
  const {p, snapshot} = await interruptedSamePortReinstall(t, 'repair-edited');
  await fs.writeFile(p.catalog, '{"user": "edited"}\n');
  const config = await fs.readFile(p.config, 'utf8');
  const journal = await fs.readFile(p.state, 'utf8');

  const refused = (error: Error) => error.message.includes(`Owned file was edited: ${p.catalog}`) && error.message.includes('Refusing to overwrite');
  for (const run of [() => activate(p), () => installConfig(p, [haiku, sonnet], 47842, openai), () => uninstallConfig(p)]) {
    await assert.rejects(run(), refused);
    assert.equal(await fs.readFile(p.catalog, 'utf8'), '{"user": "edited"}\n');
    assert.equal(await fs.readFile(p.config, 'utf8'), config);
    assert.equal(await fs.readFile(p.state, 'utf8'), journal);
  }

  await fs.writeFile(p.catalog, snapshot.catalog);
  await activate(p);
  const state = await readJson(p.state);
  assert.equal(state.pendingInstall, undefined);
  assert.equal(state.selected.model, 'claude-sdk-haiku');
  assert.equal(await fs.readFile(p.catalog, 'utf8'), snapshot.catalog);
});

test('installCommitted proves committed or precommit and reports ambiguity instead of a rollback verdict', {timeout: 30000}, async t => {
  const p = await fixture(t, 'committed-decision');
  const rename = failRename(t, to => to === p.state, {skip: 1});
  await assert.rejects(installConfig(p, [haiku], 47842, openai), /injected rename failure/);
  rename.restore();
  assert.equal((await readToml(p.config)).model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47842/v1');
  assert.equal(await installCommitted(p), true);
  assert.deepEqual(await failedInstallOutcome(p, true), {outcome: 'committed', reason: ''});

  // Unreadable state, config or owned file: neither committed nor precommit may be claimed.
  const unreadable: [string, (file: string) => boolean][] = [['state', file => file === p.state],
    ['config', file => file === p.config], ['owned file', file => file === p.catalog]];
  for (const [what, match] of unreadable) {
    const reading = failRead(t, match);
    await assert.rejects(installCommitted(p), /Cannot tell whether the install reached config\.toml: .*injected read failure/, what);
    const unknown = await failedInstallOutcome(p, true);
    // Before the runtime swap installConfig never ran, so that case needs no read at all.
    const unswapped = await failedInstallOutcome(p, false);
    reading.restore();
    assert.equal(unknown.outcome, 'unknown', what);
    assert.match(unknown.reason, /injected read failure/, what);
    assert.equal(unswapped.outcome, 'precommit');
  }

  const state = await fs.readFile(p.state, 'utf8');
  await fs.writeFile(p.state, '{not json');
  await assert.rejects(installCommitted(p), /Cannot tell/);
  assert.equal((await failedInstallOutcome(p, true)).outcome, 'unknown');
  await fs.writeFile(p.state, state);

  const config = await fs.readFile(p.config, 'utf8');
  await fs.writeFile(p.config, 'model = = broken');
  await assert.rejects(installCommitted(p), /Cannot tell/);
  assert.equal((await failedInstallOutcome(p, true)).outcome, 'unknown');
  const renamed = TOML.parse(config) as any; renamed.model_providers.claude_agent_sdk.name = 'user renamed provider';
  await fs.writeFile(p.config, TOML.stringify(renamed));
  await assert.rejects(installCommitted(p), /matches neither/);
  await fs.writeFile(p.config, config);
  assert.equal(await installCommitted(p), true);

  // A proved precommit state: config.toml still holds the old install and the rollback could not complete.
  const interrupted = await interruptedSamePortReinstall(t, 'decision-precommit');
  assert.equal(await installCommitted(interrupted.p), false);
  assert.equal((await failedInstallOutcome(interrupted.p, true)).outcome, 'precommit');

  // No state at all is the original only while config.toml owns no providers.
  const fresh = await fixture(t, 'decision-fresh');
  assert.equal(await installCommitted(fresh), false);
  const foreign = await fixture(t, 'decision-foreign', {model_providers: {claude_agent_sdk: {name: 'someone else'}}});
  await assert.rejects(installCommitted(foreign), /no install state exists/);
  assert.equal((await failedInstallOutcome(foreign, true)).outcome, 'unknown');
});

test('a changed-port install already committed to config.toml is not promoted over edited or removed owned files', {timeout: 30000}, async t => {
  const p = await fixture(t, 'install-committed-files');
  await installConfig(p, [haiku], 47842, openai);
  const rename = failRename(t, to => to === p.state, {skip: 1});
  await assert.rejects(installConfig(p, [haiku, sonnet], 47900, openai), /injected rename failure/);
  rename.restore();
  const pending = (await readJson(p.state)).pendingInstall;
  const sonnetAgent = path.join(p.home, 'agents', 'claude_sonnet.toml');
  assert.equal(pending.port, 47900);
  assert.equal((await readToml(p.config)).model_providers.claude_agent_sdk.base_url, 'http://127.0.0.1:47900/v1');
  assert.equal(await installCommitted(p), true);

  const config = await readToml(p.config); config.apps = {example: {note: 'kept'}};
  await fs.writeFile(p.config, TOML.stringify(config));
  const configText = await fs.readFile(p.config, 'utf8');
  const journal = await fs.readFile(p.state, 'utf8');
  const operations = [() => activate(p), () => installConfig(p, [haiku, sonnet], 47900, openai), () => uninstallConfig(p), () => installCommitted(p)];

  await fs.rm(sonnetAgent);
  for (const run of operations) await assert.rejects(run(), (error: Error) => error.message.includes('edited or removed') && error.message.includes(sonnetAgent));
  assert.equal(await exists(sonnetAgent), false, 'a removed owned file must not be recreated by recovery');

  await fs.writeFile(sonnetAgent, pending.files[sonnetAgent]);
  await fs.writeFile(p.catalog, 'user edit\n');
  for (const run of operations) await assert.rejects(run(), (error: Error) => error.message.includes('edited or removed') && error.message.includes(p.catalog));
  assert.equal(await fs.readFile(p.catalog, 'utf8'), 'user edit\n');
  assert.equal(await fs.readFile(p.config, 'utf8'), configText);
  assert.equal(await fs.readFile(p.state, 'utf8'), journal);

  await fs.writeFile(p.catalog, pending.files[p.catalog]);
  assert.equal(await installCommitted(p), true);
  await activate(p);
  const state = await readJson(p.state);
  assert.equal(state.pendingInstall, undefined);
  assert.equal(state.port, 47900);
  assert.equal(state.selected.model, 'claude-sdk-sonnet');
  assert.equal((await readToml(p.config)).apps.example.note, 'kept');
});
