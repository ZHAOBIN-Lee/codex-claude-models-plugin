import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeModel { id: string; sdkModel: string; displayName: string; description: string; efforts: string[] }
export function discoverCatalog(models: ModelInfo[]): ClaudeModel[] {
  return models.filter(m => m.value !== 'default').map(m => ({
    id: `claude-sdk-${m.value.replaceAll(/[^a-zA-Z0-9-]/g, '-').replaceAll(/-+$/g, '')}`,
    sdkModel: m.value, displayName: `Claude Agent · ${m.displayName}`,
    description: m.description, efforts: m.supportedEffortLevels ?? [],
  }));
}
export function codexCatalog(models: ClaudeModel[]) {
  return {models: models.map((m, i) => ({
    slug: m.id, display_name: m.displayName, description: `${m.description} · Claude Agent SDK`,
    default_reasoning_level: m.efforts.includes('medium') ? 'medium' : 'none',
    supported_reasoning_levels: (m.efforts.length ? m.efforts : ['none']).map(effort => ({effort, description: `${effort} effort`})),
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: i,
    base_instructions: 'You are a coding assistant in Codex. Follow the user and developer instructions. Use the provided Codex tools to inspect, edit and verify work. Never claim an action happened without its tool result.',
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', truncation_policy: {mode: 'bytes', limit: 20000},
    // Conservative adapter input budget; not a claim about the model's maximum context.
    context_window: 128000, auto_compact_token_limit: 96000, effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: ['text'], supports_reasoning_summary_parameter: false,
    supports_search_tool: false, include_skills_usage_instructions: true, include_plugin_usage_instructions: true,
    multi_agent_version: 'v2',
  }))};
}
