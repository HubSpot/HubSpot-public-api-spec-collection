/**
 * Pure planning for the Phase 2 sync: compares the monorepo (cells) against
 * migration-state.json and decides, per API, what has to happen. No network.
 *
 * Kept separate from sync.mjs so the decisions are unit-testable and so a plan
 * run reports exactly the same thing an apply run will do.
 *
 * Per API already in state:
 *   - 'roll'      a newer released version exists (or an override pins another)
 *   - 'moved'     same version, but it now lives under a new rollout id
 *   - 'edit'      same file, content changed (git blob SHA differs)
 *   - 'unchanged' nothing to do
 *   - 'removed'   the API is gone from the monorepo (reported, never deleted)
 *
 * Per API not in state:
 *   - newServices  has a released version and isn't ignored/skipped → onboard
 *   - review       skipped in Phase 1 but now has a released version, or only
 *                  betas exist (nothing to publish yet)
 */
import { groupByApi } from './monorepo.mjs';
import { selectSyncVersion, isNewerVersion, compareRecencyDesc } from './select.mjs';
import { apiKey } from './state.mjs';

/**
 * @param {object} input
 * @param {{ apis: Record<string, any>, skipped?: Array<{group:string, api:string}> }} input.state
 * @param {import('./monorepo.mjs').Cell[]} input.cells
 * @param {(cell: import('./monorepo.mjs').Cell) => string | null} input.blobSha
 * @param {Record<string, string>} [input.overrides]
 * @param {{ ignoreGroups?: string[], ignoreApis?: string[] }} [input.config]
 * @param {Date} [input.now]
 */
export function planSync({ state, cells, blobSha, overrides = {}, config = {}, now = new Date() }) {
  const byApi = new Map();
  for (const a of groupByApi(cells).values()) byApi.set(apiKey(a.group, a.api), a);

  const ignoreGroups = new Set(config.ignoreGroups ?? []);
  const ignoreApis = new Set(config.ignoreApis ?? []);
  const skipped = new Set((state.skipped ?? []).map((s) => apiKey(s.group, s.api)));

  const known = [];
  for (const [key, entry] of Object.entries(state.apis ?? {})) {
    const api = byApi.get(key);
    if (!api) {
      known.push({ key, entry, action: 'removed', from: entry.repo?.specPath ?? null });
      continue;
    }

    const versions = api.versions.map((c) => c.version);
    const override = overrides[key] ?? null;
    const sel = selectSyncVersion(versions, { override, now });
    const current = entry.latestVersion ?? null;
    const currentCell = api.versions.find((c) => c.version === current) ?? null;

    // Roll forward when a newer released version exists, or an override points
    // somewhere else. Never roll backwards on our own.
    let target = currentCell;
    let reason = entry.selectionReason ?? null;
    const overrideMoves = sel.reason === 'override' && sel.version !== current;
    if (sel.version && (overrideMoves || isNewerVersion(sel.version, current) || !currentCell)) {
      target = api.versions.find((c) => c.version === sel.version);
      reason = sel.reason;
    }
    if (!target) {
      known.push({ key, entry, action: 'removed', from: entry.repo?.specPath ?? null, versions });
      continue;
    }

    const sha = blobSha(target);
    const base = {
      key,
      entry,
      cell: target,
      sha,
      from: entry.repo?.specPath ?? null,
      to: target.specPath,
      fromVersion: current,
      toVersion: target.version,
      selectionReason: reason
    };
    if (target.version !== current) known.push({ ...base, action: 'roll' });
    else if (target.specPath !== entry.repo?.specPath) known.push({ ...base, action: 'moved', contentChanged: sha !== entry.repo?.blobSha });
    else if (sha !== entry.repo?.blobSha) known.push({ ...base, action: 'edit' });
    else known.push({ ...base, action: 'unchanged' });
  }

  const newServices = [];
  const review = [];
  for (const [key, api] of byApi) {
    if (state.apis?.[key]) continue;
    if (ignoreGroups.has(api.group) || ignoreApis.has(key)) continue;
    const versions = api.versions.map((c) => c.version).sort(compareRecencyDesc);
    const sel = selectSyncVersion(versions, { override: overrides[key] ?? null, now });
    if (skipped.has(key)) {
      if (sel.version) review.push({ key, reason: 'skipped-in-phase1-now-has-released-version', version: sel.version, versions });
      continue;
    }
    if (!sel.version) {
      review.push({ key, reason: 'unreleased-only', versions });
      continue;
    }
    const cell = api.versions.find((c) => c.version === sel.version);
    newServices.push({ key, group: api.group, api: api.api, version: sel.version, selectionReason: sel.reason, cell });
  }

  newServices.sort((a, b) => a.key.localeCompare(b.key));
  review.sort((a, b) => a.key.localeCompare(b.key));
  return { known, newServices, review };
}

/**
 * Ensure every state entry records which version its bound curated folder
 * represents. Phase 1 bound each spec to the folder for the version it selected,
 * so for entries written before this field existed, boundVersion = latestVersion.
 * The sync only merges endpoints into a folder whose boundVersion matches the
 * spec's version, so a v3 folder never receives 2026-09 requests.
 */
export function backfillBoundVersion(state) {
  for (const entry of Object.values(state.apis ?? {})) {
    entry.postman ??= {};
    if (entry.postman.boundVersion === undefined) {
      entry.postman.boundVersion = entry.postman.bindingLevel ? entry.latestVersion ?? null : null;
    }
  }
  return state;
}

/**
 * The grouping collection most APIs in a group are bound to, so a brand-new API
 * in an existing group lands next to its siblings. Null when the group is new.
 */
export function groupingCollectionForGroup(state, group) {
  const counts = new Map();
  for (const e of Object.values(state.apis ?? {})) {
    const uid = e.postman?.groupingCollectionUid;
    if (e.group !== group || !uid) continue;
    if (!['api', 'version'].includes(e.postman?.bindingLevel)) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  let best = null;
  for (const [uid, n] of counts) if (!best || n > best.n) best = { uid, n };
  return best?.uid ?? null;
}
