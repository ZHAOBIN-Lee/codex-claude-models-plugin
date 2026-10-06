import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { bridgeServer } from '../src/server.js';
import { usageFromModels } from '../src/sdk.js';
import { BridgeError, COMPACTION_PROMPT_PREFIX, isCompactionRequest, requestSchema } from '../src/contracts.js';

const result = {decision: {text: 'SUMMARY', calls: []}, usage: usageFromModels({})};
const headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'};
const compactPrompt = `${COMPACTION_PROMPT_PREFIX} Create a handoff summary for another LLM that will resume the task.`;
const metadata = (kind: string) => ({'x-codex-turn-metadata': JSON.stringify({request_kind: kind, thread_id: 't'})});
const ordinary = {model: 'test', input: [{role: 'user', content: [{type: 'input_text', text: 'hi'}]}]};
const byPrompt = {model: 'test', input: [{role: 'user', content: 'earlier'}, {role: 'assistant', content: 'ok'},
  {role: 'user', content: [{type: 'input_text', text: compactPrompt}]}]};
const byMetadata = {...ordinary, client_metadata: metadata('compaction')};

async function serve(t: import('node:test').TestContext, options: Omit<Parameters<typeof bridgeServer>[0], 'token'>) {
  const server = bridgeServer({token: 'test-token', ...options});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  return async (body: unknown) => {
    const text = await (await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)})).text();
    return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  };
}

test('compaction is recognised from Codex metadata or the fixed prompt, and nothing else', () => {
  assert.equal(isCompactionRequest(requestSchema.parse(byMetadata)), true);
  assert.equal(isCompactionRequest(requestSchema.parse(byPrompt)), true);
  assert.equal(isCompactionRequest(requestSchema.parse({model: 'test', input: compactPrompt})), true);
  assert.equal(isCompactionRequest(requestSchema.parse(ordinary)), false);
  assert.equal(isCompactionRequest(requestSchema.parse({...ordinary, client_metadata: metadata('turn')})), false);
  assert.equal(isCompactionRequest(requestSchema.parse({...ordinary, client_metadata: {'x-codex-turn-metadata': '{bad'}})), false);
  // Quoting the prompt in an earlier turn does not make the current step a compaction.
  assert.equal(isCompactionRequest(requestSchema.parse({model: 'test', input: [{role: 'user', content: compactPrompt}, {role: 'user', content: 'next'}]})), false);
});

test('a compaction step gets the longer limit while an ordinary step keeps the short one', {timeout: 10000}, async t => {
  const post = await serve(t, {timeoutMs: 30, compactionTimeoutMs: 2000, run: async (request) => {
    await new Promise(resolve => setTimeout(resolve, 120));
    return {...result, decision: {text: String(request.model), calls: []}};
  }});
  assert.equal((await post(byMetadata)).at(-1).type, 'response.completed');
  const failed = (await post(ordinary)).at(-1);
  assert.equal(failed.type, 'response.failed'); assert.equal(failed.response.error.code, 'timeout');
});

test('a failed compaction is retried once; an ordinary step and a non-retryable failure are not', {timeout: 10000}, async t => {
  let calls = 0;
  let failures = 1;
  let status = 502;
  const post = await serve(t, {run: async () => {
    calls++;
    if (failures-- > 0) throw new BridgeError(status, 'claude_failed', 'transient');
    return result;
  }});
  assert.equal((await post(byPrompt)).at(-1).type, 'response.completed'); assert.equal(calls, 2);
  calls = 0; failures = 1;
  assert.equal((await post(ordinary)).at(-1).type, 'response.failed'); assert.equal(calls, 1);
  calls = 0; failures = 5;
  assert.equal((await post(byPrompt)).at(-1).type, 'response.failed'); assert.equal(calls, 2);
  calls = 0; failures = 1; status = 401;
  assert.equal((await post(byPrompt)).at(-1).type, 'response.failed'); assert.equal(calls, 1);
});

test('the heartbeat is a parsed SSE event so Codex resets its idle timer', {timeout: 10000}, async t => {
  const post = await serve(t, {heartbeatMs: 20, run: async () => {await new Promise(resolve => setTimeout(resolve, 150)); return result;}});
  const events = await post(byMetadata);
  const progress = events.filter(e => e.type === 'response.in_progress');
  assert.ok(progress.length >= 3, `expected repeated in_progress events, got ${progress.length}`);
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  assert.equal(events.at(-1).type, 'response.completed');
});
