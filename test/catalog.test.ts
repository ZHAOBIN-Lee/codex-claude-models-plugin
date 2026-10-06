import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { combinedCatalog, codexCatalog, discoverCatalog } from '../src/catalog.js';

const sonnet: ModelInfo = {
  value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5',
  description: 'Fixture from the pinned SDK discovery result', supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true, supportsAutoMode: true,
};

test('a discovered Sonnet alias admits the measured desktop prefix without compacting every short turn', () => {
  const catalog = codexCatalog(discoverCatalog([sonnet])).models[0]!;
  // Actual native short-chat totals, including cached input and output. These
  // are per-request measurements, not totals from the whole conversation.
  for (const lastTurnTokens of [392674, 463027, 464859, 465472]) {
    assert.ok(lastTurnTokens < catalog.auto_compact_token_limit,
      `a short native request (${lastTurnTokens}) must fit below the compaction trigger`);
  }
  assert.ok(catalog.auto_compact_token_limit < catalog.context_window * catalog.effective_context_window_percent / 100,
    'compaction must remain enabled before the effective window is full');
  assert.ok(catalog.context_window <= 1000000, 'do not advertise more than the observed SDK model capacity');
});

test('an alias resolving to another or unknown model never inherits the verified Sonnet capacity', () => {
  for (const resolvedModel of [undefined, 'claude-sonnet-4-6', 'claude-sonnet-5-6', 'unverified-model', 'constructor', '__proto__']) {
    const catalog = codexCatalog(discoverCatalog([{...sonnet, resolvedModel}])).models[0]!;
    assert.ok(catalog.context_window <= 200000,
      `unverified resolution ${resolvedModel} cannot be assigned a million-token window`);
  }
});

test('an explicit verified model ID works without an alias and leaves GPT budgets unchanged', () => {
  const claude = discoverCatalog([{...sonnet, value: 'claude-sonnet-5-5', resolvedModel: undefined}]);
  const original = {slug: 'gpt-fixture', priority: 7, context_window: 400000,
    auto_compact_token_limit: 300000, effective_context_window_percent: 95};
  const catalog = combinedCatalog({models: [original]}, claude);
  assert.deepEqual(catalog.models[0], {...original, multi_agent_version: 'v1'});
  const model = catalog.models[1] as ReturnType<typeof codexCatalog>['models'][number];
  assert.ok(465472 < model.auto_compact_token_limit, 'the explicit verified model also admits the measured prefix');
});
