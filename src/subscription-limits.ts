import {createHash} from 'node:crypto';
import {BridgeError} from './contracts.js';

export interface QuotaWindow {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
  // UNIX milliseconds. Null delegates a bounded cooldown to the persistent store.
  resetsAt: number | null;
}

export class SubscriptionQuotaError extends BridgeError {
  constructor(public readonly accountId: string, public readonly windows: QuotaWindow[]) {
    super(429, 'subscription_quota', 'Claude subscription quota is exhausted for this account.');
    this.name = 'SubscriptionQuotaError';
    this.windows = windows.map(window => ({...window}));
  }
}

// AccountInfo is read through the guarded SDK handshake; no authentication files are read here.
export function accountFingerprint(account: {email?: unknown; organization?: unknown}): string | null {
  const normalized = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  const email = normalized(account.email), organization = normalized(account.organization);
  if (!email || !organization || !/^[^\s@]+@[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(organization)) return null;
  return createHash('sha256').update(JSON.stringify(['claude-subscription-account-v1', email, organization])).digest('hex');
}

const scopes = new Set<QuotaWindow['type']>(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);
function quotaType(value: unknown): QuotaWindow['type'] | undefined {
  return typeof value === 'string' && scopes.has(value as QuotaWindow['type']) ? value as QuotaWindow['type'] : undefined;
}

export function normalizeQuotaReset(value: unknown, type: QuotaWindow['type'], now = Date.now()): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  // Current SDK versions emit epoch seconds; accept already-normalized epoch milliseconds as well.
  const millis = value < 1e12 ? value * 1000 : value;
  const windowMs = type === 'five_hour' ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  // A small clock-skew allowance must never turn an invalid reset into an unbounded lockout.
  if (!Number.isSafeInteger(millis) || millis <= now || millis > now + windowMs + 5 * 60 * 1000) return null;
  return millis;
}

interface SessionLimits {
  windows: Map<QuotaWindow['type'], QuotaWindow>;
  unscopedRejected: boolean;
  assistantError?: string;
}

// Each attempt owns its tracker. Evidence is scoped to the SDK result's session and never inferred from prose.
export class SubscriptionLimitTracker {
  private sessions = new Map<string, SessionLimits>();

  observe(message: Record<string, unknown>, now = Date.now()): void {
    if (message.type !== 'rate_limit_event' && message.type !== 'assistant') return;
    const info = message.rate_limit_info as Record<string, unknown> | null | undefined;
    if (message.type === 'rate_limit_event' && (info?.isUsingOverage === true || info?.overageInUse === true)) {
      throw new BridgeError(403, 'subscription_overage', 'Claude reported active subscription extra usage. Disable extra usage before continuing.');
    }
    if (message.parent_tool_use_id != null || typeof message.session_id !== 'string' || !message.session_id) return;
    let state = this.sessions.get(message.session_id);
    if (!state) {state = {windows: new Map(), unscopedRejected: false}; this.sessions.set(message.session_id, state);}
    if (message.type === 'assistant') {
      state.assistantError = typeof message.error === 'string' ? message.error : undefined;
      // A subsequent normal assistant message establishes that the earlier rejection was recovered.
      if (!state.assistantError) {state.windows.clear(); state.unscopedRejected = false;}
      return;
    }
    if (!info || typeof info !== 'object') return;
    const type = quotaType(info.rateLimitType);
    if (type) {
      if (info.status === 'rejected') state.windows.set(type, {type, resetsAt: normalizeQuotaReset(info.resetsAt, type, now)});
      else if (info.status === 'allowed' || info.status === 'allowed_warning') state.windows.delete(type);
    } else if (info.rateLimitType === undefined) {
      if (info.status === 'rejected') state.unscopedRejected = true;
      else if (info.status === 'allowed' || info.status === 'allowed_warning') state.unscopedRejected = false;
    }
    if ((type || info.rateLimitType === undefined) && (info.status === 'allowed' || info.status === 'allowed_warning')
      && !state.windows.size && !state.unscopedRejected && state.assistantError === 'rate_limit') state.assistantError = undefined;
  }

  terminalError(final: Record<string, unknown>, accountId: string | null): BridgeError | undefined {
    if (final.type !== 'result' || final.is_error !== true) return;
    // Max turns/output/structured-output failures have their own causes, even if a quota event occurred earlier.
    if (final.subtype !== 'error_during_execution' && !(final.subtype === 'success' && final.is_error === true)) return;
    const state = typeof final.session_id === 'string' ? this.sessions.get(final.session_id) : undefined;
    if (!state || (state.assistantError !== undefined && state.assistantError !== 'rate_limit')) return;
    if (state.assistantError !== 'rate_limit' && !state.unscopedRejected && !state.windows.size) return;
    if (!accountId) return new BridgeError(429, 'subscription_account_unverified',
      'Claude subscription quota failed, but its account identity could not be verified. API fallback is unavailable for this request.');
    return new SubscriptionQuotaError(accountId, [...state.windows.values()]);
  }
}
