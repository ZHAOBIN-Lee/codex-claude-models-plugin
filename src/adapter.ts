import { randomUUID } from 'node:crypto';
import { offeredTools, type ResponsesRequest, type StepResult } from './contracts.js';

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export function responseEnvelope(model: string) {
  return {id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), model,
    status: 'in_progress', output: [] as Record<string, unknown>[], error: null as unknown, usage: null as unknown};
}

export function completedResponse(base: ReturnType<typeof responseEnvelope>, request: ResponsesRequest, result: StepResult) {
  const output: Record<string, unknown>[] = [];
  if (result.decision.text) output.push({
    id: id('msg'), type: 'message', role: 'assistant', status: 'completed',
    phase: result.decision.calls.length ? 'commentary' : 'final_answer',
    content: [{type: 'output_text', text: result.decision.text, annotations: [], logprobs: []}],
  });
  const tools = offeredTools(request.tools);
  for (const call of result.decision.calls) {
    const tool = tools.find(t => t.key === call.name)!;
    output.push({id: id(call.kind === 'function' ? 'fc' : 'ctc'), type: call.kind === 'function' ? 'function_call' : 'custom_tool_call',
      call_id: id('call'), name: tool.name, ...(tool.namespace ? {namespace: tool.namespace} : {}), status: 'completed',
      [call.kind === 'function' ? 'arguments' : 'input']: call.input});
  }
  return {...base, status: 'completed', output, usage: result.usage};
}

export function* completionEvents(response: ReturnType<typeof completedResponse>): Generator<Record<string, unknown>> {
  for (const [index, item] of response.output.entries()) {
    yield {type: 'response.output_item.added', output_index: index, item: {...item, status: 'in_progress',
      ...(item.type === 'message' ? {content: []} : item.type === 'function_call' ? {arguments: ''} : {input: ''})}};
    if (item.type === 'message') {
      const part = (item.content as {text: string}[])[0]!;
      const fields = {item_id: item.id, output_index: index, content_index: 0};
      yield {type: 'response.content_part.added', ...fields, part: {...part, text: ''}};
      yield {type: 'response.output_text.delta', ...fields, delta: part.text};
      yield {type: 'response.output_text.done', ...fields, text: part.text};
      yield {type: 'response.content_part.done', ...fields, part};
    } else {
      const functionCall = item.type === 'function_call';
      const prefix = functionCall ? 'response.function_call_arguments' : 'response.custom_tool_call_input';
      const fields = {item_id: item.id, output_index: index};
      yield {type: `${prefix}.delta`, ...fields, delta: item[functionCall ? 'arguments' : 'input']};
      yield {type: `${prefix}.done`, ...fields, [functionCall ? 'arguments' : 'input']: item[functionCall ? 'arguments' : 'input']};
    }
    yield {type: 'response.output_item.done', output_index: index, item};
  }
  yield {type: 'response.completed', response};
}
