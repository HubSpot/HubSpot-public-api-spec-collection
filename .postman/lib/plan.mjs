/**
 * Resolves the single latest version per API and enriches it with the
 * deterministic Postman names (spec name, grouping/API/version folder names)
 * every stage shares. Computing this in one place guarantees discover, upload,
 * map, and state all agree on names and on which version is "latest".
 */
import { groupByApi } from './monorepo.mjs';
import {
  groupingCollectionName,
  apiFolderName,
  versionFolderName,
  specName
} from './naming.mjs';
import { selectLatestVersion } from './select.mjs';

/**
 * @typedef {Object} LatestCell
 * @property {string} group
 * @property {string} api
 * @property {string} version              the selected latest version
 * @property {'override' | 'published-latest' | 'repo-curated' | 'published-collection'} selectionReason
 * @property {string} rollout
 * @property {string[]} otherRollouts
 * @property {string} specPath
 * @property {string} specAbsPath
 * @property {string | null} curatedCollectionPath
 * @property {string | null} curatedCollectionAbsPath
 * @property {'curated' | 'uncurated'} collectionSource
 * @property {string} key                 stable "group/api" key (one per API)
 * @property {string} specName
 * @property {string} groupingCollectionName
 * @property {string} apiFolderName
 * @property {string} versionFolderName
 */

/**
 * Resolve exactly one latest cell per API (the latest-only plan).
 *
 * For each API we pick a single version via {@link selectLatestVersion}: an
 * explicit override wins, else the workspace's published-"[latest]" version,
 * else the most-recent curated version, else — when the API simply has a
 * collection in the workspace — its most-recent released version, else the API
 * is skipped (no collection anywhere).
 *
 * The spec name deliberately omits the version (`{Group} - {API} API
 * Definition`) so it is stable across version bumps — when HubSpot publishes a
 * new latest, Phase 2 updates the same spec id in place rather than creating a
 * new spec.
 *
 * @param {import('./monorepo.mjs').Cell[]} cells
 * @param {{ labelMap?: Record<string,string>, presenceByApi?: Map<string, { isPublished: boolean, publishedLatest: string|null }>, overrides?: Record<string,string>, now?: Date }} [opts]
 * @returns {{ selected: LatestCell[], skipped: Array<{ group: string, api: string, reason: string, versions: string[] }> }}
 */
export function resolveLatestSelections(cells, opts = {}) {
  const labelMap = opts.labelMap ?? {};
  const presence = opts.presenceByApi ?? new Map();
  const overrides = opts.overrides ?? {};
  const now = opts.now ?? new Date();
  const byApi = groupByApi(cells);

  /** @type {LatestCell[]} */
  const selected = [];
  const skipped = [];

  for (const { group, api, versions } of byApi.values()) {
    const apiVersions = versions.map((c) => ({
      version: c.version,
      curated: Boolean(c.curatedCollectionPath)
    }));
    const pres = presence.get(`${group}\u0000${api}`) ?? {};
    const { version, reason } = selectLatestVersion(apiVersions, {
      override: overrides[`${group}/${api}`] ?? null,
      publishedLatest: pres.publishedLatest ?? null,
      isPublished: Boolean(pres.isPublished),
      now
    });

    if (!version) {
      skipped.push({ group, api, reason, versions: apiVersions.map((a) => a.version) });
      continue;
    }

    const cell = versions.find((c) => c.version === version);
    selected.push({
      group: cell.group,
      api: cell.api,
      version,
      selectionReason: reason,
      rollout: cell.rollout,
      otherRollouts: cell.otherRollouts,
      specPath: cell.specPath,
      specAbsPath: cell.specAbsPath,
      curatedCollectionPath: cell.curatedCollectionPath,
      curatedCollectionAbsPath: cell.curatedCollectionAbsPath,
      collectionSource: cell.curatedCollectionPath ? 'curated' : 'uncurated',
      key: `${cell.group}/${cell.api}`,
      // One spec per API → no version embedded → stable name across bumps.
      specName: specName(group, api, labelMap),
      groupingCollectionName: groupingCollectionName(group, labelMap),
      apiFolderName: apiFolderName(api),
      versionFolderName: versionFolderName(version, null)
    });
  }

  selected.sort(
    (a, b) => a.group.localeCompare(b.group) || a.api.localeCompare(b.api)
  );
  skipped.sort(
    (a, b) => a.group.localeCompare(b.group) || a.api.localeCompare(b.api)
  );
  return { selected, skipped };
}

/**
 * Find the most recent report file for a given stage prefix in a reports dir.
 * Returns null when none exist. Used so later stages can read earlier outputs.
 * @param {string} reportsDir
 * @param {string} stagePrefix  e.g. "04-upload-specs"
 * @param {(dir: string) => string[]} readdir
 * @param {(path: string) => string} readText
 * @param {(...parts: string[]) => string} joinPath
 */
export function findLatestReport(
  reportsDir,
  stagePrefix,
  readdir,
  readText,
  joinPath
) {
  let names;
  try {
    names = readdir(reportsDir);
  } catch {
    return null;
  }
  // Sort by the trailing ISO timestamp, NOT the whole filename: the mode token
  // ("-plan-"/"-apply-") sits before the timestamp, so a plain name sort would
  // let the newest *plan* report outrank a newer *apply* report.
  const stamp = (n) => n.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/)?.[1] ?? n;
  const matches = names
    .filter((n) => n.startsWith(stagePrefix) && n.endsWith('.json'))
    .sort((a, b) => stamp(a).localeCompare(stamp(b)));
  if (matches.length === 0) return null;
  const latest = matches.at(-1);
  try {
    return { path: joinPath(reportsDir, latest), document: JSON.parse(readText(joinPath(reportsDir, latest))) };
  } catch {
    return null;
  }
}
