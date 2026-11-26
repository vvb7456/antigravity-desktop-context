import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuotaController, matchPoolForModel, parseQuotaSnapshot } from '../sidecars/context/quota.mjs';

test('parses RetrieveUserQuotaSummary groups with 5h and 7d buckets', () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z');
  const snap = parseQuotaSnapshot({
    nowMs,
    userStatusRes: {
      userStatus: {
        planStatus: { planInfo: { planName: 'Google AI Pro' } },
      },
    },
    quotaSummaryRes: {
      groups: [
        {
          groupId: 'gemini_main',
          displayName: 'Gemini 4 Neon / Flash',
          modelIds: ['gemini-4-neon-high', 'gemini-3.8-flash'],
          buckets: [
            { bucketId: '5h', window: '5h', remainingFraction: 0.72, resetTime: '2026-11-26T15:30:00Z' },
            { bucketId: '7d', window: 'weekly', remainingFraction: 0.91, resetTime: '2026-12-02T00:00:00Z' },
          ],
        },
        {
          groupId: '3p_pool',
          displayName: 'Claude 5.5 / GPT-OSS',
          modelIds: ['claude-opus-5-5-high'],
          buckets: [
            // omitted remainingFraction with valid resetTime => 0% exhausted
            { bucketId: '5h', window: '5h', resetTime: '2026-11-26T16:00:00Z' },
          ],
        },
      ],
    },
  });

  assert.equal(snap.available, true);
  assert.equal(snap.source, 'summary');
  assert.equal(snap.planName, 'Google AI Pro');
  assert.equal(snap.pools.length, 2);
  assert.equal(snap.pools[0].primary.windowKey, '5h');
  assert.equal(snap.pools[0].primary.remainingPct, 72);
  assert.equal(snap.pools[0].buckets.length, 2);
  assert.equal(snap.pools[1].primary.remainingPct, 0);
  assert.equal(snap.pools[1].primary.exhausted, true);

  const matched = matchPoolForModel(snap.pools, { modelId: 'gemini-4-neon-medium', displayName: 'Gemini 4 Neon (Medium)' });
  assert.equal(matched?.id, 'gemini_main');
});

test('falls back to GetUserStatus clientModelConfigs and collapses effort tiers', () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z');
  const snap = parseQuotaSnapshot({
    nowMs,
    userStatusRes: {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Neon (High)',
              modelOrAlias: { model: 'gemini-4-neon-high' },
              quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-26T16:00:00Z' },
            },
            {
              label: 'Gemini 4 Neon (Low)',
              modelOrAlias: { model: 'gemini-4-neon-low' },
              quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-26T16:00:00Z' },
            },
            {
              label: 'Internal Model',
              modelId: 'chat_123',
              isInternal: true,
              quotaInfo: { remainingFraction: 0.5 },
            },
          ],
        },
      },
    },
  });

  assert.equal(snap.available, true);
  assert.equal(snap.source, 'user_status');
  assert.equal(snap.pools.length, 1);
  assert.equal(snap.pools[0].title, 'Gemini 4 Neon');
  assert.equal(snap.pools[0].primary.remainingPct, 85);
});

test('gracefully returns unavailable for enterprise/empty responses', () => {
  const snap = parseQuotaSnapshot({ userStatusRes: {}, quotaSummaryRes: {} });
  assert.equal(snap.available, false);
  assert.deepEqual(snap.pools, []);
});

test('enforces TTL cache and manual refresh cooldown', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const ctrl = createQuotaController({
    ttlMs: 300_000,
    manualCooldownMs: 15_000,
    now: () => clock,
    lsRequest: async (method) => {
      if (method === 'RetrieveUserQuotaSummary') {
        calls++;
        return {
          groups: [
            {
              groupId: 'main',
              displayName: 'Gemini',
              buckets: [{ bucketId: '5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-26T16:00:00Z' }],
            },
          ],
        };
      }
      return {};
    },
  });

  const r1 = await ctrl.getQuota();
  assert.equal(calls, 1);
  assert.equal(r1.throttled, false);

  // Within cooldown, force refresh is throttled and does not hit LS
  clock += 5_000;
  const r2 = await ctrl.getQuota({ force: true });
  assert.equal(calls, 1);
  assert.equal(r2.throttled, true);

  // After cooldown, force refresh succeeds
  clock += 15_000;
  const r3 = await ctrl.getQuota({ force: true });
  assert.equal(calls, 2);
  assert.equal(r3.throttled, false);

  // Normal request within TTL uses cache
  clock += 60_000;
  await ctrl.getQuota();
  assert.equal(calls, 2);

  // After TTL expiry, automatically refreshes
  clock += 300_000;
  await ctrl.getQuota();
  assert.equal(calls, 3);
});
