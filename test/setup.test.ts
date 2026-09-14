import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { activate, activateRouter, deactivate, installConfig, locations, uninstallConfig, withLock } from '../src/setup.js';

const models = [{id: 'claude-sdk-haiku', sdkModel: 'haiku', displayName: 'Claude Agent · Haiku', description: 'Fast', efforts: []}];

test('config lifecycle preserves values and subsequent unrelated edits', {timeout: 10000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-config-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  const original = '# A comment preserved in the backup\nmodel = "original"\n[apps.example]\nenabled = false\n';
  await fs.writeFile(p.config, original);
  await withLock(p, () => installConfig(p, models, 47842));
  await withLock(p, () => installConfig(p, models, 47842));
  await activate(p);
  let config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(config.model, models[0]!.id);
  assert.equal(config.model_provider, 'claude_agent_sdk');
  config.apps.example.extra = 'preserved';
  await fs.writeFile(p.config, TOML.stringify(config));
  await deactivate(p);
  config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(config.model, 'original');
  assert.equal(config.model_provider, undefined);
  assert.equal(config.apps.example.extra, 'preserved');
  await uninstallConfig(p);
  config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.deepEqual(config, {model: 'original', apps: {example: {enabled: false, extra: 'preserved'}}});
  await assert.rejects(fs.access(p.catalog));
  const backups = await fs.readdir(path.join(p.root, 'backups'));
  assert.ok((await Promise.all(backups.map(f => fs.readFile(path.join(p.root, 'backups', f), 'utf8')))).includes(original));
});

test('edited or colliding owned files are preserved on reinstall and uninstall', {timeout: 10000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-conflict-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  await withLock(p, () => installConfig(p, models, 47842));
  const config = await fs.readFile(p.config, 'utf8');
  const agent = path.join(p.home, 'agents', 'claude_haiku.toml');
  await fs.appendFile(agent, '# user edit\n');
  await assert.rejects(installConfig(p, models, 47842), /Owned file was edited/);
  await assert.rejects(uninstallConfig(p), /edited file/);
  assert.equal(await fs.readFile(p.config, 'utf8'), config);
  assert.match(await fs.readFile(agent, 'utf8'), /user edit/);
});

test('exclusive setup lock prevents concurrent mutation', {timeout: 10000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-lock-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  await withLock(p, async () => {await assert.rejects(withLock(p, async () => {}), /Another setup/);});
  await withLock(p, async () => {});
});

test('v0.1 upgrade enables a combined picker while preserving the default model and unrelated settings', {timeout: 10000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-router-upgrade-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  const original = {model: 'gpt-original', web_search: 'cached', features: {hooks: false, apps: true},
    agents: {max_concurrent_threads_per_session: 4}, apps: {example: {enabled: false}},
    hooks: {SessionStart: [{hooks: [{type: 'command', command: 'echo user-hook'}]}]}};
  await fs.writeFile(p.config, TOML.stringify(original));
  await withLock(p, () => installConfig(p, models, 47842));
  const legacy = JSON.parse(await fs.readFile(p.state, 'utf8')); legacy.version = '0.1.0';
  await fs.writeFile(p.state, JSON.stringify(legacy));
  await fs.writeFile(p.token, 'local-router-token', {mode: 0o600});
  await withLock(p, () => installConfig(p, models, 47842, {models: [{slug: 'gpt-original', priority: 0}]}));
  await activateRouter(p);
  let config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.model_provider, 'codex_model_router');
  assert.equal(config.web_search, 'cached');
  assert.equal(config.features.hooks, true);
  assert.equal(config.hooks.SessionStart.length, 2);
  assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'echo user-hook');
  assert.equal(config.model_providers.codex_model_router.requires_openai_auth, true);
  assert.equal(config.model_providers.codex_model_router.auth, undefined);
  const catalog = JSON.parse(await fs.readFile(p.combined, 'utf8'));
  assert.deepEqual(catalog.models.map((m: any) => m.slug), ['gpt-original', 'claude-sdk-haiku']);
  config.model = 'claude-sdk-haiku'; config.apps.example.user_edit = 'retained';
  await fs.writeFile(p.config, TOML.stringify(config));
  await deactivate(p);
  await uninstallConfig(p);
  config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.deepEqual(config, {...original, apps: {example: {enabled: false, user_edit: 'retained'}}});
});

test('switching provider modes releases ownership of settings no longer changed by that mode', {timeout: 10000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-router-modes-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = locations(root);
  await fs.mkdir(p.root, {recursive: true}); await fs.writeFile(p.token, 'test-token');
  await fs.writeFile(p.config, TOML.stringify({model: 'gpt-original', web_search: 'cached'}));
  await installConfig(p, models, 47842, {models: [{slug: 'gpt-original'}]});
  await activate(p); await activateRouter(p);
  let config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(config.web_search, 'cached');
  config.web_search = 'live';
  await fs.writeFile(p.config, TOML.stringify(config));
  await activate(p); await deactivate(p);
  config = TOML.parse(await fs.readFile(p.config, 'utf8')) as any;
  assert.equal(config.model, 'gpt-original');
  assert.equal(config.web_search, 'live');
  assert.equal(config.features, undefined);
});
