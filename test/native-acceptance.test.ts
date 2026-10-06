import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError } from '../src/contracts.js';
import { analyzeItems, classifyReadonly, compactionTerminal, failureCode, firstCompactionTerminal, isNormalCodexHome, observeSentinels, parseArgs, RpcError, safeEvent, summarizeReceipt, usage } from '../scripts/native-acceptance.js';

// Offline tests of the harness's pure helpers only. Nothing here starts an SDK, a Codex process or any account request.

test('without --live the harness only shows usage and is not an executable request', () => {
  const none = parseArgs([]);
  assert.equal(none.live, false);
  assert.deepEqual(none.errors, []);
  assert.match(usage(), /performs NO inference/);
  assert.equal(parseArgs(['--codex-home', '/tmp/x', '--report', '/tmp/r.json']).live, false);
});

test('arguments are strict: known cases only, values required, one case per invocation', () => {
  const ok = parseArgs(['--live', '--codex-home', '/tmp/h', '--report', '/tmp/r.json', '--case', 'cancel']);
  assert.deepEqual({live: ok.live, home: ok.codexHome, report: ok.report, caseName: ok.caseName, errors: ok.errors},
    {live: true, home: '/tmp/h', report: '/tmp/r.json', caseName: 'cancel', errors: []});
  assert.equal(parseArgs(['--live']).caseName, 'readwrite');
  assert.ok(parseArgs(['--live', '--case', 'everything']).errors.length > 0);
  assert.ok(parseArgs(['--live', '--codex-home']).errors.length > 0);
  assert.ok(parseArgs(['--live', '--codex-home', '--report', 'x']).errors.length > 0);
  assert.ok(parseArgs(['--live', '--bogus']).errors.length > 0);
});

test('the normal Codex home, the user home and their ancestors are refused', () => {
  const options = {home: '/Users/someone', envCodexHome: '/Users/someone/.codex'};
  for (const refused of ['/Users/someone/.codex', '/Users/someone/.codex/', '/Users/someone', '/Users', '/', '/Users/someone/.codex/claude-models']) {
    assert.equal(isNormalCodexHome(refused, options), true, refused);
  }
  for (const allowed of ['/tmp/isolated-policy-home', '/Users/someone/private/accept-home', '/private/var/folders/x/accept']) {
    assert.equal(isNormalCodexHome(allowed, options), false, allowed);
  }
  assert.equal(isNormalCodexHome('/srv/custom-codex', {home: '/Users/someone', envCodexHome: '/srv/custom-codex'}), true);
});

test('safe events keep structure only and drop every content field', () => {
  const event = safeEvent('item/completed', {threadId: 't', item: {type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'cat secret.txt', aggregatedOutput: 'TOP-SECRET-OUTPUT', text: 'TOP-SECRET-TEXT'}});
  assert.deepEqual(event, {method: 'item/completed', item_type: 'commandExecution', item_status: 'completed', exit_code: 0});
  assert.ok(!JSON.stringify(event).includes('SECRET'));
  assert.deepEqual(safeEvent('turn/completed', {turn: {status: 'interrupted', error: {message: 'a token inside'}}}),
    {method: 'turn/completed', turn_status: 'interrupted', turn_error: true});
  assert.deepEqual(safeEvent({bad: 'method'}, {item: {type: 'has spaces and \n newline'}}), {method: 'unknown'});
});

test('item analysis separates tool output from command text and flags recursion without keeping content', () => {
  const registry = {fixture: 'FIXTURE_abc', changed: 'CHANGED_abc'};
  const notices = [
    {method: 'item/started', at: 10, params: {item: {type: 'commandExecution', command: 'cat fixture.txt'}}},
    {method: 'item/completed', at: 20, params: {item: {type: 'commandExecution', status: 'completed', exitCode: 0, command: 'echo CHANGED_abc', aggregatedOutput: 'FIXTURE_abc\n'}}},
    {method: 'item/completed', at: 30, params: {item: {type: 'commandExecution', status: 'completed', exitCode: 0, command: 'node bridge.mjs', aggregatedOutput: ''}}},
    {method: 'item/completed', at: 40, params: {item: {type: 'agentMessage', text: 'It says FIXTURE_abc'}}},
  ];
  const result = analyzeItems(notices, registry);
  assert.equal(result.toolStarted, 1);
  assert.equal(result.firstToolAt, 10);
  assert.deepEqual(result.completed.map(item => item.output_sentinels), [['fixture'], []]);
  assert.deepEqual(result.completed.map(item => item.suspicious_command), [false, true]);
  assert.deepEqual(observeSentinels(result.agentText, registry), ['fixture']);
});

test('read-only classification never treats a refusal as sandbox proof', () => {
  assert.deepEqual(classifyReadonly({toolStarted: 0, completed: [], fileChanged: false}), {result: 'refused_without_tool', status: 'inconclusive'});
  assert.deepEqual(classifyReadonly({toolStarted: 1, completed: [{status: 'failed', exit_code: 1, denial_text: true}], fileChanged: false}), {result: 'sandbox_denied', status: 'pass'});
  assert.equal(classifyReadonly({toolStarted: 1, completed: [{status: 'failed', exit_code: 1, denial_text: false}], fileChanged: false}).status, 'inconclusive');
  assert.equal(classifyReadonly({toolStarted: 1, completed: [{status: 'declined', exit_code: null, denial_text: false}], fileChanged: false}).result, 'declined_before_execution');
  assert.equal(classifyReadonly({toolStarted: 1, completed: [{status: 'completed', exit_code: 0, denial_text: false}], fileChanged: true}).status, 'fail');
});

test('failures are reported by code only and receipts are reduced to metadata', () => {
  assert.equal(failureCode(new BridgeError(503, 'runtime_blocked', 'contains a token sk-test-secret')), 'bridge:runtime_blocked');
  assert.equal(failureCode(new RpcError('error_response', -32600, 'other')), 'rpc:error_response:-32600');
  assert.equal(failureCode(Object.assign(new Error('path /home/x/secret'), {code: 'ENOENT'})), 'errno:ENOENT');
  assert.ok(!failureCode(new Error('token=abc123')).includes('abc123'));

  const summary = summarizeReceipt({status: 'complete', code: 'success', inference_stage: 'final_received', actual_models: ['claude-sonnet-5-5', '[REDACTED SECRET]'],
    sdk_session_id: '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90', wall_ms: 12, usage: {total_tokens: 15}, prompt: 'must never be copied', email: 'a@b.invalid'});
  assert.deepEqual(summary.actual_models, ['claude-sonnet-5-5']);
  assert.equal(summary.sdk_session_id, '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90');
  assert.equal(summary.total_tokens, 15);
  assert.ok(!JSON.stringify(summary).includes('must never be copied') && !JSON.stringify(summary).includes('a@b.invalid'));
  assert.equal(summarizeReceipt({sdk_session_id: 'opaque-secret-token-123'}).sdk_session_id, null);
});

test('receipt summaries reuse the core validators: context suffixes survive, non-UUID sessions and non-Claude models are dropped', () => {
  const session = '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90';
  const kept = summarizeReceipt({actual_models: ['claude-sonnet-5-5[1m]', 'claude-haiku-4-5-20251001'], sdk_session_id: session.toUpperCase()});
  assert.deepEqual(kept.actual_models, ['claude-sonnet-5-5[1m]', 'claude-haiku-4-5-20251001']);
  assert.equal(kept.sdk_session_id, session.toUpperCase());

  const dropped = summarizeReceipt({actual_models: ['[REDACTED]', 'sonnet', 'not-a-claude-model-id', 'claude-sonnet-5-5[1m', 42, null, 'claude-' + 'x'.repeat(80)],
    sdk_session_id: 'a'.repeat(36)});
  assert.deepEqual(dropped.actual_models, []);
  assert.equal(dropped.sdk_session_id, null);
  for (const invalid of ['-'.repeat(36), '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a9', '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90x', undefined, 7]) {
    assert.equal(summarizeReceipt({sdk_session_id: invalid}).sdk_session_id, null, String(invalid));
  }
});

test('compaction is complete only on an explicit terminal notice for the same thread', () => {
  const thread = 'thread-a', other = 'thread-b';
  const item = (method: string, threadId: string, type: string, status?: string) => ({method, params: {threadId, item: {type, ...(status ? {status} : {})}}});
  const turn = (method: string, threadId: string, status?: string) => ({method, params: {threadId, turn: {id: 't1', ...(status ? {status} : {})}}});

  // Progress is never completion, whatever it is called.
  const progress = [
    item('item/started', thread, 'contextCompaction'), turn('turn/started', thread, 'inProgress'), {method: 'thread/compact/started', params: {threadId: thread}},
    {method: 'thread/compact/progress', params: {threadId: thread}}, item('item/completed', thread, 'agentMessage', 'completed'), turn('turn/completed', thread, 'inProgress'),
    {method: 'item/agentMessage/delta', params: {threadId: thread}},
  ];
  for (const notice of progress) assert.equal(compactionTerminal(notice, thread), undefined, notice.method);
  assert.equal(firstCompactionTerminal(progress, thread), undefined, 'started-only streams stay pending');

  // Events of another thread never decide this thread's outcome, success or failure.
  for (const notice of [item('item/completed', other, 'contextCompaction', 'completed'), turn('turn/completed', other, 'completed'), turn('turn/completed', other, 'failed'),
    {method: 'thread/compacted', params: {threadId: other}}, {method: 'error', params: {threadId: other, error: {}}}]) {
    assert.equal(compactionTerminal(notice, thread), undefined, `${notice.method} from another thread`);
  }
  assert.equal(compactionTerminal({method: 'thread/compacted', params: {}}, thread), undefined, 'an unattributed completion is not success');

  // Explicit terminal states, each distinct.
  assert.deepEqual(compactionTerminal(item('item/completed', thread, 'contextCompaction', 'completed'), thread), {state: 'completed', source: 'item_completed'});
  assert.deepEqual(compactionTerminal(item('item/completed', thread, 'contextCompaction'), thread), {state: 'completed', source: 'item_completed'});
  assert.deepEqual(compactionTerminal({method: 'thread/compacted', params: {threadId: thread}}, thread), {state: 'completed', source: 'thread_compacted'});
  assert.deepEqual(compactionTerminal(turn('turn/completed', thread, 'completed'), thread), {state: 'completed', source: 'turn_completed'});
  assert.deepEqual(compactionTerminal(turn('turn/completed', thread, 'failed'), thread), {state: 'failed', source: 'turn_completed'});
  assert.deepEqual(compactionTerminal(turn('turn/completed', thread, 'interrupted'), thread), {state: 'interrupted', source: 'turn_completed'});
  assert.deepEqual(compactionTerminal(item('item/completed', thread, 'contextCompaction', 'failed'), thread), {state: 'failed', source: 'item_completed'});
  assert.deepEqual(compactionTerminal({method: 'error', params: {threadId: thread, error: {message: 'x'}}}, thread), {state: 'failed', source: 'error'});
  assert.deepEqual(compactionTerminal({method: 'error', params: {error: {}}}, thread), {state: 'failed', source: 'error'});
  assert.equal(compactionTerminal({method: 'error', params: {threadId: thread, willRetry: true}}, thread), undefined, 'an error that will be retried is not final');
});

test('the first terminal notice wins and failure is never upgraded to success', () => {
  const thread = 'thread-a';
  const started = {method: 'item/started', params: {threadId: thread, item: {type: 'contextCompaction'}}};
  const failed = {method: 'error', params: {threadId: thread, error: {}}};
  const completed = {method: 'item/completed', params: {threadId: thread, item: {type: 'contextCompaction', status: 'completed'}}};
  assert.deepEqual(firstCompactionTerminal([started, failed, completed], thread), {state: 'failed', source: 'error'});
  assert.deepEqual(firstCompactionTerminal([started, completed, failed], thread), {state: 'completed', source: 'item_completed'});
  assert.equal(firstCompactionTerminal([], thread), undefined);
});
