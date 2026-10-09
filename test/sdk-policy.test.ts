import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdkRunner } from '../src/sdk.js';
import { BridgeError, requestSchema, type RunStep } from '../src/contracts.js';
import {usageStream} from './sdk-usage-fixtures.js';

// RED tests for the runtime policy and receipt behaviour the SDK runner must gain. The fourth argument below is the
// private interface the implementation will supply; the current sdkRunner ignores it, so these fail on behaviour.
type Models = Parameters<typeof sdkRunner>[1];
type QueryImpl = Parameters<typeof sdkRunner>[2];
const policyRunner = sdkRunner as unknown as (cwd: string, models: Models, queryImpl: QueryImpl,
  options: {runtimePolicyPath: string; receiptsDir: string}) => RunStep;

const CLI_VERSION = '2.1.285';
const ACTUAL_MODEL = 'claude-sonnet-5-5';
const FINAL_SESSION = '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90';
const STREAM_SESSION = '9d1e6b7a-2c3f-4e58-8a01-5b4c7d9e0f12';
const SENTINEL_INPUT = 'SENTINEL-INPUT-7f3a21';
const SENTINEL_TOOL = 'SENTINEL-TOOL-SECRET-91c2b4';
const AUTH_SECRET = 'sentinel-account@example.invalid';
const sonnet = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', displayName: 'Claude Agent · Sonnet', description: 'Balanced', efforts: ['medium', 'high']}] as Models;

const request = (effort = 'medium') => requestSchema.parse({
  model: 'claude-sdk-sonnet', stream: false, reasoning: {effort},
  input: `Please repeat ${SENTINEL_INPUT}.`,
  tools: [{type: 'function', name: 'lookup', description: `Look something up. ${SENTINEL_TOOL}`,
    parameters: {type: 'object', properties: {}, additionalProperties: false}}],
});

const finalMessage = (over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1100, num_turns: 1,
  result: '', stop_reason: 'end_turn', total_cost_usd: 0, permission_denials: [],
  usage: {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
  modelUsage: {[ACTUAL_MODEL]: {inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 64000}},
  structured_output: {text: 'fixture answer', calls: []},
  uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', session_id: FINAL_SESSION, ...over,
});

// Fake SDK query. The prompt is only consumed when the stream is first pulled, and the stream only produces the init
// message and the final result after that prompt iterator has finished, like the real streaming-input mode.
function fakeSdk(behavior: {final: Record<string, unknown> | 'none' | 'hang'}) {
  const state = {created: 0, closed: 0, delivered: [] as any[], options: [] as any[]};
  let markInit!: () => void;
  const initSeen = new Promise<void>(resolve => {markInit = resolve;});
  const query = ((args: {prompt: AsyncIterable<unknown>; options: Record<string, any>}) => {
    state.created++; state.options.push(args.options);
    let wake!: () => void;
    const closed = new Promise<void>(resolve => {wake = resolve;});
    const stream = (async function* () {
      for await (const message of args.prompt) state.delivered.push(message);
      yield {type: 'system', subtype: 'init', apiKeySource: 'none', cwd: args.options.cwd, tools: [], mcp_servers: [],
        model: 'sonnet', permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [],
        claude_code_version: CLI_VERSION, uuid: '0b8e4d2a-7c61-4f35-9a18-d3e6c5b7a901', session_id: STREAM_SESSION};
      markInit();
      if (behavior.final === 'none') return;
      if (behavior.final === 'hang') {
        const signal = args.options.abortController?.signal as AbortSignal | undefined;
        const outcome = await new Promise<'aborted' | 'closed'>(resolve => {
          if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', () => resolve('aborted'), {once: true});
          void closed.then(() => resolve('closed'));
        });
        if (outcome === 'aborted') throw Object.assign(new Error('The operation was aborted'), {name: 'AbortError'});
        return;
      }
      if (args.options.includePartialMessages) for (const frame of usageStream('msg_fixture',
        {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0})) yield frame;
      yield behavior.final;
    })();
    return Object.assign(stream, {
      accountInfo: async () => ({subscriptionType: 'pro', tokenSource: 'claude.ai', apiProvider: 'firstParty'}),
      close: () => {state.closed++; wake();},
    });
  }) as unknown as QueryImpl;
  return {query, state, initSeen};
}

// Only this one variable is ever touched, and it is put back exactly as it was.
function setRouteOverride(t: TestContext, value?: string) {
  const saved = process.env.ANTHROPIC_BASE_URL;
  if (value === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = value;
  t.after(() => {if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved;});
}

interface FixtureOptions {
  version?: string; auth?: Record<string, unknown>; policy?: Record<string, unknown>; policyFile?: boolean; routeOverride?: string;
}
// An executable Node script stands in for the official CLI: it only answers --version and `auth status`.
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  setRouteOverride(t, options.routeOverride);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-policy-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const auth = options.auth ?? {loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: AUTH_SECRET};
  const claudePath = path.join(root, 'claude');
  await fs.writeFile(claudePath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(${JSON.stringify(options.version ?? CLI_VERSION)});
else if (args[0] === 'auth' && args[1] === 'status') console.log(${JSON.stringify(JSON.stringify(auth))});
else process.exit(64);
`, {mode: 0o755});
  const runtimePolicyPath = path.join(root, 'runtime-policy.json');
  if (options.policyFile !== false) {
    await fs.writeFile(runtimePolicyPath, JSON.stringify({
      schema_version: 1, claude_path: claudePath, claude_sha256: createHash('sha256').update(await fs.readFile(claudePath)).digest('hex'),
      claude_version: CLI_VERSION, subscription_usage_credits_disabled: true,
      usage_credits_confirmation: {source: 'user', date: '2026-10-04'}, ...options.policy,
    }), {mode: 0o600});
    await fs.chmod(runtimePolicyPath, 0o600);
  }
  const receiptsDir = path.join(root, 'receipts');
  await fs.mkdir(receiptsDir, {mode: 0o700});
  const cwd = path.join(root, 'sdk-cwd');
  await fs.mkdir(cwd);
  return {root, claudePath, runtimePolicyPath, receiptsDir, cwd};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Sdk = ReturnType<typeof fakeSdk>;

const run = (f: Fixture, sdk: Sdk, signal = new AbortController().signal, effort?: string) =>
  policyRunner(f.cwd, sonnet, sdk.query, {runtimePolicyPath: f.runtimePolicyPath, receiptsDir: f.receiptsDir})(request(effort), signal);

async function readReceipts(dir: string) {
  const found = [];
  for (const entry of await fs.readdir(dir, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const file = path.join((entry as any).parentPath ?? (entry as any).path, entry.name);
    const text = await fs.readFile(file, 'utf8');
    found.push({file, text, mode: (await fs.stat(file)).mode & 0o777, json: JSON.parse(text) as Record<string, any>});
  }
  return found;
}
async function onlyReceipt(f: Fixture) {
  const found = await readReceipts(f.receiptsDir);
  assert.equal(found.length, 1, 'exactly one receipt per run');
  const receipt = found[0]!;
  assert.equal(receipt.mode, 0o600, 'receipts are private to the user');
  for (const secret of [SENTINEL_INPUT, SENTINEL_TOOL, AUTH_SECRET]) assert.ok(!receipt.text.includes(secret), 'receipts never hold prompt, tool or account content');
  return receipt;
}
const timingEntries = (text: string) => [...text.matchAll(/"([^"]*(?:time|At|_at|_ms|duration|elapsed|started|finished|ended)[^"]*)"\s*:\s*("[^"]+"|\d+(?:\.\d+)?)/gi)];

async function assertBlocked(f: Fixture, sdk: Sdk) {
  await assert.rejects(run(f, sdk));
  assert.equal(sdk.state.created, 0, 'no SDK query may be created');
  assert.deepEqual(sdk.state.delivered, [], 'no prompt may be delivered');
}

test('a missing, unpinned or unconfirmed runtime is blocked before any SDK query or prompt delivery', {timeout: 60000}, async t => {
  const cases: [string, FixtureOptions][] = [
    ['policy file is missing', {policyFile: false}],
    ['CLI SHA-256 differs from the policy', {policy: {claude_sha256: '0'.repeat(64)}}],
    ['CLI version differs from the policy', {policy: {claude_version: '2.1.284'}}],
    ['extra usage is not recorded as disabled', {policy: {subscription_usage_credits_disabled: false}}],
    ['extra usage has no user confirmation', {policy: {usage_credits_confirmation: undefined}}],
    ['CLI reports an API-key login', {auth: {loggedIn: true, authMethod: 'api_key'}}],
    ['CLI reports it is logged out', {auth: {loggedIn: false}}],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async st => {
      const sdk = fakeSdk({final: finalMessage()});
      await assertBlocked(await fixture(st, options), sdk);
    });
  }
});

test('a route override in the environment is rejected before the SDK is created and is left untouched', {timeout: 20000}, async t => {
  const override = 'http://127.0.0.1:9';
  const f = await fixture(t, {routeOverride: override});
  const sdk = fakeSdk({final: finalMessage()});
  await assertBlocked(f, sdk);
  assert.equal(process.env.ANTHROPIC_BASE_URL, override, 'the check must not silently clean the variable');
});

test('a successful run uses the pinned executable and explicit medium effort and stores a private receipt', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const sdk = fakeSdk({final: finalMessage()});
  const result = await run(f, sdk);

  assert.equal(result.decision.text, 'fixture answer');
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(sdk.state.created, 1);
  assert.equal(sdk.state.delivered.length, 1);
  assert.ok(JSON.stringify(sdk.state.delivered[0]).includes(SENTINEL_INPUT), 'the prompt reaches the SDK');
  assert.equal(sdk.state.closed, 1, 'the SDK query is closed exactly once');
  assert.equal(sdk.state.options[0].pathToClaudeCodeExecutable, f.claudePath);
  assert.equal(sdk.state.options[0].effort, 'medium');
  assert.deepEqual(sdk.state.options[0].settingSources, []);
  assert.equal(sdk.state.options[0].persistSession, false);
  assert.equal(sdk.state.options[0].env.DISABLE_AUTOUPDATER, '1');
  assert.match(String(sdk.state.options[0].systemPrompt), /Native provider mode[\s\S]*legacy Claude Bridge/, 'the native provider instruction is trusted system text');

  const receipt = await onlyReceipt(f);
  assert.equal(receipt.json.status, 'complete');
  assert.ok(receipt.text.includes(ACTUAL_MODEL), 'the actual model comes from the final modelUsage');
  assert.ok(receipt.text.includes(FINAL_SESSION), 'the session comes from the final result');
  assert.deepEqual(receipt.json.actual_models, [ACTUAL_MODEL]);
  assert.equal(receipt.json.sdk_session_id, FINAL_SESSION);
  assert.equal(receipt.json.requested_alias, 'sonnet');
  assert.equal(receipt.json.permission_denials_status, 'none');
  assert.equal(receipt.json.usage.total_tokens, 15);
  assert.match(receipt.json.run_id, /^[0-9a-f-]{36}$/);
  assert.ok(timingEntries(receipt.text).length >= 1, 'timings are recorded');
});

test('an error final result never becomes a success and leaves a failed receipt with the final model and session', {timeout: 30000}, async t => {
  const failures: [string, Record<string, unknown>][] = [
    ['error subtype', {subtype: 'error_during_execution', is_error: true, errors: ['boom'], structured_output: undefined}],
    ['success subtype flagged as an error', {subtype: 'success', is_error: true}],
  ];
  for (const [name, over] of failures) {
    await t.test(name, async st => {
      const f = await fixture(st);
      const sdk = fakeSdk({final: finalMessage(over)});
      await assert.rejects(run(f, sdk), /did not complete successfully/);
      assert.equal(sdk.state.closed, 1);
      const receipt = await onlyReceipt(f);
      assert.equal(receipt.json.status, 'failed');
      assert.ok(receipt.text.includes(ACTUAL_MODEL));
      assert.ok(receipt.text.includes(FINAL_SESSION));
    });
  }
});

test('a stream that ends without a final result stays unknown and invents no model or session', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const sdk = fakeSdk({final: 'none'});
  await assert.rejects(run(f, sdk));
  assert.equal(sdk.state.delivered.length, 1, 'the prompt was delivered before the stream ended');
  assert.equal(sdk.state.closed, 1);
  const receipt = await onlyReceipt(f);
  assert.match(String(receipt.json.status), /^(unknown|incomplete)$/);
  assert.ok(!receipt.text.includes(STREAM_SESSION), 'a session seen only in the init message is not the actual session');
  assert.ok(!receipt.text.includes(ACTUAL_MODEL));
});

test('cancelling a running query closes the SDK and records an unfinished receipt without the streamed session', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const sdk = fakeSdk({final: 'hang'});
  const controller = new AbortController();
  const running = run(f, sdk, controller.signal);
  const outcome = running.then(() => 'resolved', () => 'rejected');
  await sdk.initSeen;
  controller.abort();
  assert.equal(await outcome, 'rejected');
  assert.equal(sdk.state.closed, 1, 'the SDK query is closed exactly once after cancellation');
  const receipt = await onlyReceipt(f);
  assert.match(String(receipt.json.status), /^(aborted|unknown|incomplete)$/);
  assert.equal(receipt.json.sdk_session_id, null);
  assert.deepEqual(receipt.json.actual_models, []);
  assert.ok(!receipt.text.includes(STREAM_SESSION), 'a session seen only in the init message is not the actual session');
});

test('a router timeout is recorded as a timeout with the last SDK event, not as a user cancel', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const sdk = fakeSdk({final: 'hang'});
  const controller = new AbortController();
  const running = run(f, sdk, controller.signal).then(() => 'resolved', () => 'rejected');
  await sdk.initSeen;
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort(new BridgeError(504, 'timeout', 'Claude step timed out: no model activity for 300 s.', {limit: 'stall'}));
  assert.equal(await running, 'rejected');
  const receipt = await onlyReceipt(f);
  assert.equal(receipt.json.code, 'timeout_stall');
  assert.notEqual(receipt.json.status, 'complete');
  assert.equal(receipt.json.last_event, 'system');
  assert.ok(Number.isInteger(receipt.json.last_event_age_ms) && receipt.json.last_event_age_ms >= 0);
});

test('a success result without verifiable model, session or usage is never recorded as complete', {timeout: 40000}, async t => {
  const cases: [string, Record<string, unknown>, string | null][] = [
    ['no model usage', {modelUsage: undefined}, FINAL_SESSION],
    ['non-numeric token counts', {modelUsage: {[ACTUAL_MODEL]: {inputTokens: 'many'}}}, FINAL_SESSION],
    ['no session id', {session_id: undefined}, null],
    ['unsafe session id', {session_id: 'not a safe id\nwith control characters'}, null],
  ];
  for (const [name, over, session] of cases) {
    await t.test(name, async st => {
      const f = await fixture(st);
      const sdk = fakeSdk({final: finalMessage(over)});
      await assert.rejects(run(f, sdk), /no verifiable model, session or usage/);
      assert.equal(sdk.state.closed, 1);
      const receipt = await onlyReceipt(f);
      assert.notEqual(receipt.json.status, 'complete');
      assert.equal(receipt.json.status, 'incomplete');
      assert.equal(receipt.json.sdk_session_id, session);
      assert.ok(!receipt.text.includes('not a safe id'));
    });
  }
});

test('SDK permission denials cannot masquerade as a complete answer and are recorded separately', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const denial = {tool_name: 'Bash', tool_use_id: 'toolu_fixture', tool_input: {command: SENTINEL_TOOL}};
  const sdk = fakeSdk({final: finalMessage({permission_denials: [denial]})});
  await assert.rejects(run(f, sdk), /denied/);
  assert.equal(sdk.state.closed, 1);
  const receipt = await onlyReceipt(f);
  assert.equal(receipt.json.status, 'failed');
  assert.equal(receipt.json.permission_denials_status, 'present');
  assert.equal(receipt.json.permission_denials_count, 1);
});

test('an unsupported requested effort is an error, while none means no override', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const refused = fakeSdk({final: finalMessage()});
  await assert.rejects(run(f, refused, undefined, 'xhigh'), /does not support reasoning effort/);
  assert.equal(refused.state.created, 0);
  assert.deepEqual(await readReceipts(f.receiptsDir), [], 'a request that never reached inference leaves no receipt');

  const unset = fakeSdk({final: finalMessage()});
  await run(f, unset, undefined, 'none');
  assert.equal(unset.state.options[0].effort, undefined);
  const receipt = await onlyReceipt(f);
  assert.equal(receipt.json.requested_effort, null);
  assert.equal(receipt.json.effective_effort, 'unknown');
});

test('a request cancelled before the guard finishes never creates a query and leaves one aborted receipt', {timeout: 20000}, async t => {
  const f = await fixture(t);
  const sdk = fakeSdk({final: finalMessage()});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(f, sdk, controller.signal));
  assert.equal(sdk.state.created, 0);
  // The model step was accepted, so the attempt is evidenced even though no prompt was ever released.
  const receipt = await onlyReceipt(f);
  assert.equal(receipt.json.status, 'aborted');
  assert.equal(receipt.json.inference_stage, 'not_started');
  assert.deepEqual(receipt.json.actual_models, []);
  assert.equal(receipt.json.sdk_session_id, null);
});

test('a receipt that cannot be written surfaces the evidence failure and keeps the inference status', {timeout: 30000}, async t => {
  const f = await fixture(t);
  // A path below a regular file can never become a directory.
  const receiptsDir = path.join(f.claudePath, 'receipts');
  const runner = (sdk: Sdk) => policyRunner(f.cwd, sonnet, sdk.query, {runtimePolicyPath: f.runtimePolicyPath, receiptsDir})(request(), new AbortController().signal);

  const complete = fakeSdk({final: finalMessage()});
  await assert.rejects(runner(complete), /inference status: complete[\s\S]*evidence receipt could not be written/);
  assert.equal(complete.state.closed, 1);

  const failed = fakeSdk({final: finalMessage({subtype: 'error_during_execution', is_error: true})});
  await assert.rejects(runner(failed), /did not complete successfully[\s\S]*evidence receipt could not be written either/);
});
