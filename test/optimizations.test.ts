import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdkRunner } from '../src/sdk.js';
import { requestSchema } from '../src/contracts.js';
import { npmCommand } from '../src/setup.js';
import { usageStream, USAGE_MODEL, USAGE_SESSION, type Frame } from './sdk-usage-fixtures.js';

const models = [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: USAGE_MODEL, displayName: 'Fixture', description: '', efforts: ['medium']}];
const usage = {input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 200};
const final: Frame = {type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 9, num_turns: 2, result: '',
  stop_reason: 'end_turn', total_cost_usd: 0, permission_denials: [], usage, session_id: USAGE_SESSION,
  modelUsage: {[USAGE_MODEL]: {inputTokens: 1000, cacheReadInputTokens: 40000, cacheCreationInputTokens: 0, outputTokens: 200,
    thinkingTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 128000}},
  structured_output: {text: 'answer', calls: []}, uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84'};

test('a stream without verifiable usage is retried once with the unchanged prompt and the answer is delivered', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-retry-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const prompts: unknown[] = [];
  let calls = 0;
  const fake = ((args: any) => Object.assign((async function* () {
    for await (const message of args.prompt) prompts.push(message.message.content);
    // First attempt: only the aggregate result, no per-request stream. Second attempt: a complete stream.
    if (calls++ > 0) for (const frame of usageStream('msg_retry', usage)) yield frame;
    yield final;
  })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
  const run = sdkRunner(root, models, fake, {receiptsDir: root, guard: async () => ({coverage: 'test_injected'})});
  const result = await run(requestSchema.parse({model: 'claude-sdk-sonnet', input: 'fixture'}), new AbortController().signal);
  assert.equal(result.decision.text, 'answer');
  assert.equal(result.usage.input_tokens, 41000);
  assert.equal(calls, 2);
  assert.deepEqual(prompts[0], prompts[1], 'the retry adds no correction note');
  const files = (await fs.readdir(root)).filter(name => name.endsWith('.json'));
  const receipt = JSON.parse(await fs.readFile(path.join(root, files[0]!), 'utf8'));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.attempts, 2);
  assert.equal(receipt.rejected.code, 'missing_context_usage');
});

test('npm is taken from NPM_BIN, then next to Node, then PATH', async () => {
  assert.deepEqual(await npmCommand({NPM_BIN: '/x/npm-cli.js'}), [process.execPath, ['/x/npm-cli.js']]);
  assert.deepEqual(await npmCommand({NPM_BIN: '/x/bin/npm'}), ['/x/bin/npm', []]);
  const sibling = path.join(path.dirname(process.execPath), 'npm');
  const exists = await fs.access(sibling).then(() => true, () => false);
  assert.deepEqual(await npmCommand({}), exists ? [sibling, []] : ['npm', []]);
});
