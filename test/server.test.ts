import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { bridgeServer } from '../src/server.js';
import { usageFromModels } from '../src/sdk.js';

const result = {decision: {text: 'OK', calls: []}, usage: usageFromModels({})};
const headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'};
const request = JSON.stringify({model: 'test', input: 'hi'});

test('HTTP authentication, browser isolation, parsing and SSE completion', {timeout: 10000}, async t => {
  let calls = 0;
  const server = bridgeServer({token: 'test-token', run: async () => {calls++; return result;}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, {headers: {...headers, Origin: 'https://example.com'}})).status, 401);
  assert.equal((await fetch(`${base}/health`, {headers})).status, 200);
  assert.equal((await fetch(`${base}/v1/responses`, {method: 'POST', headers, body: 'bad'})).status, 400);
  assert.equal(calls, 0);
  const response = await fetch(`${base}/v1/responses`, {method: 'POST', headers, body: request});
  const events = (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'OK');
  assert.equal(calls, 1);
});

test('timeout aborts inference and is an SSE failure', {timeout: 10000}, async t => {
  let aborted = false;
  const server = bridgeServer({token: 'test-token', timeoutMs: 30, run: async (_request, signal) => {
    signal.addEventListener('abort', () => {aborted = true;});
    return new Promise(() => {});
  }});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`, {method: 'POST', headers, body: request});
  const text = await response.text();
  assert.match(text, /response.failed/); assert.match(text, /timeout/); assert.equal(aborted, true);
});

test('oversized bodies are rejected before inference', {timeout: 10000}, async t => {
  let calls = 0;
  const server = bridgeServer({token: 'test-token', maxBytes: 64, run: async () => {calls++; return result;}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
    {method: 'POST', headers, body: JSON.stringify({model: 'test', input: 'x'.repeat(100)})});
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test('client disconnect aborts the active model step', {timeout: 10000}, async t => {
  let aborted!: () => void;
  const observed = new Promise<void>(resolve => {aborted = resolve;});
  const server = bridgeServer({token: 'test-token', run: async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {aborted(); reject(new Error('cancelled'));});
  })});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
    {method: 'POST', headers, body: request});
  await response.body!.cancel();
  await observed;
});

test('concurrency limit rejects work before another SDK run starts', {timeout: 10000}, async t => {
  let release!: () => void;
  const started = new Promise<void>(resolve => {release = resolve;});
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => {finish = resolve;});
  const server = bridgeServer({token: 'test-token', concurrency: 1, run: async () => {release(); await blocked; return result;}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {finish(); server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
  const first = fetch(url, {method: 'POST', headers, body: request});
  await started;
  assert.equal((await fetch(url, {method: 'POST', headers, body: request})).status, 429);
  finish(); await (await first).text();
});
