/**
 * "Latest version" selection for the latest-only migration.
 *
 * HubSpot ships many versions of each API in the monorepo (semantic v1/v2/v3 plus
 * date-based 2025-09 / 2026-03 / 2026-09 …), but only one is the *current,
 * published* version. Uploading all of them floods the workspace with stale
 * specs, so we upload exactly one spec per API: the latest.
 *
 * "Latest" is decided by, in order:
 *   1. override — an explicit `{group}/{api}` → version pin (version-overrides.json),
 *      for the handful of APIs where HubSpot wants a specific version.
 *   2. published-latest — the version the workspace collection marks "[latest]".
 *      The published collection is what developers actually see, so it wins.
 *   3. repo-curated — the most-recent version that carries a curated
 *      `Collection Directory` in the monorepo.
 *   4. published-collection — the API has a collection in the workspace but no
 *      version label and no curated repo dir (HubSpot curated it directly in
 *      Postman, common for functional CRM-style collections). The collection IS
 *      the curation signal, so we still migrate it, picking the most-recent
 *      RELEASED version (newest date that isn't in the future; else highest vN).
 *   5. otherwise skipped — no collection anywhere, so nothing to publish.
 *
 * The "released, not future" rule matters: HubSpot's date-based versions are
 * named for their release month, so a version like 2026-09 seen in June 2026 is
 * an unreleased draft, not the current version (which is 2026-03).
 */

const STABLE_DATE = /^(\d{4})-(\d{2})$/;
const DATE_PREFIX = /^(\d{4})-(\d{2})\b/;
const SEMANTIC = /^v(\d+)$/i;

/**
 * Rank a version token for recency. Higher tier + value = more recent.
 *   tier 3: stable date (YYYY-MM)         — the published date scheme
 *   tier 2: semantic vN                   — the legacy scheme
 *   tier 1: date with suffix (2026-09-beta) — a preview, never "latest"
 *   tier 0: anything else
 * @param {string} version
 * @returns {{ tier: number, value: number }}
 */
export function recencyRank(version) {
  const v = String(version ?? '').trim();
  let m = STABLE_DATE.exec(v);
  if (m) return { tier: 3, value: Number(m[1]) * 100 + Number(m[2]) };
  m = SEMANTIC.exec(v);
  if (m) return { tier: 2, value: Number(m[1]) };
  m = DATE_PREFIX.exec(v);
  if (m) return { tier: 1, value: Number(m[1]) * 100 + Number(m[2]) };
  return { tier: 0, value: 0 };
}

/** Comparator that sorts version tokens most-recent first. */
export function compareRecencyDesc(a, b) {
  const ra = recencyRank(a);
  const rb = recencyRank(b);
  if (ra.tier !== rb.tier) return rb.tier - ra.tier;
  if (ra.value !== rb.value) return rb.value - ra.value;
  return String(a).localeCompare(String(b));
}

/**
 * Choose the single latest version for one API.
 *
 * @param {Array<{ version: string, curated: boolean }>} apiVersions
 * @param {object} [opts]
 * @param {string | null} [opts.override]        explicit version pin for this API
 * @param {string | null} [opts.publishedLatest] token from the "[latest]" subfolder
 * @param {boolean} [opts.isPublished]           the API has a collection in the workspace
 * @param {Date} [opts.now]                      reference date for "released, not future"
 * @returns {{ version: string | null, reason: 'override' | 'published-latest' | 'repo-curated' | 'published-collection' | 'no-collection' }}
 */
export function selectLatestVersion(apiVersions, opts = {}) {
  const { override = null, publishedLatest = null, isPublished = false, now = new Date() } = opts;
  const have = new Set(apiVersions.map((a) => a.version));

  // 1. Explicit pin wins (HubSpot told us exactly which version to publish).
  if (override && have.has(override)) {
    return { version: override, reason: 'override' };
  }

  // 2. The workspace marks a version "[latest]" and we have that spec.
  if (publishedLatest && have.has(publishedLatest)) {
    return { version: publishedLatest, reason: 'published-latest' };
  }

  // 3. A version carries a curated Collection Directory in the monorepo.
  const curated = apiVersions.filter((a) => a.curated).map((a) => a.version);
  if (curated.length > 0) {
    curated.sort(compareRecencyDesc);
    return { version: curated[0], reason: 'repo-curated' };
  }

  // 4. The API has a collection in the workspace (curated directly in Postman,
  //    e.g. functional CRM-style folders) but no label and no repo dir. The
  //    collection is the publication signal → migrate its most-recent RELEASED
  //    version (not a future-dated draft).
  if (isPublished) {
    const version = mostRecentReleased(
      apiVersions.map((a) => a.version),
      now
    );
    if (version) return { version, reason: 'published-collection' };
  }

  // 5. No collection anywhere → nothing to publish.
  return { version: null, reason: 'no-collection' };
}

/**
 * The most-recent *released* version: the newest stable date not after `now`
 * (date-based versions are named for their release month, so a future month is
 * an unreleased draft), else the highest semantic vN, else — as a last resort —
 * the most-recent of whatever remains (e.g. a future date or a beta).
 * @param {string[]} versions
 * @param {Date} now
 * @returns {string | null}
 */
export function mostRecentReleased(versions, now = new Date()) {
  const cap = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);

  const releasedDates = versions
    .map((v) => ({ v, m: STABLE_DATE.exec(v) }))
    .filter((x) => x.m)
    .map((x) => ({ v: x.v, n: Number(x.m[1]) * 100 + Number(x.m[2]) }))
    .filter((x) => x.n <= cap)
    .sort((a, b) => b.n - a.n);
  if (releasedDates.length > 0) return releasedDates[0].v;

  const semantic = versions
    .filter((v) => SEMANTIC.test(v))
    .sort((a, b) => Number(SEMANTIC.exec(b)[1]) - Number(SEMANTIC.exec(a)[1]));
  if (semantic.length > 0) return semantic[0];

  return [...versions].sort(compareRecencyDesc)[0] ?? null;
}

/**
 * Is a version token released as of `now`? Stable dates (YYYY-MM) are released
 * once their month arrives; semantic vN versions are always released; betas and
 * other suffixed tokens (2027-03-beta) never count as released.
 * @param {string} version
 * @param {Date} [now]
 */
export function isReleased(version, now = new Date()) {
  const v = String(version ?? '').trim();
  const m = STABLE_DATE.exec(v);
  if (m) {
    const cap = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
    return Number(m[1]) * 100 + Number(m[2]) <= cap;
  }
  return SEMANTIC.test(v);
}

/**
 * Phase 2's "latest" rule. Phase 1 leaned on workspace/curation signals to pick
 * the version that matched the collections HubSpot already had. Once the specs
 * exist, the ongoing sync has to follow HubSpot's release train instead: when a
 * new date-based version ships (2026-09, 2027-03, …) it becomes the latest, even
 * though no curated Collection Directory exists for it yet.
 *
 * Order (first match wins):
 *   1. override — explicit `{Group}/{API}` pin (version-overrides.json)
 *   2. newest released stable date (YYYY-MM not in the future)
 *   3. highest semantic vN
 *   4. otherwise null — only betas / future dates exist, nothing released yet
 *
 * @param {string[]} versions
 * @param {{ override?: string | null, now?: Date }} [opts]
 * @returns {{ version: string | null, reason: 'override' | 'released-date' | 'semantic' | 'unreleased-only' }}
 */
export function selectSyncVersion(versions, opts = {}) {
  const { override = null, now = new Date() } = opts;
  const have = new Set(versions);
  if (override && have.has(override)) return { version: override, reason: 'override' };

  const released = versions.filter((v) => isReleased(v, now)).sort(compareRecencyDesc);
  if (released.length > 0) {
    return { version: released[0], reason: STABLE_DATE.test(released[0]) ? 'released-date' : 'semantic' };
  }
  return { version: null, reason: 'unreleased-only' };
}

/**
 * True when `candidate` is strictly more recent than `current` (stable dates beat
 * semantic versions, which beat betas).
 */
export function isNewerVersion(candidate, current) {
  if (!candidate || candidate === current) return false;
  if (!current) return true;
  return compareRecencyDesc(candidate, current) < 0;
}

/**
 * Leading version token of a version subfolder name, ignoring the lifecycle label:
 * "2026-03 [latest]" → "2026-03", "v3 [legacy]" → "v3", "2025-09" → "2025-09".
 * @param {string} folderName
 * @returns {string | null}
 */
export function versionTokenOf(folderName) {
  const m = /^\s*(\d{4}-\d{2}(?:-[a-z0-9]+)?|v\d+)\b/i.exec(String(folderName ?? ''));
  return m ? m[1] : null;
}

/**
 * Extract the version token from a published "[latest]" subfolder name, e.g.
 * "2026-03 [latest]" → "2026-03", "v3 [latest]" → "v3". Returns null when the
 * name isn't a latest-labeled version folder.
 * @param {string} folderName
 * @returns {string | null}
 */
export function parseLatestToken(folderName) {
  const n = String(folderName ?? '');
  if (!/\[latest\]/i.test(n)) return null;
  const m = /^\s*(\d{4}-\d{2}(?:-[a-z0-9]+)?|v\d+)/i.exec(n);
  return m ? m[1] : null;
}
