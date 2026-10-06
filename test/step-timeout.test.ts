import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { bridgeServer, type ServerOptions } from '../src/server.js';
import { preparePrompt, requestSchema } from '../src/contracts.js';
import { sdkRunner, usageFromModels } from '../src/sdk.js';
import { usageStream, USAGE_MODEL, USAGE_SESSION } from './sdk-usage-fixtures.js';

const result = {decision: {text: 'OK', calls: []}, usage: usageFromModels({})};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function serve(t: TestContext, options: Omit<ServerOptions, 'token'>) {
  const server = bridgeServer({token: 'test-token', ...options});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  return async () => {
    const response = await fetch(url, {method: 'POST', headers: {Authorization: 'Bearer test-token', 'Content-Type': 'application/json'},
      body: JSON.stringify({model: 'test', input: 'hi'})});
    return (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).at(-1);
  };
}

test('a slow step that keeps showing activity is not cut off by the stall limit', {timeout: 10000}, async t => {
  let abortedWhileRunning = false;
  const started = performance.now();
  const post = await serve(t, {timeoutMs: 60, run: async (_request, signal, progress) => {
    for (let i = 0; i < 12; i++) {await sleep(20); abortedWhileRunning ||= signal.aborted; progress?.();}
    return result;
  }});
  const last = await post();
  assert.equal(last.type, 'response.completed');
  assert.ok(performance.now() - started > 3 * 60, 'ran several times the stall limit while active');
  assert.equal(abortedWhileRunning, false);
});

test('a step that goes quiet after some activity fails as a stall and is aborted', {timeout: 10000}, async t => {
  let aborted = false;
  const post = await serve(t, {timeoutMs: 60, run: async (_request, signal, progress) => {
    signal.addEventListener('abort', () => {aborted = true;});
    for (let i = 0; i < 4; i++) {await sleep(20); progress?.();}
    return new Promise(() => {});
  }});
  const last = await post();
  assert.equal(last.type, 'response.failed');
  assert.equal(last.response.error.code, 'timeout');
  assert.match(last.response.error.message, /no model activity for/);
  assert.equal(aborted, true);
});

test('the hard cap still ends a step that is active forever', {timeout: 10000}, async t => {
  const post = await serve(t, {timeoutMs: 60, maxStepMs: 200, run: async (_request, signal, progress) => {
    while (!signal.aborted) {await sleep(15); progress?.();}
    return new Promise(() => {});
  }});
  const last = await post();
  assert.equal(last.type, 'response.failed');
  assert.match(last.response.error.message, /timed out after/);
});

test('every SDK message counts as activity for the step watchdog', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'step-progress-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const frames = usageStream('msg_1', {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5});
  const fake = ((args: any) => Object.assign((async function* () {
    for await (const _ of args.prompt) { /* one prompt */ }
    for (const frame of frames) yield frame;
    yield {type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 2, result: '', stop_reason: 'end_turn',
      total_cost_usd: 0, permission_denials: [], usage: {input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5},
      modelUsage: {[USAGE_MODEL]: {inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 5, thinkingTokens: 0,
        webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 128000}},
      structured_output: {text: 'ok', calls: []}, session_id: USAGE_SESSION, uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84'};
  })(), {accountInfo: async () => ({apiProvider: 'firstParty', subscriptionType: 'pro'}), close() {}})) as unknown as Parameters<typeof sdkRunner>[2];
  const run = sdkRunner(root, [{id: 'claude-sdk-sonnet', sdkModel: 'sonnet', resolvedModel: USAGE_MODEL, displayName: 'F', description: '', efforts: []}],
    fake, {receiptsDir: root, guard: async () => ({coverage: 'test_injected'})});
  let ticks = 0;
  await run(requestSchema.parse({model: 'claude-sdk-sonnet', input: 'hi'}), new AbortController().signal, () => {ticks++;});
  assert.equal(ticks, frames.length + 1);
});

test('the prompt asks for large edits to be split into smaller steps', () => {
  assert.match(preparePrompt(requestSchema.parse({model: 'test', input: 'hi'})).system, /Split large edits into several apply_patch steps/);
});
