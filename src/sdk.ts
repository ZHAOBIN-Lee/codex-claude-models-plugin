import { query, type Options, type ModelUsage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { BridgeError, outputSchemaFor, preparePrompt, validateDecision, type ResponsesRequest, type RunStep, type Usage } from './contracts.js';
import { discoverCatalog, type ClaudeModel } from './catalog.js';

export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = {...source};
  for (const key of Object.keys(result)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$)/.test(key)) delete result[key];
  }
  result.CLAUDE_AGENT_SDK_CLIENT_APP = 'codex-claude-models/0.1.0';
  return result;
}

export function isolatedOptions(cwd: string): Options {
  return {
    cwd, env: subscriptionEnvironment(), tools: [], settingSources: [], strictMcpConfig: true,
    mcpServers: {}, plugins: [], persistSession: false, permissionMode: 'dontAsk', permissionPrompts: 'none',
    hooks: {PreToolUse: [{hooks: [async input => {
      if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'StructuredOutput') return {};
      return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Codex executes all tools.'}};
    }]}]},
  };
}

export function usageFromModels(models: Record<string, ModelUsage>): Usage {
  const rows = Object.values(models);
  const input = rows.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
  const output = rows.reduce((sum, m) => sum + m.outputTokens, 0);
  return {input_tokens: input, input_tokens_details: {cached_tokens: rows.reduce((sum, m) => sum + m.cacheReadInputTokens, 0)},
    output_tokens: output, output_tokens_details: {reasoning_tokens: rows.reduce((sum, m) => sum + (m.thinkingTokens ?? 0), 0)}, total_tokens: input + output};
}

export async function inspectSdk(cwd: string) {
  let release!: () => void;
  const idle = new Promise<void>(resolve => {release = resolve;});
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 30000);
  const session = query({prompt: (async function* () {await idle;})(), options: {...isolatedOptions(cwd), abortController}});
  try {
    const account = await session.accountInfo();
    const models = discoverCatalog(await session.supportedModels());
    return {authenticated: account.apiProvider === 'firstParty' && !!account.subscriptionType,
      subscriptionType: account.subscriptionType ?? null, models};
  } finally {clearTimeout(timer); release(); session.close();}
}

export function sdkRunner(cwd: string, models: ClaudeModel[], queryImpl: typeof query = query): RunStep {
  return async (request: ResponsesRequest, signal: AbortSignal) => {
    const model = models.find(m => m.id === request.model);
    if (!model) throw new BridgeError(400, 'unknown_model', 'Unknown Claude model. Run setup install to refresh the catalog.');
    const prepared = preparePrompt(request);
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    const effort = request.reasoning?.effort;
    const options: Options = {...isolatedOptions(cwd), model: model.sdkModel, systemPrompt: prepared.system,
      abortController, maxTurns: 3, outputFormat: {type: 'json_schema', schema: outputSchemaFor(request)},
      ...(effort && model.efforts.includes(effort) ? {effort: effort as Options['effort']} : {})};
    let session: ReturnType<typeof query> | undefined;
    let release!: () => void;
    const authenticated = new Promise<void>(resolve => {release = resolve;});
    let permitted = false;
    try {
      session = queryImpl({prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await authenticated;
        if (permitted && !signal.aborted) yield {type: 'user', session_id: '', parent_tool_use_id: null,
          message: {role: 'user', content: prepared.prompt}};
      })(), options});
      const account = await session.accountInfo();
      if (account.apiProvider !== 'firstParty' || !account.subscriptionType) {
        throw new BridgeError(401, 'subscription_required', 'A Claude subscription login is required. Run claude auth login. API-key fallback is disabled.');
      }
      permitted = true; release();
      for await (const message of session) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success' || message.is_error) {
          throw new BridgeError(502, 'claude_failed', `Claude SDK did not complete successfully (${message.subtype}). Check Claude login, usage limits and model access.`);
        }
        return {decision: validateDecision(message.structured_output, request), usage: usageFromModels(message.modelUsage)};
      }
      throw new BridgeError(502, 'incomplete_sdk', 'Claude SDK ended without a result.');
    } finally {release(); signal.removeEventListener('abort', abort); session?.close();}
  };
}
