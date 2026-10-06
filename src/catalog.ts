import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const openaiCatalogSchema = z.object({models: z.array(z.object({
  slug: z.string().min(1), priority: z.number().optional(),
}).passthrough()).min(1)}).passthrough();
export type OpenAICatalog = z.infer<typeof openaiCatalogSchema>;

export interface ClaudeModel { id: string; sdkModel: string; resolvedModel?: string; displayName: string; description: string; efforts: string[] }
export function discoverCatalog(models: ModelInfo[]): ClaudeModel[] {
  return models.filter(m => m.value !== 'default').map(m => ({
    id: `claude-sdk-${m.value.replaceAll(/[^a-zA-Z0-9-]/g, '-').replaceAll(/-+$/g, '')}`,
    sdkModel: m.value, displayName: `Claude Agent · ${m.displayName}`,
    ...(m.resolvedModel ? {resolvedModel: m.resolvedModel} : {}),
    description: m.description, efforts: m.supportedEffortLevels ?? [],
  }));
}

// Verified from final ModelUsage.contextWindow on SDK 0.3.270 / CLI 2.1.285.
// Match canonical IDs exactly: discovery aliases and display names do not prove
// another model's capacity. Unverified resolutions retain the adapter fallback.
// Opus, Fable and the 4.x models were read from the same field on 2026-10-06 with one tiny request each.
const verifiedContextWindows: ReadonlyMap<string, number> = new Map([
  ...['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5',
    'claude-opus-4-8', 'claude-opus-4-7'].map(id => [id, 1000000] as const),
  ...['claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-sonnet-4-6'].map(id => [id, 200000] as const),
]);
// Every current Claude model has at least 200k. A smaller fallback made Codex compact after every step on a new model.
export const FALLBACK_CONTEXT_WINDOW = 200000;
// A context suffix such as [1m] names the same model; it must not hide a verified window.
const canonicalModel = (id: string) => id.replace(/\[[0-9a-z]+\]$/i, '');
export function verifiedContextWindow(model: ClaudeModel): number | undefined {
  return verifiedContextWindows.get(canonicalModel(model.resolvedModel ?? model.sdkModel));
}
function contextBudget(model: ClaudeModel) {
  const contextWindow = verifiedContextWindow(model) ?? FALLBACK_CONTEXT_WINDOW;
  return {context_window: contextWindow, auto_compact_token_limit: Math.floor(contextWindow * 0.75),
    effective_context_window_percent: 90};
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
    // Without deferred tools the full connector/MCP schema list exceeded 390k tokens per step and a
    // 96k trigger compacted after every step. supports_search_tool makes Codex defer those schemas
    // behind a client-executed tool_search (about 34 KB of tools instead of about 1 MB).
    ...contextBudget(m),
    experimental_supported_tools: [], input_modalities: ['text', 'image'], supports_reasoning_summary_parameter: false,
    supports_search_tool: true, include_skills_usage_instructions: true, include_plugin_usage_instructions: true,
    multi_agent_version: 'v2',
  }))};
}
