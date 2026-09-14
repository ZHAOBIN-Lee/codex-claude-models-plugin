import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const openaiCatalogSchema = z.object({models: z.array(z.object({
  slug: z.string().min(1), priority: z.number().optional(),
}).passthrough()).min(1)}).passthrough();
export type OpenAICatalog = z.infer<typeof openaiCatalogSchema>;

export interface ClaudeModel { id: string; sdkModel: string; displayName: string; description: string; efforts: string[] }
export function discoverCatalog(models: ModelInfo[]): ClaudeModel[] {
  return models.filter(m => m.value !== 'default').map(m => ({
    id: `claude-sdk-${m.value.replaceAll(/[^a-zA-Z0-9-]/g, '-').replaceAll(/-+$/g, '')}`,
    sdkModel: m.value, displayName: `Claude Agent · ${m.displayName}`,
    description: m.description, efforts: m.supportedEffortLevels ?? [],
  }));
}
export function combinedCatalog(openai: OpenAICatalog, claude: ClaudeModel[]) {
  const original = openai.models.filter(m => !m.slug.startsWith('claude-sdk-'));
  const seen = new Set<string>();
  for (const m of original) {
    if (seen.has(m.slug)) throw new Error(`Duplicate model in OpenAI catalog: ${m.slug}`);
    seen.add(m.slug);
  }
  const priority = Math.max(0, ...original.map(m => m.priority ?? 0)) + 1;
  // v2 encrypts inter-agent payloads for OpenAI. Native v1 messages are portable
  // between providers; use one runtime for every model in the combined catalog.
  return {models: [...original, ...codexCatalog(claude).models.map((m, i) => ({...m, priority: priority + i}))]
    .map(m => ({...m, multi_agent_version: 'v1'}))};
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
