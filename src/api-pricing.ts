// USD per million tokens; verified against the official pricing page on 2026-10-18.
// Unknown models fail closed. Update this table before enabling a newly published model.
export interface ApiTokenRates {input: number; output: number; cacheRead?: number}
export interface ApiPrice extends ApiTokenRates {
  // Base rates reserve the maximum price. Settlement selects the short tier from final whole-prompt usage.
  shortContext?: ApiTokenRates & {maxInputTokens: number};
}
export const API_PRICES: Record<string, ApiPrice> = {
  'claude-sonnet-5-5': {input: 2, output: 10, cacheRead: 0.1},
  'claude-opus-5-5': {input: 4, output: 20, cacheRead: 0.2},
  'claude-haiku-5-5': {input: 0.5, output: 2.5, cacheRead: 0.05,
    shortContext: {maxInputTokens: 100000, input: 0.1, output: 0.5, cacheRead: 0.01}},
  'claude-fable-5-1': {input: 10, output: 50, cacheRead: 0.25},
  'claude-fable-5': {input: 10, output: 50, cacheRead: 1},
  'claude-opus-5': {input: 5, output: 25, cacheRead: 0.5},
  'claude-sonnet-5': {input: 2, output: 10, cacheRead: 0.2},
  'claude-opus-4-8': {input: 5, output: 25, cacheRead: 0.5},
  'claude-opus-4-7': {input: 5, output: 25, cacheRead: 0.5},
  'claude-opus-4-6': {input: 5, output: 25, cacheRead: 0.5},
  'claude-opus-4-5-20251101': {input: 5, output: 25, cacheRead: 0.5},
  'claude-sonnet-4-6': {input: 3, output: 15, cacheRead: 0.3},
  'claude-haiku-4-5-20251001': {input: 1, output: 5, cacheRead: 0.1},
};

export function apiPriceForUsage(price: ApiPrice, totalInputTokens: number): ApiTokenRates {
  return price.shortContext && totalInputTokens <= price.shortContext.maxInputTokens ? price.shortContext : price;
}

export type ApiInferenceGeography = 'global' | 'legacy';
// Exact models checked against official data-residency pricing on 2026-10-18.
// 4.6+ accept an explicit global route; 4.5 reject the parameter and always use standard pricing.
const GLOBAL_INFERENCE_MODELS = new Set([
  'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5',
  'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
]);
const LEGACY_INFERENCE_MODELS = new Set(['claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001']);
export function apiInferenceGeography(model: string): ApiInferenceGeography | undefined {
  return GLOBAL_INFERENCE_MODELS.has(model) ? 'global' : LEGACY_INFERENCE_MODELS.has(model) ? 'legacy' : undefined;
}
