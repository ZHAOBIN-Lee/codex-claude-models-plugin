import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeError, isCompactionRequest, type RunStep} from './contracts.js';
import type {ClaudeModel} from './catalog.js';
import {createApiRunner, type ApiStepResult} from './api-runner.js';
import {safeApiDiagnostics} from './api-diagnostics.js';
import {API_PRICES} from './api-pricing.js';
import {loadApiConfig, readApiCredentials, writeApiPrivate, withApiSendPermit, type ApiConfig} from './api-settings.js';
import {FallbackStore} from './fallback-store.js';
import {PaidStepGuard, stepIdentity} from './paid-step-guard.js';
import {SubscriptionQuotaError} from './subscription-limits.js';
import {safeCode} from './receipts.js';
import {subscriptionResultAccount} from './sdk.js';

export interface FallbackOptions {
  root: string;
  models: ClaudeModel[];
  subscription: RunStep;
  account: (signal: AbortSignal) => Promise<string | null>;
  resultAccount?: typeof subscriptionResultAccount;
  api?: (config: ApiConfig) => ReturnType<typeof createApiRunner>;
}
function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof BridgeError && signal.reason.status !== 502 ? signal.reason
    : new BridgeError(499, 'cancelled', 'The Claude request was cancelled.');
}
// Optional API state must never make a healthy subscription unusable. Once a paid path is entered, every
// error is explicit and non-502 so server.ts cannot repeat it through its subscription compaction retry.
function paidError(error: unknown): BridgeError {
  if (error instanceof BridgeError && error.status !== 502) return error;
  return new BridgeError(424, 'api_fallback_failed', 'The API fallback did not complete. No automatic paid retry was made; check the private receipt and budget status.');
}
export function fallbackRunner(options: FallbackOptions): RunStep {
  const store = new FallbackStore(options.root), guard = new PaidStepGuard(path.join(options.root, 'paid-steps'));
  const api = options.api ?? (config => createApiRunner({credentials: () => readApiCredentials(options.root),
    maxOutputTokens: config.maxOutputTokens, cache: config.cache, prices: API_PRICES}));
  return async (request, signal, progress) => {
    const started = Date.now();
    cancelled(signal);
    let config: ApiConfig | null = null, optionalError: unknown;
    try {config = await loadApiConfig(options.root);} catch (error) {optionalError = error;}
    let account: string | null = null, probeId: string | undefined, route: 'subscription' | 'api' = 'subscription';
    if (config) {
      try {
        account = await options.account(signal);
        if (account && account === config.confirmedSubscriptionAccount) {
          const selected = await store.route(account, request.model); route = selected.route; probeId = selected.probeId;
        }
      } catch (error) {optionalError = error;}
    }
    let reason = 'persisted_subscription_quota';
    if (route === 'subscription') {
      try {
        // Cancellation can arrive while route() persists a probe lease. Keep this check inside
        // the release path so an unstarted probe cannot divert later requests to paid inference.
        cancelled(signal);
        const result = await options.subscription(request, signal, progress);
        if (probeId && account) {
          const actualAccount = (options.resultAccount ?? subscriptionResultAccount)(result);
          if (actualAccount === account) await store.finishProbe(account, probeId, true).catch(() => {});
          else await store.releaseProbe(account, probeId).catch(() => {});
        }
        return result;
      } catch (error) {
        if (probeId && account) await store.releaseProbe(account, probeId).catch(() => {});
        if (!(error instanceof SubscriptionQuotaError) || signal.aborted) throw error;
        if (!config) {if (optionalError) throw paidError(optionalError); throw error;}
        if (optionalError) throw paidError(optionalError);
        if (!account || account !== config.confirmedSubscriptionAccount || error.accountId !== account)
          throw new BridgeError(409, 'api_account_changed', 'Subscription account identity differs from the account bound to API fallback. Reconfigure fallback for the current account.');
        await store.recordQuota(account, error.windows.length ? error.windows : [{type: 'unknown', resetsAt: null}]).catch(error => {throw paidError(error);});
        reason = probeId ? 'subscription_recovery_still_limited' : 'subscription_quota';
      }
    }
    if (!config) throw new BridgeError(409, 'api_fallback_disabled', 'Paid fallback is disabled.');
    const runId = randomUUID(), receiptRoot = path.join(options.root, 'receipts');
    let reserved = false, sent = false, actual: ApiStepResult | undefined;
    let reservation = 0;
    const receipt = (status: string, code: string, details: Record<string, string> = {}) => {
      const {request_id, message_id, actual_model, http_status, ...diagnostics} = safeApiDiagnostics(details);
      return {schema_version: 1, run_id: runId, source: 'anthropic_api',
      started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), status, code,
      route_reason: reason, request_kind: isCompactionRequest(request) ? 'compaction' : 'turn',
      requested_alias: request.model, actual_model: actual?.actualModel ?? actual_model ?? null,
      http_status: http_status ? Number(http_status) : null,
      request_id: actual?.requestId ?? request_id ?? null, message_id: actual?.messageId ?? message_id ?? null,
      diagnostics: Object.keys(diagnostics).length ? diagnostics : null,
      inference_stage: actual ? 'complete' : sent ? 'sent_outcome_unknown' : 'not_sent',
      cost_estimate_usd: actual?.costUsd ?? null, reservation_usd: reserved ? reservation : 0,
      cache: config!.cache, usage: actual ? {input_tokens: actual.inputTokens,
        cache_read_input_tokens: actual.cacheReadInputTokens, cache_creation_input_tokens: actual.cacheCreationInputTokens,
        output_tokens: actual.outputTokens} : null, context_usage: actual?.result.usage ?? null};
    };
    try {
      cancelled(signal);
      const identity = stepIdentity(request);
      if (!identity) throw new BridgeError(409, 'api_step_identity_missing', 'Codex did not supply a reliable chat identity. Paid fallback is blocked to prevent duplicate charging.');
      const model = options.models.find(m => m.id === request.model);
      if (!model) throw new BridgeError(400, 'unknown_model', 'The requested Claude model is not installed.');
      const prepared = await api(config).prepare(request, model, signal);
      reservation = prepared.reservationUsd;
      if (!Number.isFinite(reservation) || reservation <= 0 || reservation > config.perRequestLimitUsd)
        throw new BridgeError(409, 'api_request_budget_exceeded', 'The cold-cache estimate exceeds the per-request API budget. No paid request was sent.');
      cancelled(signal);
      const latest = await loadApiConfig(options.root);
      if (!latest) throw new BridgeError(409, 'api_fallback_disabled', 'Paid fallback was disabled before this request was sent.');
      if (JSON.stringify(latest) !== JSON.stringify(config)) throw new BridgeError(409, 'api_configuration_changed', 'API settings changed during preflight. No paid request was sent.');
      await store.reserve({id: runId, amountUsd: reservation, dailyLimitUsd: config.dailyLimitUsd,
        totalLimitUsd: config.totalLimitUsd, scope: account!});
      reserved = true;
      cancelled(signal);
      // Claim after reservation, before sending. A duplicate/cancel before sending settles this new reservation to zero.
      await guard.claim(identity);
      cancelled(signal);
      const {pending} = await withApiSendPermit(options.root, config, () => {
        cancelled(signal);
        sent = true;
        return prepared.execute(signal, progress);
      });
      actual = await pending;
      await store.settle(runId, actual.costUsd);
      await guard.complete(identity);
      await writeApiPrivate(receiptRoot, `${runId}.json`, receipt('complete', 'complete'));
      return actual.result;
    } catch (error) {
      const failure = paidError(signal.aborted && signal.reason instanceof BridgeError ? signal.reason : error);
      if (reserved) await store.settle(runId, actual?.costUsd ?? (sent ? null : 0)).catch(() => {});
      await writeApiPrivate(receiptRoot, `${runId}.json`, receipt(failure.code === 'timeout' ? 'failed' : signal.aborted ? 'aborted' : sent ? 'incomplete' : 'blocked',
        safeCode(failure.code), {...(error instanceof BridgeError ? error.details : {}), ...failure.details})).catch(() => {});
      throw failure;
    }
  };
}
