import {apiInferenceGeography} from './api-pricing.js';

const STREAM_REASONS = [
  'missing_stream_body', 'invalid_content_type', 'body_read_error', 'invalid_utf8', 'invalid_event_json', 'invalid_event_shape',
  'event_after_stop', 'duplicate_message_start', 'invalid_message_start', 'model_mismatch', 'message_not_started',
  'invalid_block_index', 'nonsequential_block_index', 'invalid_block_start', 'overlapping_blocks', 'block_after_final_usage',
  'refusal_block', 'unsupported_block_type', 'unexpected_tool_use',
  // Preserve diagnostics from historical tool-transport receipts. New streams never emit these reasons.
  'unexpected_tool_name', 'multiple_decisions', 'invalid_tool_input', 'missing_decision',
  'unknown_block_index', 'delta_after_block_stop', 'invalid_delta', 'delta_after_final_usage', 'refusal_delta', 'invalid_delta_type',
  'duplicate_block_stop', 'block_stop_after_final_usage', 'open_block_at_message_delta', 'invalid_final_usage',
  'missing_final_usage', 'open_block_at_message_stop', 'stream_error', 'frame_size_limit', 'stream_size_limit', 'decision_size_limit',
  'incomplete_stream', 'output_truncated', 'refusal', 'missing_decision_text', 'unexpected_stop_reason', 'invalid_decision_json', 'invalid_decision',
  'invalid_usage', 'unexpected_billing', 'cancelled', 'processing_error',
] as const;
export type ApiStreamReason = typeof STREAM_REASONS[number];
export type ApiStreamPhase = 'response' | 'read' | 'decode' | 'frame' | 'event' | 'validation';
const allowed: Record<string, ReadonlySet<string>> = {
  stream_reason: new Set(STREAM_REASONS),
  decision_rule: new Set(['unknown_tool', 'invalid_arguments', 'invalid_decision', 'tool_choice', 'parallel_calls', 'empty_decision']),
  decision_tool_kind: new Set(['function', 'custom']),
  stream_stop_reason: new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']),
  stream_phase: new Set(['response', 'read', 'decode', 'frame', 'event', 'validation']),
  stream_event: new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']),
  stream_block_type: new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'refusal', 'server_tool_use']),
  stream_delta_type: new Set(['text_delta', 'thinking_delta', 'signature_delta', 'input_json_delta', 'refusal_delta']),
};

// Reapply this whitelist at the receipt boundary. No upstream text, partial usage, or arbitrary object fields may pass.
export function safeApiDiagnostics(details: unknown): Record<string, string> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    // BridgeError details are strings; accept canonical serialized counts again at the receipt boundary.
    if (key === 'decision_text_blocks' && ((typeof value === 'number' && Number.isInteger(value))
        || (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,3})$/.test(value)))
        && Number(value) >= 0 && Number(value) <= 1024) {
      safe[key] = String(value);
      continue;
    }
    if (key === 'decision_calls' && ((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))))) {
      safe[key] = String(value);
      continue;
    }
    if (typeof value !== 'string') continue;
    if ((Object.hasOwn(allowed, key) && allowed[key]!.has(value))
      || (key === 'decision_tool' && /^[A-Za-z0-9_.-]{1,256}$/.test(value))
      || (key === 'request_id' && /^req_[A-Za-z0-9_-]{1,200}$/.test(value))
      || (key === 'message_id' && /^msg_[A-Za-z0-9_-]{1,200}$/.test(value))
      || (key === 'actual_model' && apiInferenceGeography(value) !== undefined)
      || (key === 'http_status' && /^[1-5][0-9]{2}$/.test(value))
      || (key === 'stream_block_index' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)))) {
      safe[key] = value;
    }
  }
  return safe;
}
