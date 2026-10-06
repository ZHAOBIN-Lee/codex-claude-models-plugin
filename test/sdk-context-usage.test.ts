import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sdkRunner} from '../src/sdk.js';
import {BridgeError, requestSchema} from '../src/contracts.js';
import {assistantPlaceholder, usageDelta, usageStart, usageStop, usageStream, USAGE_MODEL, USAGE_SESSION, type Frame} from './sdk-usage-fixtures.js';

const haiku = 'claude-haiku-4-5-20251001';
const models = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: USAGE_MODEL,
  displayName: 'Fixture', description: '', efforts: ['medium']}];
const aggregate = {
  [USAGE_MODEL]: {inputTokens: 2000, cacheReadInputTokens: 932000, cacheCreationInputTokens: 3000, outputTokens: 800,
    thinkingTokens: 50, webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 128000},
  [haiku]: {inputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 11,
    thinkingTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000},
};
const finalResult = (over: Frame = {}): Frame => ({type: 'result', subtype: 'success', is_error: false,
  duration_ms: 100, duration_api_ms: 90, num_turns: 3, result: '', stop_reason: 'end_turn', total_cost_usd: 0,
  permission_denials: [], usage: {input_tokens: 2000, cache_read_input_tokens: 932000, cache_creation_input_tokens: 3000, output_tokens: 800},
  modelUsage: aggregate, structured_output: {text: 'fixture answer', calls: []}, session_id: USAGE_SESSION,
  uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', ...over});
const firstUsage = {input_tokens: 1000, cache_read_input_tokens: 467000, cache_creation_input_tokens: 0, output_tokens: 500};
const latestUsage = {input_tokens: 1000, cache_read_input_tokens: 465000, cache_creation_input_tokens: 3000, output_tokens: 300};

async function fixture(t: TestContext, frames: Frame[], final: Frame = finalResult()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-context-usage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const fake = ((args: any) => Object.assign((async function* () {
    for await (const _ of args.prompt) { /* one bounded SDK prompt */ }
    // The real SDK sends these events only when requested explicitly.
    if (args.options.includePartialMessages) for (const frame of frames) yield frame;
    yield final;
  })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
  const run = sdkRunner(root, models, fake, {receiptsDir: root, guard: async () => ({coverage: 'test_injected'})});
  return {run: () => run(requestSchema.parse({model: 'claude-sdk-sonnet', input: 'fixture', reasoning: {effort: 'medium'}}), new AbortController().signal),
    receipt: async () => {
      const files = (await fs.readdir(root)).filter(name => name.endsWith('.json'));
      assert.equal(files.length, 1);
      const text = await fs.readFile(path.join(root, files[0]!), 'utf8');
      assert.ok(!text.includes('unpersisted fixture content'));
      return JSON.parse(text);
    }};
}

test('Codex receives the latest primary context while the receipt retains all SDK calls', async t => {
  // Summing modelUsage instead of using one completed main request causes false compaction.
  const f = await fixture(t, [...usageStream('msg_first', firstUsage), ...usageStream('msg_latest', latestUsage)]);
  const result = await f.run();
  assert.deepEqual(result.usage, {input_tokens: 469000, input_tokens_details: {cached_tokens: 465000}, output_tokens: 300,
    output_tokens_details: {reasoning_tokens: 0}, total_tokens: 469300});
  assert.equal(result.decision.text, 'fixture answer');
  const receipt = await f.receipt();
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.usage_scope, 'query_pipeline_total');
  assert.equal(receipt.usage.input_tokens, 938000);
  assert.equal(receipt.usage.total_tokens, 938811);
  assert.equal(receipt.context_usage.model, USAGE_MODEL);
  assert.equal(receipt.context_usage.source, 'message_stream');
  assert.equal(receipt.context_usage.usage.total_tokens, 469300);
});

test('cumulative message deltas and placeholder or replayed blocks do not inflate or replace the final count', async t => {
  const f = await fixture(t, [usageStart('msg_latest', {...latestUsage, output_tokens: 1}),
    usageDelta({output_tokens: 150}), usageDelta({output_tokens: 300, output_tokens_details: {thinking_tokens: 50}}),
    usageDelta({output_tokens: 300, output_tokens_details: {thinking_tokens: 50}}), usageStop(),
    assistantPlaceholder('msg_latest', {...latestUsage, output_tokens: 1}),
    ...usageStream('msg_latest', {...latestUsage, output_tokens: 1})]);
  const {usage} = await f.run();
  assert.equal(usage.input_tokens, 469000);
  assert.equal(usage.output_tokens, 300);
  assert.equal(usage.output_tokens_details.reasoning_tokens, 50);
  assert.equal(usage.total_tokens, 469300, 'thinking is already included in output');
});

test('subagent streams and a top-level auxiliary model cannot replace the main context', async t => {
  const huge = {input_tokens: 8000000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 80000};
  const f = await fixture(t, [...usageStream('msg_latest', latestUsage),
    ...usageStream('msg_subagent', huge, USAGE_MODEL, 'toolu_subagent'), ...usageStream('msg_auxiliary', huge, haiku)]);
  const result = await f.run();
  assert.equal(result.usage.total_tokens, 469300);
});

test('a genuine large context is reported intact so normal compaction can still trigger', async t => {
  const f = await fixture(t, usageStream('msg_large', {input_tokens: 10000, cache_read_input_tokens: 740000,
    cache_creation_input_tokens: 10000, output_tokens: 300}));
  const result = await f.run();
  assert.equal(result.usage.input_tokens, 760000);
  assert.equal(result.usage.total_tokens, 760300);
});

test('missing or unfinished last-request usage is rejected instead of falling back to totals or an older context', async t => {
  const cases: [string, Frame[]][] = [
    ['only an aggregate result', []],
    ['assistant output remains a placeholder', [assistantPlaceholder('msg_latest', latestUsage)]],
    ['no final output counter', [usageStart('msg_latest', latestUsage), usageStop()]],
    ['no stop', [usageStart('msg_latest', latestUsage), usageDelta({output_tokens: 300})]],
    ['new main stream is unfinished', [...usageStream('msg_first', firstUsage), usageStart('msg_latest', latestUsage)]],
    ['new main assistant has no stream', [...usageStream('msg_first', firstUsage), assistantPlaceholder('msg_latest', latestUsage)]],
  ];
  for (const [name, frames] of cases) await t.test(name, async st => {
    const f = await fixture(st, frames);
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'missing_context_usage');
    const receipt = await f.receipt();
    assert.equal(receipt.status, 'incomplete');
    assert.equal(receipt.context_usage, null);
    assert.equal(receipt.usage.total_tokens, 938811, 'spent tokens remain available even though the answer is withheld');
  });
});

test('invalid per-request counters do not become low, zero or nonfinite context estimates', async t => {
  for (const value of [-1, 1.5, NaN, Infinity, '300']) await t.test(String(value), async st => {
    const f = await fixture(st, [usageStart('msg_latest', latestUsage), usageDelta({output_tokens: value}), usageStop()]);
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'missing_context_usage');
  });
});

test('a stream from another session or a model absent from the final receipt is not context evidence', async t => {
  for (const over of [{session_id: '9d1e6b7a-2c3f-4e58-8a01-5b4c7d9e0f12'}, {modelUsage: {[haiku]: aggregate[haiku]}}]) {
    const f = await fixture(t, usageStream('msg_latest', latestUsage), finalResult(over));
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'missing_context_usage');
  }
});

test('server-side iteration totals use the last message context rather than a compaction operation', async t => {
  const iterations = [
    {type: 'message', input_tokens: 1000, cache_read_input_tokens: 467000, cache_creation_input_tokens: 0, output_tokens: 500},
    {type: 'message', input_tokens: 1000, cache_read_input_tokens: 465000, cache_creation_input_tokens: 3000, output_tokens: 300},
    {type: 'compaction', input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20},
  ];
  const f = await fixture(t, [usageStart('msg_latest', firstUsage), usageDelta({input_tokens: 2000,
    cache_read_input_tokens: 932000, cache_creation_input_tokens: 3000, output_tokens: 800, iterations}), usageStop()]);
  const result = await f.run();
  assert.equal(result.usage.total_tokens, 469300);
});

test('real SDK iteration metadata inherits the verified stream model and preserves cache tokens', async t => {
  // Metadata shape observed with pinned SDK 0.3.270 / CLI 2.1.285. An
  // iteration has token counters and a type, but no separate model property.
  const start = {input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1759, output_tokens: 24};
  const complete = {...start, output_tokens: 75};
  const f = await fixture(t, [usageStart('msg_live_shape', start), assistantPlaceholder('msg_live_shape', start),
    usageDelta({...complete, iterations: [{type: 'message', ...complete}]}), usageStop()]);
  const result = await f.run();
  assert.equal(result.usage.input_tokens, 1761);
  assert.equal(result.usage.input_tokens_details.cached_tokens, 1759);
  assert.equal(result.usage.output_tokens, 75);
  assert.equal(result.usage.total_tokens, 1836);
  assert.equal((await f.receipt()).status, 'complete');
});

test('an explicitly conflicting iteration model is still rejected', async t => {
  for (const model of [haiku, '<redacted>', null]) {
    const f = await fixture(t, [usageStart('msg_latest', latestUsage),
      usageDelta({...latestUsage, iterations: [{type: 'message', model, ...latestUsage}]}), usageStop()]);
    await assert.rejects(f.run(), (error: unknown) => error instanceof BridgeError && error.code === 'missing_context_usage');
  }
});
