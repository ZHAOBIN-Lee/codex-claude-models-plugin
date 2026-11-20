import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountFingerprint, normalizeQuotaReset, SubscriptionLimitTracker, SubscriptionQuotaError} from '../src/subscription-limits.js';

const now = 1_800_000_000_000;
const session = 'quota-session';
const final = {type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session};
const accountId = 'a'.repeat(64);
const rate = (info: Record<string, unknown>) => ({type: 'rate_limit_event', session_id: session, rate_limit_info: info});

test('identity normalization is stable while either account component changes its opaque fingerprint', () => {
  const id = accountFingerprint({email: ' USER@Example.invalid ', organization: ' Org-Abc '});
  assert.match(id!, /^[a-f0-9]{64}$/);
  assert.equal(id, accountFingerprint({email: 'user@example.invalid', organization: 'org-abc'}));
  assert.notEqual(id, accountFingerprint({email: 'other@example.invalid', organization: 'org-abc'}));
  assert.notEqual(id, accountFingerprint({email: 'user@example.invalid', organization: 'org-other'}));
  for (const account of [{}, {email: 'user@example.invalid'}, {organization: 'org'}, {email: 'malformed', organization: 'org'},
    {email: 'user@example.invalid', organization: '\u0000org'}, {email: 'user@example.invalid', organization: '  '}]) {
    assert.equal(accountFingerprint(account), null);
  }
});

test('resets normalize seconds and milliseconds and reject malformed, expired and far-future values', () => {
  assert.equal(normalizeQuotaReset(1_800_000_600, 'five_hour', now), 1_800_000_600_000);
  assert.equal(normalizeQuotaReset(1_800_000_600_000, 'five_hour', now), 1_800_000_600_000);
  assert.equal(normalizeQuotaReset(1_800_518_400, 'seven_day_opus', now), 1_800_518_400_000);
  assert.equal(normalizeQuotaReset(1_800_518_400, 'five_hour', now), null);
  for (const value of [undefined, null, '1800000600', '2027-01-15T00:00:00Z', -1, 0, Infinity, NaN,
    1_800_000_600.5, now, now - 1, now + 30 * 24 * 60 * 60 * 1000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeQuotaReset(value, 'seven_day', now), null);
  }
});

test('multiple scoped rejections retain distinct reset windows and unknown resets remain null', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe(rate({status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_600}), now);
  tracker.observe(rate({status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_800_518_400_000}), now);
  tracker.observe(rate({status: 'rejected', rateLimitType: 'seven_day_sonnet', resetsAt: 'bad'}), now);
  const error = tracker.terminalError(final, accountId);
  assert.ok(error instanceof SubscriptionQuotaError);
  assert.equal(error.accountId, accountId);
  assert.deepEqual(error.windows, [
    {type: 'five_hour', resetsAt: 1_800_000_600_000},
    {type: 'seven_day', resetsAt: 1_800_518_400_000},
    {type: 'seven_day_sonnet', resetsAt: null},
  ]);
});

test('a recovered scope cannot erase an independent rejected weekly scope', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe(rate({status: 'rejected', rateLimitType: 'five_hour'}), now);
  tracker.observe(rate({status: 'rejected', rateLimitType: 'seven_day_opus'}), now);
  tracker.observe(rate({status: 'allowed', rateLimitType: 'five_hour'}), now);
  assert.deepEqual((tracker.terminalError(final, accountId) as SubscriptionQuotaError).windows,
    [{type: 'seven_day_opus', resetsAt: null}]);
});

test('subagent error and rejected credit scopes cannot be mistaken for primary subscription quota', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe({type: 'assistant', error: 'rate_limit', session_id: session, parent_tool_use_id: 'toolu_child'});
  for (const type of ['overage', 'seven_day_overage_included', 'unknown']) {
    tracker.observe(rate({status: 'rejected', rateLimitType: type}));
  }
  assert.equal(tracker.terminalError(final, accountId), undefined);
});

test('a subsequent ordinary assistant clears recovered quota failure evidence', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe(rate({status: 'rejected', rateLimitType: 'five_hour'}));
  tracker.observe({type: 'assistant', error: 'rate_limit', session_id: session, parent_tool_use_id: null});
  tracker.observe({type: 'assistant', session_id: session, parent_tool_use_id: null, message: {content: []}});
  assert.equal(tracker.terminalError(final, accountId), undefined);
});

test('malformed result error flags never authorize a paid fallback', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe(rate({status: 'rejected', rateLimitType: 'five_hour'}));
  for (const is_error of [undefined, false, 'true', 1]) {
    assert.equal(tracker.terminalError({...final, is_error}, accountId), undefined);
  }
});

test('a current allowed event clears an older assistant rate-limit error after all scopes recover', () => {
  const tracker = new SubscriptionLimitTracker();
  tracker.observe(rate({status: 'rejected', rateLimitType: 'five_hour'}));
  tracker.observe({type: 'assistant', error: 'rate_limit', session_id: session, parent_tool_use_id: null});
  tracker.observe(rate({status: 'allowed', rateLimitType: 'five_hour'}));
  assert.equal(tracker.terminalError(final, accountId), undefined);
});
