import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sdk from '../src/sdk.js';
import {accountFingerprint, SubscriptionQuotaError} from '../src/subscription-limits.js';
import {BridgeError, requestSchema} from '../src/contracts.js';
import {usageStream, USAGE_MODEL, USAGE_SESSION, type Frame} from './sdk-usage-fixtures.js';

const models = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: USAGE_MODEL,
  displayName: 'Fixture', description: '', efforts: ['medium']}];
const identity = {apiProvider: 'firstParty', subscriptionType: 'pro', email: 'quota@example.invalid', organization: 'org-fixture'};
const usage = {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5};
const finalResult = (over: Frame = {}): Frame => ({type: 'result', subtype: 'success', is_error: false,
  duration_ms: 100, duration_api_ms: 90, num_turns: 1, result: '', stop_reason: 'end_turn', total_cost_usd: 0,
  permission_denials: [], usage, modelUsage: {[USAGE_MODEL]: {inputTokens: 10, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, outputTokens: 5, webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 128000}},
  structured_output: {text: 'fixture answer', calls: []}, session_id: USAGE_SESSION,
  uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', ...over});
const failed = () => finalResult({subtype: 'error_during_execution', is_error: true, structured_output: undefined, errors: ['quota exhausted']});
const rateLimit = (info: Frame = {}, session = USAGE_SESSION): Frame => ({type: 'rate_limit_event', session_id: session,
  uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', rate_limit_info: {status: 'rejected', rateLimitType: 'five_hour', ...info}});
const assistantError = (error = 'rate_limit'): Frame => ({type: 'assistant', error, session_id: USAGE_SESSION,
  parent_tool_use_id: null, message: {role: 'assistant', content: []}});

async function fixture(t: TestContext, frames: Frame[], final: Frame | undefined = failed(), account: Frame = identity) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-quota-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const state = {created: 0, closed: 0, delivered: 0, supportedModels: 0, accountCalls: 0};
  const query = ((args: any) => {
    state.created++;
    return Object.assign((async function* () {
      for await (const _ of args.prompt) state.delivered++;
      for (const frame of frames) yield frame;
      if (final) yield final;
    })(), {accountInfo: async () => {state.accountCalls++; return account;},
      supportedModels: async () => {state.supportedModels++; return [];}, close() {state.closed++;}});
  }) as unknown as Parameters<typeof sdk.sdkRunner>[2];
  const runtime = {receiptsDir: root, guard: async () => ({coverage: 'test_injected', claudePath: '/fixture/pinned-claude'})};
  const run = sdk.sdkRunner(root, models, query, runtime);
  return {root, query, runtime, state,
    run: () => run(requestSchema.parse({model: 'claude-sdk-sonnet', input: 'fixture'}), new AbortController().signal),
    receipts: async () => Promise.all((await fs.readdir(root)).filter(f => f.endsWith('.json')).map(f => fs.readFile(path.join(root, f), 'utf8')))};
}

test('structured rejection plus failed final becomes a non-retry quota error with account identity and reset milliseconds', async t => {
  const resetSeconds = Math.floor(Date.now() / 1000) + 600;
  const f = await fixture(t, [rateLimit({resetsAt: resetSeconds}), assistantError()]);
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof SubscriptionQuotaError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'subscription_quota');
    assert.equal(error.accountId, accountFingerprint(identity));
    assert.deepEqual(error.windows, [{type: 'five_hour', resetsAt: resetSeconds * 1000}]);
    return true;
  });
  assert.equal(f.state.created, 1);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(JSON.parse(receipts[0]!).code, 'subscription_quota');
  assert.ok(!receipts[0]!.includes(identity.email));
  assert.ok(!receipts[0]!.includes(identity.organization));
});

test('warnings and earlier rejection do not change a successful final or its receipt', async t => {
  for (const status of ['allowed_warning', 'rejected']) await t.test(status, async st => {
    const f = await fixture(st, [rateLimit({status}), assistantError(), ...usageStream('msg_quota_recovered', usage)], finalResult());
    assert.equal((await f.run()).decision.text, 'fixture answer');
    assert.equal(JSON.parse((await f.receipts())[0]!).code, 'success');
  });
});

test('warnings, prose, stale-session events, incomplete streams and unrelated terminal failures never become quota errors', async t => {
  const cases: [string, Frame[], Frame | undefined][] = [
    ['warning', [rateLimit({status: 'allowed_warning'})], failed()],
    ['error prose only', [], failed()],
    ['another session', [rateLimit({}, 'another-session')], failed()],
    ['later auth error', [rateLimit(), assistantError('authentication_failed')], failed()],
    ['max turns', [rateLimit()], finalResult({subtype: 'error_max_turns', is_error: true})],
    ['structured output retry limit', [rateLimit()], finalResult({subtype: 'error_max_structured_output_retries', is_error: true})],
    ['rejection recovered before failure', [rateLimit(), rateLimit({status: 'allowed'})], failed()],
  ];
  for (const [name, frames, final] of cases) await t.test(name, async st => {
    const f = await fixture(st, frames, final);
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'claude_failed');
  });
  const f = await fixture(t, [rateLimit()], undefined);
  // Set an actually absent result, independently of the fixture's default argument.
  const noFinal = ((args: any) => Object.assign((async function* () {
    for await (const _ of args.prompt) { /* gated prompt */ }
    yield rateLimit();
  })(), {accountInfo: async () => identity, close() {}})) as unknown as Parameters<typeof sdk.sdkRunner>[2];
  await assert.rejects(sdk.sdkRunner(f.root, models, noFinal, f.runtime)(requestSchema.parse({model: models[0]!.id, input: 'fixture'}),
    new AbortController().signal), (error: unknown) => error instanceof BridgeError && error.code === 'incomplete_sdk');
});

test('assistant rate_limit without reset scope is quota evidence but carries no invented quota window', async t => {
  const f = await fixture(t, [assistantError()]);
  await assert.rejects(f.run(), (error: unknown) => error instanceof SubscriptionQuotaError && error.windows.length === 0);
});

test('missing account identity keeps a terminal failure in the subscription path', async t => {
  for (const account of [{apiProvider: 'firstParty', subscriptionType: 'pro'}, {...identity, organization: undefined}, {...identity, email: ''}]) {
    const f = await fixture(t, [rateLimit(), assistantError()], failed(), account);
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'subscription_account_unverified');
  }
});

test('live overage indication stops the stream immediately with a non-retry policy error', async t => {
  for (const flag of ['isUsingOverage', 'overageInUse']) await t.test(flag, async st => {
    const f = await fixture(st, [rateLimit({status: 'allowed', [flag]: true}), ...usageStream('msg_extra_usage', usage)], finalResult());
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.status === 403 && error.code === 'subscription_overage');
    assert.equal(f.state.created, 1);
    assert.equal(f.state.closed, 1);
  });
});

test('account inspection validates runtime and subscription without prompt delivery or model discovery', async t => {
  const f = await fixture(t, []);
  let guarded = 0;
  const id = await sdk.inspectSubscriptionAccount(f.root, {...f.runtime, guard: async () => {guarded++; return {coverage: 'test_injected', claudePath: '/fixture/pinned-claude'};}}, f.query);
  assert.ok(id);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(guarded, 1);
  assert.equal(f.state.accountCalls, 1);
  assert.equal(f.state.delivered, 0);
  assert.equal(f.state.supportedModels, 0);
  assert.equal(f.state.closed, 1);
});

test('account inspection fails closed on runtime guard, login and caller cancellation', async t => {
  const f = await fixture(t, []);
  await assert.rejects(sdk.inspectSubscriptionAccount(f.root, {guard: async () => {throw new BridgeError(403, 'guard_blocked', 'blocked');}}, f.query),
    (error: unknown) => error instanceof BridgeError && error.code === 'guard_blocked');
  assert.equal(f.state.created, 0);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(sdk.inspectSubscriptionAccount(f.root, f.runtime, f.query, cancelled.signal),
    (error: unknown) => error instanceof BridgeError && error.code === 'aborted');
  assert.equal(f.state.created, 0);
  const signedOut = await fixture(t, [], failed(), {apiProvider: 'firstParty'});
  await assert.rejects(sdk.inspectSubscriptionAccount(signedOut.root, signedOut.runtime, signedOut.query),
    (error: unknown) => error instanceof BridgeError && error.code === 'subscription_required');
  assert.equal(signedOut.state.delivered, 0);
  assert.equal(signedOut.state.closed, 1);
  const unknown = await fixture(t, [], failed(), {apiProvider: 'firstParty', subscriptionType: 'pro'});
  assert.equal(await sdk.inspectSubscriptionAccount(unknown.root, unknown.runtime, unknown.query), null);
});

test('renaming Max to Ultra preserves the account binding used by API fallback', async t => {
  const max = await fixture(t, [], undefined, {...identity, subscriptionType: 'Claude Max'});
  const ultra = await fixture(t, [], undefined, {...identity, subscriptionType: 'Claude Ultra'});
  const previousId = await sdk.inspectSubscriptionAccount(max.root, max.runtime, max.query);
  assert.ok(previousId);
  assert.equal(await sdk.inspectSubscriptionAccount(ultra.root, ultra.runtime, ultra.query), previousId);
  assert.equal(ultra.state.delivered, 0);
});

test('account inspection cancellation closes an in-flight account handshake without releasing a prompt', async t => {
  const f = await fixture(t, []);
  const controller = new AbortController();
  let created!: () => void;
  const started = new Promise<void>(resolve => {created = resolve;});
  let closed = 0, delivered = 0;
  const query = ((args: any) => {
    const prompt = (async () => {for await (const _ of args.prompt) delivered++;})();
    prompt.catch(() => {});
    return {accountInfo: () => {created(); return new Promise(() => {});}, close: () => {closed++;}};
  }) as unknown as Parameters<typeof sdk.sdkRunner>[2];
  const pending = sdk.inspectSubscriptionAccount(f.root, f.runtime, query, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === 'aborted');
  assert.equal(closed, 1);
  assert.equal(delivered, 0);
});

test('successful result account evidence comes only from that SDK handshake and stays out of result JSON', async t => {
  const evidence = sdk.subscriptionResultAccount;
  const actualAccount = {...identity, email: 'second-account@example.invalid'};
  const f = await fixture(t, usageStream('msg_actual_account', usage), finalResult({accountId: 'c'.repeat(64)}), actualAccount);
  const result = await f.run();
  assert.equal(evidence(result), accountFingerprint(actualAccount));
  assert.notEqual(evidence(result), accountFingerprint(identity));
  assert.deepEqual(Object.keys(result).sort(), ['decision', 'usage']);
  const json = JSON.stringify(result);
  for (const hidden of [actualAccount.email, actualAccount.organization, accountFingerprint(actualAccount)!]) {
    assert.ok(!json.includes(hidden));
    assert.ok(!(await f.receipts()).some(receipt => receipt.includes(hidden)));
  }
  assert.equal(evidence(structuredClone(result)), null, 'serialized/copied outputs cannot manufacture SDK account evidence');
  const forged = {...result, accountId: accountFingerprint(actualAccount)};
  assert.equal(evidence(forged), null);
  const unknown = await fixture(t, usageStream('msg_unknown_account', usage), finalResult(), {apiProvider: 'firstParty', subscriptionType: 'pro'});
  assert.equal(evidence(await unknown.run()), null);
  assert.equal(evidence(result), accountFingerprint(actualAccount), 'another result does not overwrite the earlier result identity');
});

test('a successful retried decision is bound to the account observed for its own attempt', async t => {
  const evidence = sdk.subscriptionResultAccount;
  const f = await fixture(t, []);
  const secondAccount = {...identity, organization: 'other-organization'};
  let attempts = 0;
  const query = ((args: any) => {
    const current = ++attempts;
    return Object.assign((async function* () {
      for await (const _ of args.prompt) { /* authenticated prompt */ }
      yield* usageStream(`msg_attempt_${current}`, usage);
      yield finalResult(current === 1 ? {structured_output: {text: '', calls: []}} : {});
    })(), {accountInfo: async () => current === 1 ? identity : secondAccount, close() {}});
  }) as unknown as Parameters<typeof sdk.sdkRunner>[2];
  const result = await sdk.sdkRunner(f.root, models, query, f.runtime)(
    requestSchema.parse({model: models[0]!.id, input: 'fixture'}), new AbortController().signal);
  assert.equal(attempts, 2);
  assert.equal(evidence(result), accountFingerprint(secondAccount));
  assert.notEqual(evidence(result), accountFingerprint(identity));
});

test('a selected account refuses a different login before sending conversation contents', async t => {
  const f = await fixture(t, usageStream('msg_account', usage), finalResult());
  const accountModels = [{...models[0]!, account: {id: 'b', label: 'B', configDir: '/fixture/b', fingerprint: 'b'.repeat(64)}}];
  const run = sdk.sdkRunner(f.root, accountModels, f.query, f.runtime);
  await assert.rejects(run(requestSchema.parse({model: accountModels[0]!.id, input: 'private conversation'}), new AbortController().signal),
    (error: unknown) => error instanceof BridgeError && error.code === 'subscription_account_changed');
  assert.equal(f.state.delivered, 0);
  assert.equal(f.state.closed, 1);
  const receipt = JSON.parse((await f.receipts())[0]!);
  assert.equal(receipt.subscription_account_id, 'b');
  assert.equal(receipt.inference_stage, 'not_started');
});

test('parallel account selections isolate child environments and preserve the supplied history when switching', async t => {
  const f = await fixture(t, []);
  const other = {...identity, email: 'other@example.invalid'};
  const accountModels = [
    {...models[0]!, id: 'claude-sdk-sonnet-account-a', account: {id: 'a', label: 'A', fingerprint: accountFingerprint(identity)!}},
    {...models[0]!, id: 'claude-sdk-sonnet-account-b', account: {id: 'b', label: 'B', configDir: '/fixture/b', fingerprint: accountFingerprint(other)!}},
  ];
  const seen: Array<{configDir: string | undefined; prompt: unknown[]}> = [];
  const sourceConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const query = ((args: any) => {
    const row = {configDir: args.options.env.CLAUDE_CONFIG_DIR as string | undefined, prompt: [] as unknown[]};
    seen.push(row);
    return Object.assign((async function* () {
      for await (const message of args.prompt) row.prompt.push(message);
      yield* usageStream('msg_selected_account', usage);
      yield finalResult();
    })(), {accountInfo: async () => row.configDir ? other : identity, close() {}});
  }) as unknown as Parameters<typeof sdk.sdkRunner>[2];
  const run = sdk.sdkRunner(f.root, accountModels, query, f.runtime);
  const input = [{role: 'user', content: 'Earlier context marker 83f1'}, {role: 'assistant', content: 'Remembered'}, {role: 'user', content: 'Continue'}];
  const results = await Promise.all(accountModels.map(model => run(requestSchema.parse({model: model.id, input}), new AbortController().signal)));
  assert.deepEqual(seen.map(row => row.configDir), [undefined, '/fixture/b']);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, sourceConfigDir);
  assert.deepEqual(seen[0]!.prompt, seen[1]!.prompt);
  assert.ok(JSON.stringify(seen[1]!.prompt).includes('Earlier context marker 83f1'));
  assert.deepEqual(results.map(sdk.subscriptionResultAccount), [accountFingerprint(identity), accountFingerprint(other)]);
  const receipts = (await f.receipts()).map(raw => JSON.parse(raw));
  assert.deepEqual(receipts.map(row => row.subscription_account_id).sort(), ['a', 'b']);
});
