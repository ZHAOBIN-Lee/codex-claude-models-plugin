import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BridgeError, requestSchema} from '../src/contracts.js';
import {attachStepIdentity, stepIdentity, PaidStepGuard} from '../src/paid-step-guard.js';

const request = (extra: Record<string, unknown> = {}) => requestSchema.parse({model: 'claude-sdk-sonnet', instructions: 'Fixture instruction',
  input: [{role: 'user', content: 'Fixture private prompt'}], tools: [], ...extra});
// Observed on the real Codex 0.163.0-alpha.10.2 consumer against a loopback mock provider.
const headers = (thread = 'thread-a', turn: string | null = 'turn-a') => ({'thread-id': thread, 'session-id': thread,
  'x-codex-turn-metadata': JSON.stringify({thread_id: thread, session_id: thread, ...(turn ? {turn_id: turn} : {}), request_kind: 'turn'})});
const identity = (extra: Record<string, unknown> = {}, context = headers()) => attachStepIdentity(request(extra), context)!;
const duplicate = (error: unknown) => error instanceof BridgeError && error.status === 409 && error.code === 'api_duplicate_step'
  && /do not retry/i.test(error.message) && /replay/i.test(error.message);
const unavailable = (error: unknown) => error instanceof BridgeError && error.status === 503 && error.code === 'api_step_guard_unavailable';
async function fixture(t: TestContext) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'paid-step-guard-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  // macOS's system temporary directory can contain /var -> /private/var.
  const base = await fs.realpath(temp);
  return {base, root: path.join(base, 'claims')};
}

test('identical retries share a key, while separate chats and turns never collide', () => {
  const first = identity();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(identity(), first);
  assert.notEqual(identity({}, headers('thread-b')), first);
  assert.notEqual(identity({}, headers('thread-a', 'turn-b')), first);
  assert.notEqual(identity({input: [{role: 'user', content: 'Fixture private prompt'}, {role: 'assistant', content: 'Earlier answer'},
    {role: 'user', content: 'Fixture private prompt'}]}), first);
});

test('a thread without a turn ID still deduplicates exact ambiguous retries', () => {
  const first = identity({}, headers('thread-a', null));
  assert.equal(identity({}, headers('thread-a', null)), first);
  assert.notEqual(identity({}, headers('thread-b', null)), first);
});

test('all inference semantics affect identity while transport metadata and JSON key order do not', () => {
  const first = identity();
  for (const changed of [{model: 'claude-sdk-opus'}, {instructions: 'Different instruction'}, {input: 'Different prompt'},
    {tools: [{type: 'function', name: 'read', parameters: {type: 'object'}}]}, {reasoning: {effort: 'high'}},
    {tool_choice: 'none'}, {parallel_tool_calls: false}]) assert.notEqual(identity(changed), first);
  assert.equal(identity({stream: false, client_metadata: {trace_id: 'random'}, router_step_identity: 'injected',
    input: [{content: 'Fixture private prompt', role: 'user'}]}), first);
  assert.equal(identity({tool_choice: 'auto', parallel_tool_calls: true}), first);
});

test('router identity is internal and missing authenticated context fails closed', () => {
  const req = request({router_step_identity: 'injected', paid_step_identity: 'injected',
    client_metadata: {thread_id: 'injected', turn_id: 'injected'}});
  assert.equal(stepIdentity(req), null);
  assert.equal(attachStepIdentity(req, {}), null);
  const key = attachStepIdentity(req, headers());
  assert.ok(key);
  req.router_step_identity = 'changed';
  assert.equal(stepIdentity(req), key);
  assert.equal(stepIdentity(request({...req})), null, 'JSON cannot carry the internal identity');
});

test('authenticated HTTP context accepts observed header forms and rejects ambiguous contexts', () => {
  const req = request();
  const first = attachStepIdentity(req, headers());
  assert.ok(first);
  assert.equal(attachStepIdentity(request(), {'X-Codex-Turn-Metadata': headers()['x-codex-turn-metadata']}), first);
  assert.equal(attachStepIdentity(request(), {'session-id': 'thread-a'}), identity({}, headers('thread-a', null)));
  for (const context of [
    {'thread-id': ['a', 'b']}, {'thread-id': ' '}, {'x-codex-turn-metadata': '{bad'},
    {...headers(), 'thread-id': 'other'}, {...headers(), 'session-id': 'other'},
    {...headers(), 'x-codex-turn-metadata': JSON.stringify({thread_id: 'thread-a', turn_id: 17})},
  ]) assert.equal(attachStepIdentity(req, context), null);
  assert.equal(stepIdentity(req), null, 'a failed reattachment cannot leave an earlier valid identity behind');
});

test('only one concurrent claim succeeds across independent instances', async t => {
  const {root} = await fixture(t);
  const key = identity();
  const results = await Promise.allSettled(Array.from({length: 24}, () => new PaidStepGuard(root).claim(key)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(duplicate(result.reason));
  assert.equal((await fs.readdir(root)).length, 1);
});

test('completed and interrupted claims both block regeneration after a restart', async t => {
  const {root} = await fixture(t);
  const completed = identity(), interrupted = identity({}, headers('thread-a', 'turn-b'));
  const first = new PaidStepGuard(root);
  await first.claim(completed);
  await first.complete(completed);
  await first.claim(interrupted);
  const restarted = new PaidStepGuard(root);
  await assert.rejects(restarted.claim(completed), duplicate);
  await assert.rejects(restarted.claim(interrupted), duplicate);
  await restarted.claim(identity({}, headers('thread-b')));
});

test('persistent claim files are private and contain no prompt, context ID or credential', async t => {
  const {root} = await fixture(t);
  const key = identity({instructions: 'private instruction secret-token', input: 'private content'});
  await new PaidStepGuard(root).claim(key);
  assert.equal((await fs.stat(root)).mode & 0o077, 0);
  const names = await fs.readdir(root);
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^[a-f0-9]{64}\.claim$/);
  const file = path.join(root, names[0]!);
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.equal((await fs.readFile(file)).length, 0);
});

test('public, non-directory, or symlinked claim roots fail closed without changing their target', async t => {
  const {base} = await fixture(t);
  const publicRoot = path.join(base, 'public'); await fs.mkdir(publicRoot, {mode: 0o755}); await fs.chmod(publicRoot, 0o755);
  await assert.rejects(new PaidStepGuard(publicRoot).claim(identity()), unavailable);
  assert.deepEqual(await fs.readdir(publicRoot), []);
  const regular = path.join(base, 'regular'); await fs.writeFile(regular, 'unchanged', {mode: 0o600});
  await assert.rejects(new PaidStepGuard(regular).claim(identity()), unavailable);
  assert.equal(await fs.readFile(regular, 'utf8'), 'unchanged');
  const target = path.join(base, 'target'); await fs.mkdir(target, {mode: 0o700});
  const link = path.join(base, 'link'); await fs.symlink(target, link);
  await assert.rejects(new PaidStepGuard(link).claim(identity()), unavailable);
  await assert.rejects(new PaidStepGuard(path.join(link, 'nested')).claim(identity()), unavailable);
  assert.deepEqual(await fs.readdir(target), []);
});

test('an existing marker symlink is never followed or overwritten', async t => {
  const {base, root} = await fixture(t);
  await fs.mkdir(root, {mode: 0o700});
  const target = path.join(base, 'target'); await fs.writeFile(target, 'unchanged');
  const key = identity(); await fs.symlink(target, path.join(root, `${key}.claim`));
  await assert.rejects(new PaidStepGuard(root).claim(key), duplicate);
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
});

test('raw keys cannot become disk paths or persistent secret text', async t => {
  const {base, root} = await fixture(t);
  for (const key of ['../escape', 'secret-token', '', 'A'.repeat(64)]) await assert.rejects(new PaidStepGuard(root).claim(key), unavailable);
  assert.deepEqual(await fs.readdir(base), []);
});
