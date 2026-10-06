import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, requestSchema } from '../src/contracts.js';
import { scanClaudeSettings, verifyRuntime } from '../src/runtime-policy.js';
import { inspectSdk, sdkRunner, subscriptionEnvironment, type RuntimeOptions } from '../src/sdk.js';
import {usageStream} from './sdk-usage-fixtures.js';

// RED boundary tests for the runtime guard and the SDK runner. Everything here is temporary files, a fake CLI, a fake SDK
// query and the module-test guard injection: no account, credential, network or inference is involved.

type Models = Parameters<typeof sdkRunner>[1];
type QueryImpl = Parameters<typeof sdkRunner>[2];
type Guard = NonNullable<RuntimeOptions['guard']>;

const CLI_VERSION = '2.1.285';
const ACTUAL_MODEL = 'claude-sonnet-5-5';
const FINAL_SESSION = '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90';
const STREAM_SESSION = '9d1e6b7a-2c3f-4e58-8a01-5b4c7d9e0f12';
const TASK_SENTINEL = 'SENTINEL-TASK-5be1c7';
const TOOL_SENTINEL = 'SENTINEL-TOOL-aa40d2';
const ACCOUNT_SENTINEL = 'sentinel-account-3c9e@example.invalid';
const sonnet = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent · Sonnet', description: 'Balanced', efforts: ['medium', 'high']}] as Models;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function temp(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-boundary-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

// ---- pinned CLI fixture whose first instruction leaves a marker, so "it ran" is observable ----

async function pinnedCli(root: string) {
  const marker = path.join(root, 'cli-ran.log');
  const claudePath = path.join(root, 'claude');
  await fs.writeFile(claudePath, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(${JSON.stringify(CLI_VERSION)});
else if (args[0] === 'auth' && args[1] === 'status') console.log(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro'}));
else process.exit(64);
`, {mode: 0o755});
  const policyPath = path.join(root, 'runtime-policy.json');
  await fs.writeFile(policyPath, JSON.stringify({schema_version: 1, claude_path: claudePath,
    claude_sha256: createHash('sha256').update(await fs.readFile(claudePath)).digest('hex'), claude_version: CLI_VERSION,
    subscription_usage_credits_disabled: true, usage_credits_confirmation: {source: 'user', date: '2026-10-04'}}), {mode: 0o600});
  await fs.chmod(policyPath, 0o600);
  return {marker, claudePath, policyPath};
}
const ran = (marker: string) => fs.readFile(marker, 'utf8').then(text => text, () => null);

async function guardFixture(t: TestContext) {
  const root = await temp(t);
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'work', 'sdk-cwd');
  await fs.mkdir(cwd, {recursive: true});
  const cli = await pinnedCli(root);
  const scan = {home, managedDirs: [] as string[], managedPreferenceFiles: [] as string[], platform: 'linux' as const, env: {}};
  const verify = () => verifyRuntime({policyPath: cli.policyPath, cwd, rawEnv: {PATH: '/usr/bin'},
    childEnv: () => ({PATH: process.env.PATH ?? '/usr/bin'}), scan});
  return {root, home, cwd, scan, verify, ...cli};
}

test('route-changing settings are refused before the pinned CLI is executed at all', {timeout: 30000}, async t => {
  const cases: [string, string, string][] = [
    ['apiKeyHelper', '.claude/settings.json', JSON.stringify({apiKeyHelper: 'echo helper'})],
    ['policyHelper', '.claude/settings.json', JSON.stringify({policyHelper: '/bin/true'})],
    ['invalid JSON', '.claude/settings.local.json', '{broken'],
    ['project apiKeyHelper', 'work/.claude/settings.json', JSON.stringify({apiKeyHelper: 'echo helper'})],
  ];
  for (const [name, relative, content] of cases) {
    await t.test(name, async st => {
      const g = await guardFixture(st);
      await fs.mkdir(path.dirname(path.join(g.home, relative)), {recursive: true});
      await fs.writeFile(path.join(g.home, relative), content);
      await assert.rejects(g.verify());
      assert.equal(await ran(g.marker), null, 'not even --version or auth status may run while a helper setting is present');
    });
  }

  const clean = await guardFixture(t);
  const verified = await clean.verify();
  assert.equal(verified.claudePath, clean.claudePath);
  const log = await ran(clean.marker);
  assert.ok(log?.includes('--version') && log.includes('auth status'), 'a clean, verified runtime still runs the pinned CLI');
});

test('symlinked settings files and directories are refused even when they point at clean JSON', {timeout: 30000}, async t => {
  const symlinked: [string, string][] = [
    ['user settings file', '.claude/settings.json'],
    ['user .claude.json', '.claude.json'],
    ['project settings.local file', 'work/.claude/settings.local.json'],
  ];
  for (const [name, relative] of symlinked) {
    await t.test(name, async st => {
      const g = await guardFixture(st);
      await g.verify();
      const clean = path.join(g.root, 'clean.json');
      await fs.writeFile(clean, '{}');
      const link = path.join(g.home, relative);
      await fs.mkdir(path.dirname(link), {recursive: true});
      await fs.symlink(clean, link);
      // A symlink is neither followed nor reported clear: the scan must reject (the clean control above passed).
      await assert.rejects(scanClaudeSettings({cwd: g.cwd, ...g.scan}), (error: unknown) => error instanceof Error);
    });
  }

  await t.test('managed-settings.json symlink and managed-settings.d directory symlink', async st => {
    const root = await temp(st);
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'work', 'sdk-cwd');
    const managed = path.join(root, 'managed');
    await fs.mkdir(cwd, {recursive: true});
    await fs.mkdir(managed);
    const options = {cwd, home, managedDirs: [managed], managedPreferenceFiles: [] as string[], platform: 'linux' as const, env: {}};
    await scanClaudeSettings(options);

    const real = path.join(root, 'elsewhere');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, '10-clean.json'), '{}');
    await fs.symlink(real, path.join(managed, 'managed-settings.d'));
    // A symlinked managed-settings.d is not followed.
    await assert.rejects(scanClaudeSettings(options), (error: unknown) => error instanceof Error);
    await fs.rm(path.join(managed, 'managed-settings.d'));
    await scanClaudeSettings(options);

    await fs.writeFile(path.join(root, 'clean-managed.json'), '{}');
    await fs.symlink(path.join(root, 'clean-managed.json'), path.join(managed, 'managed-settings.json'));
    // A symlinked managed-settings.json is not followed.
    await assert.rejects(scanClaudeSettings(options), (error: unknown) => error instanceof Error);
  });
});

test('a project .claude.json in the working directory or an ancestor with apiKeyHelper is refused', {timeout: 30000}, async t => {
  for (const relative of ['work/.claude.json', 'work/sdk-cwd/.claude.json']) {
    await t.test(relative, async st => {
      const g = await guardFixture(st);
      await scanClaudeSettings({cwd: g.cwd, ...g.scan});
      await fs.writeFile(path.join(g.home, relative), JSON.stringify({apiKeyHelper: 'echo helper'}));
      await assert.rejects(scanClaudeSettings({cwd: g.cwd, ...g.scan}), /apiKeyHelper/);
    });
  }
});

// ---- fake SDK query and runner helpers ----

const modelRow = {inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0,
  costUSD: 0, contextWindow: 200000, maxOutputTokens: 64000};
const finalMessage = (over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1100, num_turns: 1, result: '',
  stop_reason: 'end_turn', total_cost_usd: 0, permission_denials: [], usage: {input_tokens: 10, output_tokens: 5},
  modelUsage: {[ACTUAL_MODEL]: modelRow}, structured_output: {text: 'fixture answer', calls: []},
  uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', session_id: FINAL_SESSION, ...over,
});

interface FakeOptions {
  final?: Record<string, unknown>;
  inferenceMs?: number;
  account?: () => Promise<Record<string, unknown>>;
  models?: () => Promise<unknown[]>;
}
const proAccount = async () => ({subscriptionType: 'pro', tokenSource: 'claude.ai', apiProvider: 'firstParty', email: ACCOUNT_SENTINEL, organization: ACCOUNT_SENTINEL});

// The prompt is only pulled when the stream is first iterated, so an untouched stream proves no prompt was released.
function fakeQuery(options: FakeOptions = {}) {
  const state = {created: 0, closed: 0, accountCalls: 0, modelCalls: 0, delivered: [] as unknown[], options: [] as any[],
    prompt: undefined as AsyncIterator<unknown> | undefined};
  const query = ((args: {prompt: AsyncIterable<unknown>; options: Record<string, any>}) => {
    state.created++; state.options.push(args.options);
    const prompt = args.prompt[Symbol.asyncIterator]();
    state.prompt = prompt;
    const stream = (async function* () {
      for (let next = await prompt.next(); !next.done; next = await prompt.next()) state.delivered.push(next.value);
      yield {type: 'system', subtype: 'init', model: ACTUAL_MODEL, session_id: STREAM_SESSION, uuid: '0b8e4d2a-7c61-4f35-9a18-d3e6c5b7a901'};
      if (options.inferenceMs) await sleep(options.inferenceMs);
      if (args.options.includePartialMessages) for (const frame of usageStream('msg_fixture',
        {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0})) yield frame;
      if (options.final) yield options.final;
    })();
    return Object.assign(stream, {
      accountInfo: async () => {state.accountCalls++; return (options.account ?? proAccount)();},
      supportedModels: async () => {state.modelCalls++; return options.models ? options.models() : [];},
      close: () => {state.closed++;},
    });
  }) as unknown as QueryImpl;
  return {query, state};
}
type Fake = ReturnType<typeof fakeQuery>;

const okGuard: Guard = async () => ({coverage: 'test_injected', claudeVersion: CLI_VERSION});
const request = () => requestSchema.parse({model: 'claude-sdk-sonnet', stream: false, reasoning: {effort: 'medium'},
  input: `Please repeat ${TASK_SENTINEL}.`,
  tools: [{type: 'function', name: 'lookup', description: `Look something up. ${TOOL_SENTINEL}`, parameters: {type: 'object', properties: {}}}]});

async function workspace(t: TestContext) {
  const root = await temp(t);
  const cwd = path.join(root, 'sdk-cwd');
  const receiptsDir = path.join(root, 'receipts');
  await fs.mkdir(cwd);
  await fs.mkdir(receiptsDir, {mode: 0o700});
  return {root, cwd, receiptsDir};
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
const run = (w: Workspace, fake: Fake, options: {guard?: Guard; signal?: AbortSignal} = {}) =>
  sdkRunner(w.cwd, sonnet, fake.query, {guard: options.guard ?? okGuard, receiptsDir: w.receiptsDir})(request(), options.signal ?? new AbortController().signal);

async function onlyReceipt(w: Workspace, forbidden: string[] = []) {
  const entries = await fs.readdir(w.receiptsDir, {recursive: true, withFileTypes: true});
  const files = entries.filter(entry => entry.isFile());
  assert.equal(files.length, 1, 'exactly one receipt per attempt');
  const file = path.join((files[0] as any).parentPath ?? (files[0] as any).path, files[0]!.name);
  const text = await fs.readFile(file, 'utf8');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'receipts are private');
  for (const secret of [TASK_SENTINEL, TOOL_SENTINEL, ACCOUNT_SENTINEL, ...forbidden]) assert.ok(!text.includes(secret), 'a receipt never holds task, tool, account or arbitrary identifier content');
  return {text, json: JSON.parse(text) as Record<string, any>};
}

test('receipt timings cover guard, account handshake and inference, and SDK timings come only from the final result', {timeout: 30000}, async t => {
  const w = await workspace(t);
  const guard: Guard = async () => {await sleep(100); return {coverage: 'test_injected', claudeVersion: CLI_VERSION};};
  const slowAccount = async () => {await sleep(100); return proAccount();};
  const fake = fakeQuery({final: finalMessage({ttft_ms: 17, ttft_stream_ms: 18, time_to_request_ms: 19}), account: slowAccount, inferenceMs: 50});
  const result = await run(w, fake, {guard});
  assert.equal(result.decision.text, 'fixture answer');

  const {json} = await onlyReceipt(w);
  assert.equal(json.status, 'complete');
  assert.equal(json.inference_stage, 'final_received');
  assert.ok(json.wall_ms >= 240 && json.wall_ms < 5000, `wall_ms covers every delay (${json.wall_ms})`);
  assert.ok(json.preflight_ms >= 190 && json.preflight_ms <= json.wall_ms, `preflight_ms covers guard and account (${json.preflight_ms})`);
  assert.ok(json.query_ms >= 45 && json.query_ms <= json.wall_ms, `query_ms covers inference (${json.query_ms})`);
  assert.ok(json.preflight_ms + json.query_ms <= json.wall_ms + 25, 'the two phases do not exceed the whole');
  assert.ok(Date.parse(json.ended_at) - Date.parse(json.started_at) >= 200, 'started_at is before the preflight');
  assert.deepEqual(json.actual_models, [ACTUAL_MODEL]);
  assert.equal(json.sdk_session_id, FINAL_SESSION);
  assert.equal(json.sdk_ttft_ms, 17);
  assert.equal(json.sdk_ttft_stream_ms, 18);
  assert.equal(json.sdk_time_to_request_ms, 19);
  assert.equal(json.usage.total_tokens, 15);
  const keys = Object.keys(json).join(' ');
  assert.doesNotMatch(keys, /cost|usd|price|billing|amount/i, 'no billing amount is claimed');
  assert.doesNotMatch(keys, /gui|desktop/i, 'SDK timings are not presented as GUI timings');
});

test('optional SDK scalar timings that are absent, negative or not numbers stay null', {timeout: 30000}, async t => {
  const cases: [string, Record<string, unknown>][] = [
    ['absent', {}],
    ['negative, string and non-finite', {ttft_ms: -1, ttft_stream_ms: '18', time_to_request_ms: Number.POSITIVE_INFINITY}],
  ];
  for (const [name, over] of cases) {
    await t.test(name, async st => {
      const w = await workspace(st);
      await run(w, fakeQuery({final: finalMessage(over)}));
      const {json} = await onlyReceipt(w);
      for (const key of ['sdk_ttft_ms', 'sdk_ttft_stream_ms', 'sdk_time_to_request_ms']) assert.equal(json[key], null, key);
    });
  }
});

test('a guard rejection leaves one blocked receipt that never started inference', {timeout: 20000}, async t => {
  const w = await workspace(t);
  const fake = fakeQuery({final: finalMessage()});
  const guard: Guard = async () => {throw new BridgeError(503, 'runtime_blocked', 'Policy says no.');};
  await assert.rejects(run(w, fake, {guard}), (error: any) => error.code === 'runtime_blocked');
  assert.equal(fake.state.created, 0);
  const {json} = await onlyReceipt(w);
  assert.equal(json.status, 'blocked');
  assert.equal(json.inference_stage, 'not_started');
  assert.equal(json.code, 'runtime_blocked');
  assert.deepEqual(json.actual_models, []);
  assert.equal(json.sdk_session_id, null);
  assert.equal(json.usage, null);
  assert.equal(json.preflight_ms, null, 'the prompt was never released');
  assert.equal(json.query_ms, null);
});

test('cancelling while the guard is still running aborts the attempt without creating a query', {timeout: 20000}, async t => {
  const w = await workspace(t);
  const fake = fakeQuery({final: finalMessage()});
  const controller = new AbortController();
  const stuck: Guard = () => new Promise(() => {});
  const running = run(w, fake, {guard: stuck, signal: controller.signal}).then(() => 'resolved', () => 'rejected');
  await sleep(20);
  controller.abort();
  assert.equal(await running, 'rejected');
  assert.equal(fake.state.created, 0);
  const {json} = await onlyReceipt(w);
  assert.equal(json.status, 'aborted');
  assert.equal(json.inference_stage, 'not_started');
  assert.equal(json.sdk_session_id, null);
  assert.equal(json.query_ms, null);
});

test('an account that is not a first-party Pro or Max login fails before the prompt is released and is closed once', {timeout: 30000}, async t => {
  const accounts: [string, Record<string, unknown>][] = [
    ['first-party account with an unknown plan', {apiProvider: 'firstParty', subscriptionType: 'team', email: ACCOUNT_SENTINEL}],
    ['another provider', {apiProvider: 'bedrock', subscriptionType: 'pro', email: ACCOUNT_SENTINEL}],
    ['no plan at all', {apiProvider: 'firstParty', email: ACCOUNT_SENTINEL}],
  ];
  for (const [name, account] of accounts) {
    await t.test(name, async st => {
      const w = await workspace(st);
      const fake = fakeQuery({final: finalMessage(), account: async () => account});
      await assert.rejects(run(w, fake), (error: any) => error.code === 'subscription_required');
      assert.equal(fake.state.created, 1);
      assert.equal(fake.state.closed, 1);
      const next = await Promise.race([fake.state.prompt!.next(), sleep(1000).then(() => 'hung' as const)]);
      assert.notEqual(next, 'hung', 'the prompt channel is released');
      assert.equal((next as IteratorResult<unknown>).done, true, 'no prompt was ever released to the SDK');
      const {json} = await onlyReceipt(w);
      assert.equal(json.status, 'blocked');
      assert.equal(json.inference_stage, 'not_started');
      assert.deepEqual(json.actual_models, []);
      assert.equal(json.sdk_session_id, null);
      assert.equal(json.usage, null);
      assert.equal(json.query_ms, null);
    });
  }
});

test('inspectSdk validates the account before it asks for models', {timeout: 20000}, async t => {
  const invalid = fakeQuery({account: async () => ({apiProvider: 'firstParty', subscriptionType: 'team'}), models: async () => []});
  const outcome = await inspectSdk(path.join(os.tmpdir(), 'unused'), {guard: okGuard}, invalid.query).then(value => ({value}), error => ({error}));
  if ('value' in outcome) assert.equal(outcome.value.authenticated, false);
  assert.equal(invalid.state.modelCalls, 0, 'supportedModels is never called for an invalid account');
  assert.equal(invalid.state.closed, 1);

  const valid = fakeQuery({account: proAccount, models: async () => [{value: 'sonnet', displayName: 'Sonnet', description: 'Balanced', supportedEffortLevels: ['medium']}]});
  const inspected = await inspectSdk(path.join(os.tmpdir(), 'unused'), {guard: okGuard}, valid.query);
  assert.equal(inspected.authenticated, true);
  assert.deepEqual(inspected.models.map(model => model.id), ['claude-sdk-sonnet']);
  assert.equal(valid.state.closed, 1);
});

test('inspectSdk has an effective deadline even when the SDK never answers', {timeout: 30000}, async t => {
  const hung: [string, FakeOptions][] = [
    ['accountInfo never settles', {account: () => new Promise(() => {})}],
    ['supportedModels never settles', {account: proAccount, models: () => new Promise(() => {})}],
  ];
  for (const [name, options] of hung) {
    await t.test(name, async st => {
      st.mock.timers.enable({apis: ['setTimeout']});
      const fake = fakeQuery(options);
      const outcome: {settled?: {error?: unknown; value?: unknown}} = {};
      void inspectSdk(path.join(os.tmpdir(), 'unused'), {guard: okGuard}, fake.query).then(value => {outcome.settled = {value};}, error => {outcome.settled = {error};});
      await flush();
      st.mock.timers.tick(30000);
      for (let attempt = 0; attempt < 50 && !outcome.settled; attempt++) await flush();
      assert.ok(outcome.settled, 'the 30 s deadline must settle the call');
      assert.ok('error' in outcome.settled, 'a deadline is a rejection, not a result');
      assert.equal(fake.state.closed, 1, 'the SDK query is closed exactly once');
    });
  }
});

test('final metadata that is not a UUID session or a Claude model ID is never saved or accepted as proof', {timeout: 40000}, async t => {
  const REDACTED = '[REDACTED]';
  const OPAQUE = 'opaque-secret-token-123';
  const cases: [string, Record<string, unknown>, {status: string; models: string[]; session: string | null; forbidden: string[]}][] = [
    ['opaque alphanumeric session', {session_id: OPAQUE}, {status: 'incomplete', models: [ACTUAL_MODEL], session: null, forbidden: [OPAQUE]}],
    ['redacted placeholder as the only model', {modelUsage: {[REDACTED]: modelRow}},
      {status: 'incomplete', models: [], session: FINAL_SESSION, forbidden: [REDACTED, ACTUAL_MODEL]}],
    ['bare alias as the only model', {modelUsage: {sonnet: modelRow}}, {status: 'incomplete', models: [], session: FINAL_SESSION, forbidden: [ACTUAL_MODEL]}],
    ['innocuous identifier that is not a Claude model ID', {modelUsage: {'not-a-claude-model-id': modelRow}},
      {status: 'incomplete', models: [], session: FINAL_SESSION, forbidden: ['not-a-claude-model-id', ACTUAL_MODEL]}],
    ['Claude model with a context suffix beside a placeholder', {modelUsage: {'claude-sonnet-5-5[1m]': modelRow, [REDACTED]: modelRow}},
      {status: 'complete', models: ['claude-sonnet-5-5[1m]'], session: FINAL_SESSION, forbidden: [REDACTED]}],
  ];
  for (const [name, over, expected] of cases) {
    await t.test(name, async st => {
      const w = await workspace(st);
      const fake = fakeQuery({final: finalMessage(over)});
      const outcome = await run(w, fake).then(() => 'resolved', () => 'rejected');
      assert.equal(outcome, expected.status === 'complete' ? 'resolved' : 'rejected', 'success is withheld unless the final result proves model and session');
      assert.equal(fake.state.closed, 1);
      const {json, text} = await onlyReceipt(w, expected.forbidden);
      assert.equal(json.status, expected.status);
      assert.deepEqual(json.actual_models, expected.models);
      assert.equal(json.sdk_session_id, expected.session);
      assert.ok(!text.includes(STREAM_SESSION), 'a streamed init session is never promoted to proof');
    });
  }
});

test('the scoped child environment pins the runtime without touching the parent environment', async t => {
  const source = {PATH: '/usr/bin', DISABLE_AUTOUPDATER: '0', DISABLE_UPDATES: '0', FORCE_AUTOUPDATE_PLUGINS: '1', KEEP_ME: 'yes'};
  const snapshot = {...source};
  const env = subscriptionEnvironment(source);
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.DISABLE_UPDATES, '1');
  assert.equal('FORCE_AUTOUPDATE_PLUGINS' in env, false);
  assert.equal(env.KEEP_ME, 'yes');
  assert.deepEqual(source, snapshot, 'the raw parent environment is left unchanged');

  const before = JSON.stringify(process.env);
  subscriptionEnvironment();
  assert.equal(JSON.stringify(process.env), before, 'process.env is never mutated');

  const w = await workspace(t);
  const fake = fakeQuery({final: finalMessage()});
  await run(w, fake);
  const sent = fake.state.options[0].env;
  assert.equal(sent.DISABLE_AUTOUPDATER, '1');
  assert.equal(sent.DISABLE_UPDATES, '1');
  assert.equal('FORCE_AUTOUPDATE_PLUGINS' in sent, false);
});
