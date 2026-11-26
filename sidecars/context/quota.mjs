// Read-only quota parser & rate-limited cache for the Context sidecar.
// Parses responses from the host Antigravity language server's GetUserStatus
// and RetrieveUserQuotaSummary RPCs without touching OAuth credentials or
// contacting any external endpoints.

export const QUOTA_TTL_MS = 5 * 60 * 1000;
export const QUOTA_MANUAL_COOLDOWN_MS = 15 * 1000;

function normalizeText(raw) {
  return String(raw || '').trim().toLowerCase();
}

function normalizeModelSlug(raw) {
  return normalizeText(raw)
    .replace(/^models\//, '')
    .replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, '')
    .replace(/\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i, '')
    .replace(/[\s_]+/g, '-');
}

function clampFraction(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

function parseIsoTimeMs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function inferWindowMeta(rawWindow, bucketId, resetAtMs, nowMs) {
  const hint = `${rawWindow || ''} ${bucketId || ''}`.toLowerCase();
  if (/(?:5\s*h|5_hour|five_hour|hourly|short|burst)/.test(hint)) {
    return { key: '5h', label: '5小时' };
  }
  if (/(?:7\s*d|week|weekly|168\s*h)/.test(hint)) {
    return { key: '7d', label: '每周' };
  }
  if (/(?:24\s*h|1\s*d|daily|day)/.test(hint)) {
    return { key: '24h', label: '24小时' };
  }
  if (resetAtMs != null && resetAtMs > nowMs) {
    const diffHours = (resetAtMs - nowMs) / 3600000;
    if (diffHours <= 5.5) return { key: '5h', label: '5小时' };
    if (diffHours > 26) return { key: '7d', label: '每周' };
  }
  return { key: 'default', label: '' };
}

function parseFractionFromObj(obj, hasValidReset) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.remainingFraction,
    obj.remaining_fraction,
    obj.quotaRemainingFraction,
  ];
  for (const c of candidates) {
    const n = clampFraction(typeof c === 'string' && c.trim() !== '' ? Number(c) : c);
    if (n !== null) return n;
  }
  // When remainingFraction is omitted by protobuf3 default-zero encoding while
  // a valid future resetTime is present on an enabled bucket, treat as 0 (exhausted).
  if (hasValidReset && !obj.disabled) return 0;
  return null;
}

function extractPlanName(userStatusRes) {
  const root = userStatusRes?.userStatus || userStatusRes || null;
  if (!root || typeof root !== 'object') return '';
  const planInfo = root.planStatus?.planInfo || root.planInfo || null;
  const candidates = [
    planInfo?.planName,
    planInfo?.displayName,
    root.userTier?.name,
    planInfo?.teamsTier,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function extractModelNamesFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const matches = text.match(/\b(?:Gemini|Claude|GPT-OSS)[^,.;()\n]*/gi) || [];
  return matches.map((s) => s.trim()).filter(Boolean);
}

function pickPrimaryBucket(buckets) {
  if (!buckets.length) return null;
  const withFrac = buckets.filter((b) => b.remainingFraction !== null);
  if (!withFrac.length) return buckets[0];
  // Most constrained bucket wins; tie-break prefers shorter window (5h before 7d).
  const rank = { '5h': 0, '24h': 1, default: 2, '7d': 3 };
  return [...withFrac].sort((a, b) => {
    const diff = a.remainingFraction - b.remainingFraction;
    if (Math.abs(diff) > 1e-6) return diff;
    return (rank[a.windowKey] ?? 2) - (rank[b.windowKey] ?? 2);
  })[0];
}

function inferPoolHintKey(text) {
  const s = normalizeText(text);
  if (!s) return '';
  if (s.includes('3p') || s.includes('claude') || s.includes('gpt-oss') || s.includes('gpt oss')) return 'pool_3p';
  if (s.includes('argon') || s.includes('orchestrator')) return 'pool_argon';
  if (s.includes('carbon')) return 'pool_carbon';
  if (s.includes('neon') || s.includes('hydrogen') || s.includes('flash') || s.includes('gemini')) return 'pool_gemini_main';
  return '';
}

function buildPoolsFromSummary(quotaSummaryRes, nowMs) {
  const root = quotaSummaryRes?.response || quotaSummaryRes || null;
  const rawGroups = Array.isArray(root?.groups) ? root.groups : [];
  const pools = [];

  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i];
    if (!g || typeof g !== 'object') continue;
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    const buckets = [];
    for (let j = 0; j < rawBuckets.length; j++) {
      const b = rawBuckets[j];
      if (!b || typeof b !== 'object' || b.disabled) continue;
      const resetIso = typeof (b.resetTime || b.reset_time) === 'string' ? (b.resetTime || b.reset_time).trim() : null;
      const resetAtMs = parseIsoTimeMs(resetIso);
      const frac = parseFractionFromObj(b, resetAtMs !== null);
      if (frac === null && resetAtMs === null) continue;
      const win = inferWindowMeta(b.window || b.windowName, b.bucketId || b.id, resetAtMs, nowMs);
      buckets.push({
        id: String(b.bucketId || b.id || `bucket-${j}`),
        windowKey: win.key,
        windowLabel: win.label,
        remainingFraction: frac,
        remainingPct: frac !== null ? Math.round(frac * 1000) / 10 : null,
        exhausted: frac !== null && frac <= 0.0001,
        resetTime: resetIso,
        resetAtMs,
      });
    }
    if (!buckets.length) continue;

    const title = String(g.displayName || g.name || g.groupId || `额度池 ${i + 1}`).trim();
    const desc = typeof g.description === 'string' ? g.description.trim() : '';
    const modelIds = Array.isArray(g.modelIds) && g.modelIds.length
      ? g.modelIds.map(String)
      : extractModelNamesFromText(desc || title);
    const primary = pickPrimaryBucket(buckets);
    pools.push({
      id: String(g.groupId || `group-${i}`),
      title,
      description: desc,
      modelIds,
      poolHint: inferPoolHintKey([g.groupId, title, desc, ...modelIds].join(' ')),
      primary,
      buckets,
    });
  }
  return pools;
}

function buildPoolsFromConfigs(userStatusRes, nowMs) {
  const root = userStatusRes?.userStatus || userStatusRes || null;
  const configs = root?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs) || !configs.length) return [];

  // Collapse effort variants (Low/Medium/High/XHigh) and identical reset+fraction pools
  const byProduct = new Map();
  for (const cfg of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.isInternal === true || cfg.isHistorical === true || cfg.disabled === true) continue;
    const rawId = String(cfg.modelId || cfg.modelOrAlias?.model || cfg.model || '').trim();
    const label = String(cfg.label || cfg.displayName || rawId).trim();
    if (!label && !rawId) continue;
    const lowId = rawId.toLowerCase();
    if (/^(?:chat_\d+|tab_|gemini-2\.5-)/.test(lowId) || /^gemini\s*2\.5\b/i.test(label)) continue;

    const qi = cfg.quotaInfo || cfg.quota_info || null;
    if (!qi || typeof qi !== 'object') continue;
    const resetIso = typeof (qi.resetTime || qi.reset_time) === 'string' ? (qi.resetTime || qi.reset_time).trim() : null;
    const resetAtMs = parseIsoTimeMs(resetIso);
    const frac = parseFractionFromObj(qi, resetAtMs !== null);
    if (frac === null && resetAtMs === null) continue;

    const baseName = label.replace(/\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i, '').trim() || rawId;
    const key = normalizeModelSlug(baseName) || normalizeModelSlug(rawId);
    const existing = byProduct.get(key);
    if (!existing) {
      const win = inferWindowMeta('', '', resetAtMs, nowMs);
      const bucket = {
        id: key,
        windowKey: win.key,
        windowLabel: win.label,
        remainingFraction: frac,
        remainingPct: frac !== null ? Math.round(frac * 1000) / 10 : null,
        exhausted: frac !== null && frac <= 0.0001,
        resetTime: resetIso,
        resetAtMs,
      };
      byProduct.set(key, {
        id: key,
        title: baseName,
        description: '',
        modelIds: rawId ? [rawId] : [baseName],
        poolHint: inferPoolHintKey(`${baseName} ${rawId}`),
        primary: bucket,
        buckets: [bucket],
      });
    } else if (rawId && !existing.modelIds.includes(rawId)) {
      existing.modelIds.push(rawId);
    }
  }
  return [...byProduct.values()];
}

/**
 * Parse GetUserStatus and RetrieveUserQuotaSummary into a clean UI snapshot.
 */
export function parseQuotaSnapshot({ userStatusRes = null, quotaSummaryRes = null, nowMs = Date.now(), fetchedAt = null } = {}) {
  const planName = extractPlanName(userStatusRes);
  const summaryPools = buildPoolsFromSummary(quotaSummaryRes, nowMs);
  const configPools = buildPoolsFromConfigs(userStatusRes, nowMs);
  const pools = summaryPools.length ? summaryPools : configPools;

  return {
    available: pools.length > 0,
    source: summaryPools.length ? 'summary' : (configPools.length ? 'user_status' : 'none'),
    planName,
    pools,
    fetchedAt: fetchedAt || new Date(nowMs).toISOString(),
  };
}

/**
 * Match the pool belonging to the currently active conversation model.
 */
export function matchPoolForModel(pools, { modelId = '', displayName = '' } = {}) {
  if (!Array.isArray(pools) || !pools.length) return null;
  const targets = [modelId, displayName].map(normalizeModelSlug).filter(Boolean);
  if (!targets.length) return null;

  // 1. Exact or prefix match against explicit modelIds / title
  for (const p of pools) {
    const candidates = [p.title, ...(p.modelIds || [])].map(normalizeModelSlug).filter(Boolean);
    for (const t of targets) {
      if (candidates.some((c) => c === t || c.includes(t) || t.includes(c))) {
        return p;
      }
    }
  }

  // 2. Fallback to shared pool hint (e.g., gemini-4-neon -> pool_gemini_main)
  const hint = inferPoolHintKey(`${modelId} ${displayName}`);
  if (hint) {
    const matched = pools.find((p) => p.poolHint === hint);
    if (matched) return matched;
  }
  return null;
}

/**
 * Create a rate-limited, single-flight quota fetcher around lsRequest.
 */
export function createQuotaController({
  lsRequest,
  ttlMs = QUOTA_TTL_MS,
  manualCooldownMs = QUOTA_MANUAL_COOLDOWN_MS,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let fetchedAtMs = 0;
  let inFlight = null;

  async function fetchFresh() {
    const [uRes, qRes] = await Promise.allSettled([
      lsRequest('GetUserStatus', {}),
      lsRequest('RetrieveUserQuotaSummary', {}),
    ]);
    const userStatusRes = uRes.status === 'fulfilled' ? uRes.value : null;
    const quotaSummaryRes = qRes.status === 'fulfilled' ? qRes.value : null;
    const ts = now();
    const snap = parseQuotaSnapshot({ userStatusRes, quotaSummaryRes, nowMs: ts });
    cached = snap;
    fetchedAtMs = ts;
    return snap;
  }

  async function getQuota({ force = false, modelId = '', displayName = '' } = {}) {
    const ts = now();
    const age = ts - fetchedAtMs;
    const canManualRefresh = force && age >= manualCooldownMs;
    const isExpired = !cached || age >= ttlMs;

    let snap = cached;
    let throttled = false;

    if (canManualRefresh || isExpired) {
      if (!inFlight) {
        inFlight = fetchFresh().finally(() => { inFlight = null; });
      }
      try {
        snap = await inFlight;
      } catch {
        snap = cached || parseQuotaSnapshot({ nowMs: ts });
      }
    } else if (force && age < manualCooldownMs) {
      throttled = true;
    }

    const matchedPool = snap?.available
      ? matchPoolForModel(snap.pools, { modelId, displayName })
      : null;

    return {
      ...snap,
      matchedPoolId: matchedPool?.id || null,
      throttled,
      nextAutoRefreshMs: Math.max(0, ttlMs - (now() - fetchedAtMs)),
    };
  }

  return { getQuota };
}
