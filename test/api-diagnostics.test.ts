import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeApiDiagnostics} from '../src/api-diagnostics.js';

test('receipt diagnostics retain bounded identities and fixed stream labels only', () => {
  assert.deepEqual(safeApiDiagnostics({request_id: 'req_fixture', message_id: 'msg_fixture', actual_model: 'claude-sonnet-5-5',
    http_status: '429', stream_reason: 'unexpected_tool_use', stream_phase: 'event', stream_event: 'content_block_start',
    stream_block_index: '1', stream_block_type: 'tool_use', stream_delta_type: 'input_json_delta',
    prompt: 'secret prompt', body: 'secret body', thinking: 'secret thinking', message: 'secret error',
    input_tokens: '100', output_tokens: '10', cost_usd: '0.5', arbitrary: 'value', constructor: 'value'}),
  {request_id: 'req_fixture', message_id: 'msg_fixture', actual_model: 'claude-sonnet-5-5', http_status: '429',
    stream_reason: 'unexpected_tool_use', stream_phase: 'event', stream_event: 'content_block_start',
    stream_block_index: '1', stream_block_type: 'tool_use', stream_delta_type: 'input_json_delta'});
});

test('receipt diagnostics reject unrecognized labels, models, malformed identifiers and invalid indices', () => {
  for (const value of ['sensitive upstream text', 'unknown', '', 'a'.repeat(201), 1, null, {}, []]) {
    assert.deepEqual(safeApiDiagnostics({request_id: value, message_id: value, actual_model: value, http_status: value,
      stream_reason: value, stream_phase: value, stream_event: value, stream_block_index: value,
      stream_block_type: value, stream_delta_type: value}), {});
  }
  for (const index of ['-1', '1.5', '01', 'Infinity', 'NaN', '9007199254740992', '1e3']) {
    assert.deepEqual(safeApiDiagnostics({stream_block_index: index}), {});
  }
  assert.deepEqual(safeApiDiagnostics({actual_model: 'claude-secret-upstream', request_id: `req_${'x'.repeat(201)}`,
    message_id: 'msg_with\nnewline', http_status: '999'}), {});
  for (const value of [null, undefined, [], 'string', 123]) assert.deepEqual(safeApiDiagnostics(value), {});
});

test('receipt whitelist ignores inherited properties and returns a fresh object', () => {
  const input = Object.assign(Object.create({request_id: 'req_inherited', stream_reason: 'unexpected_tool_use'}),
    {message_id: 'msg_own', stream_block_index: '0'});
  assert.deepEqual(safeApiDiagnostics(input), {message_id: 'msg_own', stream_block_index: '0'});
  assert.notEqual(safeApiDiagnostics(input), input);
});


test('JSON diagnostics whitelist known stop reasons and bounded integer text block counts only', () => {
  for (const stop of ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']) {
    assert.deepEqual(safeApiDiagnostics({stream_stop_reason: stop, decision_text_blocks: 2, response_text: 'private answer'}),
      {stream_stop_reason: stop, decision_text_blocks: '2'});
  }
  assert.deepEqual(safeApiDiagnostics({decision_text_blocks: '0', stream_reason: 'missing_decision_text'}),
    {decision_text_blocks: '0', stream_reason: 'missing_decision_text'});
  for (const count of [-1, 1.5, NaN, Infinity, 1025, '1.5', '01', '-1', '', null, {}, []]) {
    assert.deepEqual(safeApiDiagnostics({stream_stop_reason: 'private answer', decision_text_blocks: count}), {});
  }
  for (const reason of ['unexpected_stop_reason', 'invalid_decision_json', 'invalid_decision']) {
    assert.deepEqual(safeApiDiagnostics({stream_reason: reason}), {stream_reason: reason});
  }
});


test('decision diagnostics retain only fixed rules, bounded tool keys and canonical integer counts', () => {
  for (const rule of ['unknown_tool', 'invalid_arguments', 'invalid_decision', 'tool_choice', 'parallel_calls', 'empty_decision']) {
    assert.deepEqual(safeApiDiagnostics({decision_rule: rule, decision_tool_kind: 'function', decision_tool: 'functions.lookup-1', decision_calls: 17,
      input: 'private-arguments', text: 'private-answer', reason: 'private-reason'}),
    {decision_rule: rule, decision_tool_kind: 'function', decision_tool: 'functions.lookup-1', decision_calls: '17'});
  }
  assert.deepEqual(safeApiDiagnostics({decision_tool_kind: 'custom', decision_calls: '0', decision_tool: 'x'.repeat(256)}),
    {decision_tool_kind: 'custom', decision_calls: '0', decision_tool: 'x'.repeat(256)});
  for (const value of ['private text', '', 'x'.repeat(257), 'bad\nkey', 'bad/key', 'bad:key', 1, null, {}, []]) {
    assert.deepEqual(safeApiDiagnostics({decision_rule: value, decision_tool_kind: value, decision_tool: value}), {});
  }
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '-1', '1.5', '01', '1e3', '9007199254740992', '', null, {}, []]) {
    assert.deepEqual(safeApiDiagnostics({decision_calls: value}), {});
  }
});
