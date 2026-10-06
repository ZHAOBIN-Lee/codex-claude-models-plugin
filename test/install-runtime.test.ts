import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import TOML from '@iarna/toml';
import { build } from 'esbuild';
import { locations } from '../src/setup.js';

// These tests drive the REAL installer entry (src/setup-main.ts, bundled with esbuild into a temporary plugin) as a
// subprocess against temporary Codex homes. The backend (bin/bridge.mjs) is an explicitly FAKE fixture: it never imports
// the SDK, reads no credentials and runs no inference. This is not Claude, sandbox or desktop acceptance.

const haiku = {id: 'claude-sdk-haiku', sdkModel: 'haiku', displayName: 'Claude Agent · Haiku', description: 'Fast', efforts: []};
const sonnet = {id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent · Sonnet', description: 'Balanced', efforts: ['medium', 'high']};
const opus = {id: 'claude-sdk-opus', sdkModel: 'opus', displayName: 'Claude Agent · Opus', description: 'Deep', efforts: ['medium', 'high']};
const modelsA = [haiku, sonnet];
const modelsB = [haiku, sonnet, opus];
const ORIGINAL = {model: 'gpt-original', web_search: 'cached'};

type Revision = 'A' | 'B' | 'B-bad';
// `-bad` revisions answer `models` but exit on `serve`, to inject a startup failure after the config commit.
function bridgeSource(revision: Revision, models: unknown[]) {
  return `// fixture-revision: ${revision}
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--codex-home') + 1];
const root = path.join(home, 'claude-models');
if (args[0] === 'models') {
  console.log(JSON.stringify({authenticated: true, subscriptionType: 'pro', models: ${JSON.stringify(models)}}));
} else if (args[0] === 'serve') {
  if (${revision.endsWith('-bad')}) {console.error('fixture bridge refuses to serve'); process.exit(1);}
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  const tokenFile = path.join(root, 'token');
  const server = http.createServer((req, res) => {
    let token = '';
    try {token = fs.readFileSync(tokenFile, 'utf8').trim();} catch {}
    if (req.url === '/health' && token && req.headers.authorization === 'Bearer ' + token) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({service: 'codex-claude-models', version: 'fixture-${revision}', pid: process.pid}));
    } else {res.writeHead(404); res.end();}
  });
  const record = path.join(root, 'fixture-bridge-' + process.pid + '.json');
  process.on('exit', () => {try {fs.rmSync(record, {force: true});} catch {}});
  process.on('SIGTERM', () => {server.closeAllConnections(); server.close(); process.exit(0);});
  server.on('error', () => process.exit(1));
  server.listen(state.port, '127.0.0.1', () => {
    fs.writeFileSync(record, JSON.stringify({pid: process.pid, port: state.port, revision: '${revision}'}));
  });
  // Safety net so a fixture bridge can never outlive its temporary home.
  setTimeout(() => process.exit(0), 180000).unref();
  setInterval(() => {try {fs.accessSync(tokenFile);} catch {process.exit(0);}}, 1000).unref();
}
`;
}

// Patches fs.promises.rename in the installer process only. A rule matches by exact destination path; `mode: 'after'`
// lets the real rename happen and then reports a failure, like an atomic rename whose acknowledgement was lost.
const FAULT_SOURCE = `import { promises as fs } from 'node:fs';
const spec = JSON.parse(process.env.FIXTURE_FAULT ?? '{"rules":[]}');
const real = fs.rename.bind(fs);
const counts = spec.rules.map(() => ({seen: 0, failed: 0}));
fs.rename = async (from, to) => {
  for (const [index, rule] of spec.rules.entries()) {
    if (rule.prefix ? !String(to).startsWith(rule.prefix) : String(to) !== rule.path) continue;
    const count = counts[index];
    if (count.seen++ < (rule.skip ?? 0) || count.failed >= (rule.times ?? 1)) continue;
    count.failed++;
    if (rule.mode === 'after') await real(from, to);
    throw Object.assign(new Error('fixture rename failure'), {code: 'EIO'});
  }
  return real(from, to);
};
`;
// A rule matches one exact destination `path`, or (only for the unique runtime backup name) every destination starting with `prefix`.
interface Rule {path?: string; prefix?: string; mode: 'before' | 'after'; skip?: number; times?: number}

let bundled: Promise<string> | undefined;
function bundleSetup() {
  bundled ??= build({entryPoints: [path.resolve('src/setup-main.ts')], bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
    outfile: path.join(os.tmpdir(), 'unused-setup.mjs'), logLevel: 'silent', external: ['@anthropic-ai/claude-agent-sdk'],
    banner: {js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'},
  }).then(result => {
    const text = result.outputFiles?.[0]?.text;
    if (!text) throw new Error('The installer bundle is empty.');
    return text;
  });
  return bundled;
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {const {port} = server.address() as net.AddressInfo; server.close(() => resolve(port));});
  });
}

async function healthOf(f: Fixture, port: number) {
  const token = (await fs.readFile(f.p.token, 'utf8').catch(() => '')).trim();
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(1000)});
    return response.ok ? await response.json() as {service: string; version: string; pid: number} : null;
  } catch {return null;}
}

// Only a process that answers the authenticated health check on this fixture's own port with its recorded PID is stopped.
async function stopOwnedBridges(f: Fixture) {
  for (const name of await fs.readdir(f.p.root).catch(() => [] as string[])) {
    if (!/^fixture-bridge-\d+\.json$/.test(name)) continue;
    const record = JSON.parse(await fs.readFile(path.join(f.p.root, name), 'utf8').catch(() => '{}')) as {pid?: number; port?: number};
    if (!record.pid || !record.port) continue;
    const live = await healthOf(f, record.port);
    if (!live || live.pid !== record.pid) continue;
    process.kill(record.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 30 && await healthOf(f, record.port); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (await healthOf(f, record.port)) process.kill(record.pid, 'SIGKILL');
  }
}

interface Fixture {
  base: string; home: string; plugin: string; setupPath: string; faultPath: string; npmCache: string;
  p: ReturnType<typeof locations>; portA: number; portB: number;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-install-')));
  const home = path.join(base, 'home');
  const plugin = path.join(base, 'plugin');
  await fs.mkdir(path.join(plugin, 'bin'), {recursive: true});
  await fs.mkdir(path.join(plugin, 'runtime'), {recursive: true});
  await fs.mkdir(home, {recursive: true});
  const setupPath = path.join(plugin, 'bin', 'setup.mjs');
  const faultPath = path.join(base, 'fault.mjs');
  await fs.writeFile(setupPath, await bundleSetup());
  await fs.writeFile(faultPath, FAULT_SOURCE);
  // An empty dependency set keeps the real `npm ci` offline.
  await fs.writeFile(path.join(plugin, 'runtime', 'package.json'), JSON.stringify({name: 'fixture-runtime', version: '1.0.0', private: true}));
  await fs.writeFile(path.join(plugin, 'runtime', 'package-lock.json'), JSON.stringify({name: 'fixture-runtime', version: '1.0.0', lockfileVersion: 3,
    requires: true, packages: {'': {name: 'fixture-runtime', version: '1.0.0'}}}));
  await fs.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({models: [{slug: 'gpt-fixture', priority: 1}]}));
  await fs.writeFile(path.join(home, 'config.toml'), TOML.stringify(ORIGINAL));
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const f: Fixture = {base, home, plugin, setupPath, faultPath, npmCache: path.join(base, 'npm-cache'), p: locations(home), portA, portB};
  t.after(async () => {
    try {await stopOwnedBridges(f);}
    finally {await fs.rm(base, {recursive: true, force: true});}
  });
  return f;
}

const writeBridge = (f: Fixture, revision: Revision, models: unknown[]) => fs.writeFile(path.join(f.plugin, 'bin', 'bridge.mjs'), bridgeSource(revision, models));

interface Result {code: number | null; stdout: string; stderr: string; timedOut: boolean}
// The fault preload is a CLI flag of this one installer process, never NODE_OPTIONS, so bridge children are unmodified.
function runSetup(f: Fixture, args: string[], rules: Rule[] = []) {
  return new Promise<Result>(resolve => {
    const env: NodeJS.ProcessEnv = {...process.env, CODEX_HOME: f.home, CODEX_BIN: path.join(f.base, 'codex-must-not-run'),
      npm_config_cache: f.npmCache, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false'};
    delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT; delete env.FIXTURE_FAULT;
    if (rules.length) env.FIXTURE_FAULT = JSON.stringify({rules});
    const child = spawn(process.execPath, [...(rules.length ? ['--import', pathToFileURL(f.faultPath).href] : []), f.setupPath, ...args, '--codex-home', f.home],
      {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, 90000);
    child.on('error', error => {clearTimeout(timer); resolve({code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut});});
    child.on('close', code => {clearTimeout(timer); resolve({code, stdout, stderr, timedOut});});
  });
}
const install = (f: Fixture, port: number, rules: Rule[] = []) => runSetup(f, ['install', '--port', String(port)], rules);
const detail = (result: Result) => `exit ${result.code}${result.timedOut ? ' (timed out)' : ''}: ${result.stderr.slice(0, 400)}`;

async function observe(f: Fixture) {
  const configText = await fs.readFile(f.p.config, 'utf8');
  const config = TOML.parse(configText) as any;
  const baseUrl = config.model_providers?.claude_agent_sdk?.base_url;
  const stateText = await fs.readFile(f.p.state, 'utf8').catch(() => '');
  const runtimeText = await fs.readFile(path.join(f.p.runtime, 'bridge.mjs'), 'utf8').catch(() => '');
  const entries = await fs.readdir(f.p.root);
  const backups = [];
  for (const name of entries.filter(entry => entry.startsWith('runtime.backup-'))) {
    const text = await fs.readFile(path.join(f.p.root, name, 'bridge.mjs'), 'utf8').catch(() => '');
    backups.push(/fixture-revision: (\S+)/.exec(text)?.[1] ?? null);
  }
  return {configText, config, configPort: baseUrl ? Number(new URL(baseUrl).port) : null, state: stateText ? JSON.parse(stateText) as any : undefined,
    runtimeRevision: /fixture-revision: (\S+)/.exec(runtimeText)?.[1] ?? null, backups, stages: entries.filter(entry => entry.startsWith('runtime-stage-'))};
}
const catalogSlugs = async (f: Fixture) => (JSON.parse(await fs.readFile(f.p.catalog, 'utf8')) as {models: {slug: string}[]}).models.map(m => m.slug);
const ownedFiles = async (files: Record<string, string>) => Object.fromEntries(await Promise.all(Object.keys(files).map(async file => [file, await fs.readFile(file, 'utf8').catch(() => null)])));

// The invariant every outcome must satisfy: whichever revision config.toml names, the runtime directory, the state
// (committed or journaled target) and the owned files on disk belong to that same revision.
async function assertConsistent(f: Fixture, label: string) {
  const o = await observe(f);
  const revision = o.configPort === f.portA ? 'A' : o.configPort === f.portB ? 'B' : null;
  assert.ok(revision, `${label}: config.toml names no known provider port`);
  assert.ok(o.runtimeRevision?.startsWith(revision), `${label}: config.toml names ${revision} but the runtime is ${o.runtimeRevision}`);
  assert.ok(o.state, `${label}: install state is missing`);
  const target = o.state.pendingInstall ?? o.state;
  assert.equal(target.port, revision === 'A' ? f.portA : f.portB, `${label}: state does not describe ${revision}`);
  if (revision === 'A') assert.equal(o.state.pendingInstall, undefined, `${label}: stale pending journal under config A`);
  for (const [file, content] of Object.entries(target.files as Record<string, string>)) {
    assert.equal(await fs.readFile(file, 'utf8').catch(() => null), content, `${label}: owned file ${path.basename(file)} does not hold the ${revision} content`);
  }
  assert.equal((await catalogSlugs(f)).includes('claude-sdk-opus'), revision === 'B', `${label}: catalog does not match ${revision}`);
  return {revision, observed: o};
}

async function installRevisionA(f: Fixture) {
  await writeBridge(f, 'A', modelsA);
  const result = await install(f, f.portA);
  assert.equal(result.code, 0, `revision A must install (${detail(result)})`);
  assert.match(result.stdout, /"installed": true/);
  assert.equal((await healthOf(f, f.portA))?.version, 'fixture-A');
}
async function userEdit(f: Fixture) {
  const config = TOML.parse(await fs.readFile(f.p.config, 'utf8')) as any;
  config.apps = {example: {note: 'kept'}};
  await fs.writeFile(f.p.config, TOML.stringify(config));
}
async function retryRevisionB(f: Fixture) {
  await writeBridge(f, 'B', modelsB);
  const result = await install(f, f.portB);
  assert.equal(result.code, 0, `the retry must succeed (${detail(result)})`);
  assert.match(result.stdout, /"installed": true/);
  const {observed} = await assertConsistent(f, 'after retry');
  assert.equal(observed.configPort, f.portB);
  assert.equal(observed.state.pendingInstall, undefined);
  assert.equal(observed.runtimeRevision, 'B');
  assert.equal((await healthOf(f, f.portB))?.version, 'fixture-B');
  assert.equal(observed.config.apps.example.note, 'kept');
}
// stop / deactivate / uninstall through the real CLI touch only owned values.
async function cleanLifecycle(f: Fixture) {
  const installed = (await observe(f)).config;
  const run = async (...args: string[]) => {const result = await runSetup(f, args); assert.equal(result.code, 0, `${args[0]} must succeed (${detail(result)})`);};
  await run('activate', '--model', 'claude-sdk-sonnet');
  const active = (await observe(f)).config;
  assert.equal(active.model, 'claude-sdk-sonnet');
  assert.equal(active.model_provider, 'claude_agent_sdk');
  await run('deactivate');
  assert.deepEqual((await observe(f)).config, installed);
  await run('stop');
  assert.equal(await healthOf(f, f.portB), null);
  await run('uninstall');
  assert.deepEqual((await observe(f)).config, {...ORIGINAL, apps: {example: {note: 'kept'}}});
  assert.equal(await fs.access(f.p.state).then(() => true, () => false), false);
  assert.equal(await fs.access(f.p.catalog).then(() => true, () => false), false);
}

test('B reinstall whose config rename fails before replacing restores runtime A and is retryable', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await installRevisionA(f);
  await userEdit(f);
  const before = await observe(f);
  const ownedBefore = await ownedFiles(before.state.files);

  await writeBridge(f, 'B', modelsB);
  const failed = await install(f, f.portB, [{path: f.p.config, mode: 'before'}]);
  assert.notEqual(failed.code, 0, 'a failed config commit is reported as a failure');
  assert.equal(failed.timedOut, false);
  assert.doesNotMatch(failed.stdout, /"installed": true/);

  const after = await observe(f);
  assert.equal(after.configText, before.configText, 'config.toml, including the unrelated user edit, is untouched');
  assert.equal(after.configPort, f.portA);
  assert.equal(after.state.port, f.portA);
  assert.equal(after.state.pendingInstall, undefined);
  assert.deepEqual(after.state.models.map((m: any) => m.id), modelsA.map(m => m.id));
  assert.deepEqual(after.state.files, before.state.files);
  assert.deepEqual(await ownedFiles(before.state.files), ownedBefore, 'owned catalogs and agents still hold the A content');
  assert.equal(after.runtimeRevision, 'A', 'runtime A is restored');
  assert.deepEqual(after.backups, [], 'the runtime backup was consumed by the restore');
  assert.deepEqual(after.stages, []);
  await assertConsistent(f, 'after failed B');
  assert.equal((await healthOf(f, f.portA))?.version, 'fixture-A', 'the restored A runtime is serving again');

  await retryRevisionB(f);
  await cleanLifecycle(f);
});

test('B reinstall whose config commits but whose state cannot be saved keeps runtime B and the A backup, and reconciles on retry', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await installRevisionA(f);
  await userEdit(f);

  await writeBridge(f, 'B', modelsB);
  // The journal save (first state rename) succeeds; every later state save fails, including the recovery attempt.
  const failed = await install(f, f.portB, [{path: f.p.state, mode: 'before', skip: 1, times: 1000000}]);
  assert.notEqual(failed.code, 0, 'the command reports failure');
  assert.equal(failed.timedOut, false);
  assert.doesNotMatch(failed.stdout, /"installed": true/);
  assert.match(failed.stderr, /already updated|rerun install/i, 'the failure is described as recoverable');

  const o = await observe(f);
  assert.equal(o.configPort, f.portB, 'config.toml was committed to B');
  assert.equal(o.state.port, f.portA, 'the committed state fields still describe A');
  assert.equal(o.state.pendingInstall.port, f.portB, 'the journal names B');
  assert.equal(o.runtimeRevision, 'B', 'runtime B is retained');
  assert.deepEqual(o.backups, ['A'], 'the A runtime backup is retained');
  assert.equal(o.config.apps.example.note, 'kept');
  for (const [file, content] of Object.entries(o.state.pendingInstall.files as Record<string, string>)) {
    assert.equal(await fs.readFile(file, 'utf8'), content, `owned file ${path.basename(file)} holds the B content`);
  }
  assert.ok((await catalogSlugs(f)).includes('claude-sdk-opus'));
  await assertConsistent(f, 'after failed state save');

  await retryRevisionB(f);
  await cleanLifecycle(f);
});

test('startup failure after the config commit keeps B and the A backup, and a healthy retry succeeds', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await installRevisionA(f);
  await userEdit(f);

  await writeBridge(f, 'B-bad', modelsB);
  const failed = await install(f, f.portB);
  assert.notEqual(failed.code, 0, 'a bridge that never becomes healthy is a failed install');
  assert.equal(failed.timedOut, false);
  assert.doesNotMatch(failed.stdout, /"installed": true/);
  assert.match(failed.stderr, /did not start|already updated/i);

  const o = await observe(f);
  assert.equal(o.configPort, f.portB);
  assert.equal(o.state.port, f.portB);
  assert.equal(o.state.pendingInstall, undefined);
  assert.equal(o.runtimeRevision, 'B-bad', 'the committed runtime is kept');
  assert.deepEqual(o.backups, ['A'], 'the A runtime backup is retained');
  assert.equal(await healthOf(f, f.portB), null);
  assert.equal(o.config.apps.example.note, 'kept');
  await assertConsistent(f, 'after failed startup');

  await retryRevisionB(f);
  await cleanLifecycle(f);
});

// An atomic rename can take effect and still report failure. Whatever the installer does next, it must never leave
// config B over runtime A, nor roll owned B files back underneath a B config.
const lostAcknowledgements: [string, (f: Fixture) => Rule[]][] = [
  ['the config commit rename', f => [{path: f.p.config, mode: 'after'}]],
  ['the final state commit rename', f => [{path: f.p.state, mode: 'after', skip: 1}]],
];
for (const [name, rules] of lostAcknowledgements) {
  test(`a rename that applied but reported failure (${name}) never leaves a mixed runtime`, {timeout: 90000}, async t => {
    const f = await fixture(t);
    await installRevisionA(f);
    await userEdit(f);

    await writeBridge(f, 'B', modelsB);
    const failed = await install(f, f.portB, rules(f));
    assert.equal(failed.timedOut, false);
    if (failed.code !== 0) assert.doesNotMatch(failed.stdout, /"installed": true/);
    const {revision, observed} = await assertConsistent(f, name);
    assert.equal(observed.config.apps.example.note, 'kept', 'the unrelated user edit survives');
    assert.equal(revision, 'B', 'config.toml was really replaced, so B is the only consistent outcome');

    await retryRevisionB(f);
    await cleanLifecycle(f);
  });
}

// B's very first state save (the journal) is refused before it applies. Nothing of B reached config.toml or the owned
// files, so the committed A state is still the truth and the A runtime must come back, even though no B journal exists.
// This must not be mistaken for "a state without a pending journal means committed".
for (const [name, samePort] of [['a new port', false], ['the same port with more models', true]] as const) {
  test(`B reinstall whose first journal save refuses before applying (${name}) keeps A files, config and runtime and is retryable`, {timeout: 90000}, async t => {
    const f = await fixture(t);
    await installRevisionA(f);
    await userEdit(f);
    const before = await observe(f);
    const ownedBefore = await ownedFiles(before.state.files);
    const portB = samePort ? f.portA : f.portB;

    await writeBridge(f, 'B', modelsB);
    const failed = await install(f, portB, [{path: f.p.state, mode: 'before', skip: 0, times: 1}]);
    assert.notEqual(failed.code, 0, 'a refused journal save is a failed install');
    assert.equal(failed.timedOut, false);
    assert.doesNotMatch(failed.stdout, /"installed": true/);

    const after = await observe(f);
    assert.equal(after.configText, before.configText, 'config.toml, including the unrelated user edit, is untouched');
    assert.equal(after.configPort, f.portA);
    assert.equal(after.state.port, f.portA);
    assert.equal(after.state.pendingInstall, undefined);
    assert.deepEqual(after.state.models.map((m: any) => m.id), modelsA.map(m => m.id));
    assert.deepEqual(after.state.files, before.state.files);
    assert.deepEqual(await ownedFiles(before.state.files), ownedBefore, 'owned catalogs and agents still hold the A content');
    assert.equal((await catalogSlugs(f)).includes('claude-sdk-opus'), false);
    assert.equal(after.runtimeRevision, 'A', 'runtime A is restored');
    assert.deepEqual(after.backups, [], 'the runtime backup was consumed by the restore');
    assert.deepEqual(after.stages, []);
    assert.equal((await healthOf(f, f.portA))?.version, 'fixture-A', 'the restored A runtime is serving again');

    // An explicit retry without the fault succeeds.
    const retry = await install(f, portB);
    assert.equal(retry.code, 0, `the retry must succeed (${detail(retry)})`);
    const done = await observe(f);
    assert.equal(done.configPort, portB);
    assert.equal(done.state.port, portB);
    assert.equal(done.state.pendingInstall, undefined);
    assert.deepEqual(done.state.models.map((m: any) => m.id), modelsB.map(m => m.id));
    assert.ok((await catalogSlugs(f)).includes('claude-sdk-opus'));
    assert.equal(done.runtimeRevision, 'B');
    assert.equal((await healthOf(f, portB))?.version, 'fixture-B');
    assert.equal(done.config.apps.example.note, 'kept');
    const removed = await runSetup(f, ['uninstall']);
    assert.equal(removed.code, 0, `uninstall must succeed (${detail(removed)})`);
  });
}

// The runtime directory swap is two renames, and either may take effect and still report failure. Before config.toml is
// touched, the A runtime must always come back and keep serving; the old runtime is never restored beneath a B config
// and a B runtime is never left beneath an A config.
const runtimeRenameLosses: [string, (f: Fixture) => Rule[]][] = [
  ['the old runtime renamed to its backup', f => [{prefix: `${f.p.runtime}.backup-`, mode: 'after'}]],
  ['the staged runtime renamed into place', f => [{path: f.p.runtime, mode: 'after'}]],
];
for (const [name, rules] of runtimeRenameLosses) {
  test(`a runtime rename that applied but reported failure (${name}) keeps coherent A and is retryable`, {timeout: 90000}, async t => {
    const f = await fixture(t);
    await installRevisionA(f);
    await userEdit(f);
    const before = await observe(f);
    const ownedBefore = await ownedFiles(before.state.files);

    await writeBridge(f, 'B', modelsB);
    const failed = await install(f, f.portB, rules(f));
    assert.equal(failed.timedOut, false);
    assert.notEqual(failed.code, 0, 'a swap that reported failure is a failed install');
    assert.doesNotMatch(failed.stdout, /"installed": true/);

    const after = await observe(f);
    assert.equal(after.configText, before.configText, 'config.toml, including the unrelated user edit, is untouched');
    assert.equal(after.configPort, f.portA);
    assert.equal(after.state.port, f.portA);
    assert.equal(after.state.pendingInstall, undefined);
    assert.deepEqual(after.state.files, before.state.files);
    assert.deepEqual(await ownedFiles(before.state.files), ownedBefore, 'owned catalogs and agents still hold the A content');
    assert.equal(after.runtimeRevision, 'A', 'the A runtime is back in place');
    assert.deepEqual(after.backups, [], 'the runtime backup was consumed by the restore');
    assert.deepEqual(after.stages, []);
    await assertConsistent(f, name);
    assert.equal((await healthOf(f, f.portA))?.version, 'fixture-A', 'the restored A runtime is serving again');

    await retryRevisionB(f);
    await cleanLifecycle(f);
  });
}
