import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiForwarder, ROUTER_TOKEN_HEADER } from '../src/openai.js';

const auth = {[ROUTER_TOKEN_HEADER]: 'local-test-only', authorization: 'Bearer openai-test-only', 'chatgpt-account-id': 'test-account'};
const body = Buffer.from('{"model":"gpt-test"}');
const connectError = (code: string) => Object.assign(new TypeError('fetch failed'), {cause: {code}});

test('GPT forwarding retries a connection that failed before OpenAI answered', async () => {
  let calls = 0;
  const forward = openaiForwarder((async () => {
    calls++;
    if (calls < 3) throw connectError(calls === 1 ? 'ETIMEDOUT' : 'ECONNRESET');
    return new Response('ok');
  }) as typeof fetch, [1, 1]);
  const response = await forward({path: '/v1/responses', headers: auth, body, signal: new AbortController().signal});
  assert.equal(await response.text(), 'ok');
  assert.equal(calls, 3);
});

test('GPT forwarding gives up after the retry budget and reports the network error', async () => {
  let calls = 0;
  const forward = openaiForwarder((async () => {calls++; throw connectError('ETIMEDOUT');}) as typeof fetch, [1, 1]);
  await assert.rejects(forward({path: '/v1/responses', headers: auth, body, signal: new AbortController().signal}),
    (error: Error & {cause?: {code?: string}}) => error.cause?.code === 'ETIMEDOUT');
  assert.equal(calls, 3);
});

test('GPT forwarding does not retry other errors or cancelled requests', async () => {
  let calls = 0;
  const other = openaiForwarder((async () => {calls++; throw new TypeError('bad request body');}) as typeof fetch, [1, 1]);
  await assert.rejects(other({path: '/v1/responses', headers: auth, body, signal: new AbortController().signal}), /bad request body/);
  assert.equal(calls, 1);

  calls = 0;
  const controller = new AbortController();
  const cancelled = openaiForwarder((async () => {calls++; controller.abort(); throw connectError('ETIMEDOUT');}) as typeof fetch, [1, 1]);
  await assert.rejects(cancelled({path: '/v1/responses', headers: auth, body, signal: controller.signal}));
  assert.equal(calls, 1);

  calls = 0;
  const controller2 = new AbortController();
  const cancelledWhileWaiting = openaiForwarder((async () => {
    calls++; setTimeout(() => controller2.abort(), 5); throw connectError('ETIMEDOUT');
  }) as typeof fetch, [10_000]);
  const started = Date.now();
  await assert.rejects(cancelledWhileWaiting({path: '/v1/responses', headers: auth, body, signal: controller2.signal}));
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2_000);
});

test('GPT forwarding does not retry once OpenAI has answered, even with an error status', async () => {
  let calls = 0;
  const forward = openaiForwarder((async () => {calls++; return new Response('busy', {status: 503});}) as typeof fetch, [1, 1]);
  const response = await forward({path: '/v1/responses', headers: auth, body, signal: new AbortController().signal});
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});
