import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { bridgeServer } from '../src/server.js';
import { openaiForwarder, forwardedResponseHeaders, portableAgentMessages, ROUTER_TOKEN_HEADER } from '../src/openai.js';
import { combinedCatalog } from '../src/catalog.js';
import { usageFromModels } from '../src/sdk.js';

const localToken = 'local-test-only';
const auth = {[ROUTER_TOKEN_HEADER]: localToken, authorization: 'Bearer openai-test-only', 'chatgpt-account-id': 'test-account'};
const claudeResult = {decision: {text: 'CLAUDE_RESULT', calls: []}, usage: usageFromModels({})};

test('OpenAI forwarding has fixed destinations and never forwards the local token or browser cookies', async () => {
  const bytes = Buffer.from('{ "model": "gpt-test", "input": [{"opaque":"preserve"}] }');
  const called: string[] = [];
  const forward = openaiForwarder((async (url, options) => {
    called.push(String(url));
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), auth.authorization);
    assert.equal(headers.get('chatgpt-account-id'), auth['chatgpt-account-id']);
    assert.equal(headers.get(ROUTER_TOKEN_HEADER), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('host'), null);
    assert.equal(headers.get('x-codex-turn-metadata'), 'metadata');
    assert.equal(options?.redirect, 'manual');
    assert.deepEqual(Buffer.from(options!.body as Uint8Array), bytes);
    return new Response('upstream');
  }) as typeof fetch);
  for (const route of ['/v1/responses', '/v1/responses/compact']) {
    await forward({path: route, headers: {...auth, cookie: 'browser-secret', host: '127.0.0.1', 'x-codex-turn-metadata': 'metadata'},
      body: bytes, signal: new AbortController().signal});
  }
  assert.deepEqual(called, ['https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses/compact']);
  await assert.rejects(forward({path: 'https://evil.example/', headers: auth, body: bytes, signal: new AbortController().signal}), /Unsupported OpenAI route/);
  assert.equal(called.length, 2);
});

test('OpenAI routing requires ChatGPT credentials and rejects redirects', async () => {
  let calls = 0;
  const forward = openaiForwarder((async () => {calls++; return new Response(null, {status: 307, headers: {location: 'https://evil.example/'}});}) as typeof fetch);
  const request = {path: '/v1/responses', headers: {authorization: 'Bearer fake-api-key'}, body: Buffer.from('{}'), signal: new AbortController().signal};
  await assert.rejects(forward(request), /ChatGPT login/); assert.equal(calls, 0);
  await assert.rejects(forward({...request, headers: auth}), /will not forward credentials/); assert.equal(calls, 1);
});

test('forwarded headers preserve auth and limits while removing hop-by-hop and decoded-body headers', () => {
  const headers = forwardedResponseHeaders(new Headers({'www-authenticate': 'Bearer', 'retry-after': '3',
    connection: 'x-hop', 'x-hop': 'discard', 'set-cookie': 'discard', 'content-encoding': 'gzip', 'content-length': '42',
    'x-codex-primary-used-percent': '20'}));
  assert.deepEqual(headers, {'www-authenticate': 'Bearer', 'retry-after': '3', 'x-codex-primary-used-percent': '20'});
});

test('plain-text agent messages from a Claude parent become input_text; real OpenAI ciphertext is kept', () => {
  const cipher = 'gAAAAABqv_sE' + 'A'.repeat(40) + '==';
  const request = {model: 'gpt-test', stream: true, input: [
    {type: 'message', role: 'user', content: [{type: 'input_text', text: 'hi'}]},
    {type: 'agent_message', author: '/root', recipient: '/root/worker', content: [
      {type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n'},
      {type: 'encrypted_content', encrypted_content: '你是 /root 指派的执行者'}]},
    {type: 'agent_message', author: '/root', recipient: '/root/other', content: [
      {type: 'encrypted_content', encrypted_content: cipher}]},
  ]};
  const out = JSON.parse(portableAgentMessages(request)!.toString());
  assert.deepEqual(out.input[1].content[1], {type: 'input_text', text: '你是 /root 指派的执行者'});
  assert.deepEqual(out.input[1].content[0], request.input[1]!.content![0]);
  assert.deepEqual(out.input[2], request.input[2]);
  assert.deepEqual(out.input[0], request.input[0]);
  assert.equal(out.model, 'gpt-test'); assert.equal(out.stream, true);
  // Nothing to change: the router must forward the original bytes.
  assert.equal(portableAgentMessages({model: 'gpt-test', input: [request.input[2]]}), undefined);
  assert.equal(portableAgentMessages({model: 'gpt-test', input: 'hi'}), undefined);
  assert.equal(portableAgentMessages(null), undefined);
});

test('the router forwards a Claude-spawned GPT sub-agent task as plain text', {timeout: 10000}, async t => {
  const seen: string[] = [];
  const server = bridgeServer({token: localToken, run: async () => claudeResult,
    openai: {models: new Set(['gpt-test']), forward: async request => {seen.push(request.body.toString()); return new Response('ok');}}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const body = JSON.stringify({model: 'gpt-test', input: [{type: 'agent_message', author: '/root', recipient: '/root/w',
    content: [{type: 'encrypted_content', encrypted_content: 'PLAIN_TASK'}]}]});
  await (await fetch(url, {method: 'POST', headers: auth, body})).text();
  const forwarded = JSON.parse(seen[0]!);
  assert.deepEqual(forwarded.input[0].content, [{type: 'input_text', text: 'PLAIN_TASK'}]);
  assert.ok(!seen[0]!.includes('encrypted_content'));
});

test('image generation and edit requests are proxied byte for byte to the OpenAI image routes', {timeout: 10000}, async t => {
  const seen: {path: string; body: Buffer; type?: string}[] = [];
  let claudeCalls = 0;
  const server = bridgeServer({token: localToken, run: async () => {claudeCalls++; return claudeResult;},
    openai: {models: new Set(['gpt-test']), forward: async request => {
      seen.push({path: request.path, body: request.body, type: String(request.headers['content-type'])});
      return new Response('{"data":[{"b64_json":"aW1n"}]}', {headers: {'content-type': 'application/json'}});
    }}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/images`;
  // The image model is not in the chat catalog and must not be rejected as unknown.
  const generate = await fetch(`${base}/generations`, {method: 'POST', headers: {...auth, 'content-type': 'application/json'},
    body: '{"model":"gpt-image-2","prompt":"a coin"}'});
  assert.equal(generate.status, 200);
  assert.equal((await generate.json()).data[0].b64_json, 'aW1n');
  const multipart = Buffer.concat([Buffer.from('--b\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\n'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), Buffer.from('\r\n--b--\r\n')]);
  const edit = await fetch(`${base}/edits`, {method: 'POST', headers: {...auth, 'content-type': 'multipart/form-data; boundary=b'}, body: multipart});
  assert.equal(edit.status, 200); await edit.text();
  assert.deepEqual(seen.map(s => s.path), ['/v1/images/generations', '/v1/images/edits']);
  assert.equal(seen[0]!.body.toString(), '{"model":"gpt-image-2","prompt":"a coin"}');
  assert.deepEqual(seen[1]!.body, multipart);
  assert.equal(seen[1]!.type, 'multipart/form-data; boundary=b');
  assert.equal(claudeCalls, 0);
  // The Claude-only credential cannot reach OpenAI image routes.
  const legacy = await fetch(`${base}/generations`, {method: 'POST', headers: {authorization: `Bearer ${localToken}`}, body: '{}'});
  assert.equal(legacy.status, 401);
  assert.equal(seen.length, 2);
});

test('image routes are not offered without the GPT router, and the forwarder targets the OpenAI image URLs', {timeout: 10000}, async t => {
  const server = bridgeServer({token: localToken, run: async () => claudeResult});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/images/generations`, {method: 'POST', headers: auth, body: '{}'});
  assert.equal(response.status, 404);
  const called: string[] = [];
  const forward = openaiForwarder((async (url: string | URL | Request) => {called.push(String(url)); return new Response('ok');}) as typeof fetch);
  for (const path of ['/v1/images/generations', '/v1/images/edits']) await forward({path, headers: auth, body: Buffer.from('{}'), signal: new AbortController().signal});
  assert.deepEqual(called, ['https://chatgpt.com/backend-api/codex/images/generations', 'https://chatgpt.com/backend-api/codex/images/edits']);
});

test('long GPT streams do not use Claude concurrency slots', {timeout: 10000}, async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  const server = bridgeServer({token: localToken, concurrency: 1, run: async () => claudeResult,
    openai: {models: new Set(['gpt-test']), forward: async () => new Response(new ReadableStream({async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      await hold; controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}})}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {release(); server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const streams = await Promise.all([1, 2, 3].map(() => fetch(url, {method: 'POST', headers: auth, body: '{"model":"gpt-test"}'})));
  assert.ok(streams.every(response => response.status === 200));
  const claude = await fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: false})});
  assert.equal(claude.status, 200);
  release();
  await Promise.all(streams.map(response => response.text()));
});

test('extra Claude steps wait for a free slot instead of failing', {timeout: 10000}, async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  let calls = 0, running = 0, peak = 0;
  const server = bridgeServer({token: localToken, concurrency: 1, run: async () => {
    calls++; running++; peak = Math.max(peak, running);
    if (calls === 1) await hold;
    running--; return claudeResult;
  }});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {release(); server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const body = JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: false});
  const first = fetch(url, {method: 'POST', headers: auth, body});
  await new Promise(resolve => setTimeout(resolve, 200));
  const second = fetch(url, {method: 'POST', headers: auth, body});
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});

test('a queued Claude step fails as busy only after the queue wait', {timeout: 10000}, async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  const server = bridgeServer({token: localToken, concurrency: 1, queueMs: 150, heartbeatMs: 50, run: async () => {await hold; return claudeResult;}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {release(); server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const first = fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: false})});
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now();
  const plain = await fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: false})});
  assert.equal(plain.status, 429);
  assert.equal((await plain.json()).error.code, 'busy');
  assert.ok(Date.now() - started >= 120);
  const streamed = await fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: true})});
  assert.equal(streamed.status, 200);
  const events = await streamed.text();
  assert.ok(events.includes('response.in_progress'));
  assert.ok(events.includes('response.failed') && events.includes('"busy"'));
  release();
  assert.equal((await first).status, 200);
});

test('one authenticated router serves GPT passthrough, Claude decisions, and GPT compaction', {timeout: 10000}, async t => {
  const seen: {path: string; body: string}[] = [];
  let claudeCalls = 0;
  const sse = 'data: {"type":"response.completed","response":{"id":"original"}}\n\n';
  const server = bridgeServer({token: localToken, run: async request => {
    claudeCalls++;
    assert.equal(request.model, 'claude-sdk-haiku');
    assert.ok(!JSON.stringify(request).includes('openai-test-only'));
    return claudeResult;
  }, openai: {models: new Set(['gpt-test']), forward: async request => {
    seen.push({path: request.path, body: request.body.toString()});
    return new Response(request.path.endsWith('/compact') ? '{"output":[{"type":"compaction","encrypted_content":"opaque"}]}' : sse,
      {headers: {'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '20'}});
  }}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const raw = '{ "model": "gpt-test", "input": [{"type":"additional_tools"}], "tools": [{"type":"web_search"}] }';
  const response = await fetch(url, {method: 'POST', headers: auth, body: raw});
  assert.equal(await response.text(), sse);
  assert.equal(response.headers.get('x-codex-primary-used-percent'), '20');
  assert.equal(seen[0]?.body, raw);
  assert.equal(claudeCalls, 0);
  const claude = await fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: 'hi', stream: false})});
  assert.equal((await claude.json()).output[0].content[0].text, 'CLAUDE_RESULT');
  assert.equal(claudeCalls, 1);
  assert.equal(seen.length, 1);
  const compact = await fetch(`${url}/compact`, {method: 'POST', headers: auth, body: JSON.stringify({model: 'gpt-test', input: []})});
  assert.equal((await compact.json()).output[0].encrypted_content, 'opaque');
  assert.equal(seen.at(-1)?.path, '/v1/responses/compact');
  assert.equal((await fetch(`${url}/compact`, {method: 'POST', headers: auth, body: JSON.stringify({model: 'claude-sdk-haiku', input: []})})).status, 400);
});

test('router rejects unknown models and the Claude-only credential cannot authorize GPT', {timeout: 10000}, async t => {
  let calls = 0;
  const server = bridgeServer({token: localToken, run: async () => {calls++; return claudeResult;},
    openai: {models: new Set(['gpt-test']), forward: async () => {calls++; return new Response('unexpected');}}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  assert.equal((await fetch(url, {method: 'POST', headers: {authorization: `Bearer ${localToken}`}, body: JSON.stringify({model: 'gpt-test'})})).status, 401);
  assert.equal((await fetch(url, {method: 'POST', headers: auth, body: JSON.stringify({model: 'unknown'})})).status, 400);
  assert.equal(calls, 0);
});

test('upstream authentication failures retain status, body and refresh hints', {timeout: 10000}, async t => {
  const error = '{"error":{"code":"token_expired","message":"Sign in again"}}';
  const server = bridgeServer({token: localToken, run: async () => claudeResult,
    openai: {models: new Set(['gpt-test']), forward: async () => new Response(error, {status: 401, headers: {'www-authenticate': 'Bearer', 'retry-after': '1'}})}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`, {method: 'POST', headers: auth, body: '{"model":"gpt-test"}'});
  assert.equal(response.status, 401); assert.equal(await response.text(), error);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
});

test('disconnecting a GPT stream aborts its upstream request', {timeout: 10000}, async t => {
  let aborted!: () => void;
  const cancellation = new Promise<void>(resolve => {aborted = resolve;});
  const server = bridgeServer({token: localToken, run: async () => claudeResult,
    openai: {models: new Set(['gpt-test']), forward: async request => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      request.signal.addEventListener('abort', () => {aborted(); controller.error(new Error('cancelled'));}, {once: true});
    }}))}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`, {method: 'POST', headers: auth, body: '{"model":"gpt-test"}'});
  await response.body!.cancel(); await cancellation;
});

test('the combined catalog preserves OpenAI rows and selects the portable native agent runtime', () => {
  const original = [{slug: 'gpt-visible', priority: 0, visibility: 'list', model_messages: {instructions_template: 'original'}, multi_agent_version: 'v2'},
    {slug: 'gpt-hidden', priority: 4, visibility: 'hide', supports_image_detail_original: true}];
  const result = combinedCatalog({models: original}, [{id: 'claude-sdk-haiku', sdkModel: 'haiku', displayName: 'Claude', description: '', efforts: []}]);
  assert.deepEqual(result.models.slice(0, 2), original.map(m => ({...m, multi_agent_version: 'v1'})));
  assert.ok(result.models.every(m => m.multi_agent_version === 'v1'));
  assert.equal(result.models[2]?.slug, 'claude-sdk-haiku');
  assert.equal(result.models[2]?.priority, 5);
});
