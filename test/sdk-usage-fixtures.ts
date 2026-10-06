// Messages API events at the SDK boundary. No server, login or inference.
export const USAGE_MODEL = 'claude-sonnet-5-5';
export const USAGE_SESSION = '3f2b8c1e-5a47-4d0e-9b6a-1c7e2d4f8a90';
export type Frame = Record<string, any>;
export function usageEvent(event: Frame, parent: string | null = null): Frame {
  return {type: 'stream_event', event, parent_tool_use_id: parent,
    session_id: USAGE_SESSION, uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84'};
}
export function usageStart(id: string, usage: Frame, model = USAGE_MODEL, parent: string | null = null) {
  return usageEvent({type: 'message_start', message: {id, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage}}, parent);
}
export function usageDelta(usage: Frame, parent: string | null = null) {
  return usageEvent({type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage}, parent);
}
export function usageStop(parent: string | null = null) {return usageEvent({type: 'message_stop'}, parent);}
export function assistantPlaceholder(id: string, usage: Frame, model = USAGE_MODEL, parent: string | null = null): Frame {
  return {type: 'assistant', parent_tool_use_id: parent, session_id: USAGE_SESSION,
    uuid: '6a0f3c52-8d14-4b7e-a3c9-2e5f7b1d9c84', message: {id, type: 'message', role: 'assistant', model,
      content: [{type: 'text', text: 'unpersisted fixture content'}], stop_reason: null, stop_sequence: null, usage}};
}
export function usageStream(id: string, usage: Frame, model = USAGE_MODEL, parent: string | null = null): Frame[] {
  const initial = {...usage, output_tokens: 1};
  return [usageStart(id, initial, model, parent), assistantPlaceholder(id, initial, model, parent),
    usageDelta({...usage, iterations: usage.iterations ?? [{type: 'message', ...usage}]}, parent), usageStop(parent)];
}
