import {BridgeError, type Usage} from './contracts.js';
import type {ClaudeModel} from './catalog.js';
import {safeModelId, safeSessionId} from './receipts.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const canonical = (model: string) => model.replace(/\[[0-9a-z]+\]$/, '');
const missing = () => new BridgeError(502, 'missing_context_usage',
  'Claude SDK returned no verifiable completed primary-request usage. The answer was withheld; aggregate query totals cannot be used as the current context.');
const usageKeys = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'output_tokens_details', 'iterations'];

export interface ContextUsage {model: string; source: 'message_stream'; usage: Usage}
interface Sample {
  id: string; model: string; session: string | null; raw: RecordValue;
  started: boolean; delta: boolean; stopped: boolean;
}

// Only usage metadata is retained. SDK assistant blocks carry placeholder output
// counts; message_delta is cumulative within ONE API response, and message_stop
// commits it. Neither blocks nor deltas nor separate API requests are summed.
export class ContextUsageTracker {
  private latest?: Sample;
  private active?: Sample;
  private seen = new Set<string>();
  constructor(private requested: ClaudeModel) {}

  private isPrimary(model: string) {
    const expected = this.requested.resolvedModel ?? this.requested.sdkModel;
    if (safeModelId(expected)) return canonical(model) === canonical(expected);
    const family = /^(sonnet|opus|haiku)(?:\[[0-9a-z]+\])?$/.exec(expected)?.[1];
    return !family || model.startsWith(`claude-${family}-`);
  }

  private identify(message: RecordValue, session: unknown): Sample | undefined {
    const model = safeModelId(message.model), id = message.id;
    if (!model || !this.isPrimary(model)) return;
    if (typeof id !== 'string' || !id.length || id.length > 128) throw missing();
    if (this.latest?.id === id) return this.latest;
    if (this.seen.has(id)) return; // A replay of an older block must not replace the latest context.
    if (this.seen.size >= 64) throw missing(); // Bounded even if the SDK violates maxTurns.
    this.seen.add(id);
    return this.latest = {id, model, session: safeSessionId(session), raw: {}, started: false, delta: false, stopped: false};
  }

  observe(frame: RecordValue) {
    if (frame.parent_tool_use_id !== null) return; // Subagents have their own context.
    if (frame.type === 'assistant' && record(frame.message)) {
      const sample = this.identify(frame.message, frame.session_id);
      if (sample && (frame.error || frame.aborted)) sample.stopped = false;
      return; // Never take the placeholder output count from an assistant block.
    }
    if (frame.type !== 'stream_event' || !record(frame.event)) return;
    const event = frame.event;
    if (event.type === 'message_start') {
      this.active = undefined;
      if (!record(event.message)) throw missing();
      const sample = this.identify(event.message, frame.session_id);
      if (!sample || sample.stopped) return;
      this.active = sample;
      if (sample.started) return; // Duplicate start: do not reset already received final counters.
      sample.started = true;
      if (record(event.message.usage)) for (const key of usageKeys) {
        if (key in event.message.usage) sample.raw[key] = event.message.usage[key];
      }
    } else if (this.active) {
      if (event.type === 'message_delta' && record(event.usage)) {
        for (const key of usageKeys) if (event.usage[key] != null) this.active.raw[key] = event.usage[key];
        if (event.usage.output_tokens != null) this.active.delta = true;
      } else if (event.type === 'message_stop') {
        this.active.stopped = true; this.active = undefined;
      }
    }
  }

  finish(final: RecordValue): ContextUsage {
    const sample = this.latest;
    if (!sample?.started || !sample.delta || !sample.stopped || sample.session !== safeSessionId(final.session_id)
      || !sample.session || !record(final.modelUsage)
      || !Object.keys(final.modelUsage).some(model => safeModelId(model) && canonical(model) === canonical(sample.model))) throw missing();
    let raw = sample.raw;
    // Messages API server-side loops can also aggregate usage. A compaction
    // operation's small counter is NOT the size of the context it closed.
    if (Array.isArray(raw.iterations) && raw.iterations.length) {
      const lastMessage = raw.iterations.findLast(item => record(item) && item.type === 'message');
      if (!record(lastMessage)) throw missing();
      // The pinned SDK's iteration rows have no model field. They belong to
      // this already verified primary stream; reject a conflicting field if
      // another SDK version supplies one, rather than requiring its presence.
      if ('model' in lastMessage && (!safeModelId(lastMessage.model)
        || canonical(lastMessage.model as string) !== canonical(sample.model))) throw missing();
      raw = lastMessage;
    }
    const input = raw.input_tokens, read = raw.cache_read_input_tokens ?? 0, created = raw.cache_creation_input_tokens ?? 0, output = raw.output_tokens;
    const thinking = record(raw.output_tokens_details) ? raw.output_tokens_details.thinking_tokens ?? 0 : 0;
    if (!counter(input) || !counter(read) || !counter(created) || !counter(output) || !counter(thinking) || thinking > output
      || !Number.isSafeInteger(input + read + created + output)) throw missing();
    return {model: sample.model, source: 'message_stream', usage: {
      input_tokens: input + read + created, input_tokens_details: {cached_tokens: read}, output_tokens: output,
      output_tokens_details: {reasoning_tokens: thinking}, total_tokens: input + read + created + output,
    }};
  }
}
