/**
 * Matching a monorepo (API, version) to the folders inside one of the
 * workspace's existing grouping collections. HubSpot's collections come in two
 * layouts, and the matcher handles both:
 *
 *   - version-subfolder (e.g. Account): "Account Info API" → "2026-03 [latest]"
 *   - functional        (e.g. CRM):     "Contacts API" → Batch / Basic / Search
 *
 * Folder names also vary: exact ("Account Info API"), version baked in
 * ("Associations V3 API"), or renamed ("Crm Owners" → "Owners API"). All pure
 * functions so they're shared by the map stage and latest-version resolution.
 */
import { parseLatestToken } from './select.mjs';

export function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

export function looksLikeVersion(name) {
  const n = norm(name);
  return /^v\d+\b/.test(n) || /^\d{4}-\d{2}\b/.test(n);
}

/**
 * Index the API folders of a grouping collection.
 * @returns {Array<{ name: string, id: string, base: string, versions: Array<{name:string,id:string}>, hasVersionChildren: boolean }>}
 */
export function indexFolders(items) {
  const folders = [];
  for (const node of items ?? []) {
    if (!Array.isArray(node.item)) continue;
    const versions = node.item.map((v) => ({ name: v.name, id: v.id }));
    const hasVersionChildren = versions.some((v) => looksLikeVersion(v.name));
    folders.push({
      name: node.name,
      id: node.id,
      base: norm(node.name).replace(/\s+api$/, ''),
      versions,
      hasVersionChildren
    });
  }
  return folders;
}

/**
 * Match a monorepo (api, version) to one of the grouping collection's API
 * folders. Pass versionToken=null when the version isn't known yet (e.g. when
 * resolving which version is published-latest).
 */
export function matchApiFolder(folders, apiFolderName, apiName, versionToken) {
  const wantExact = norm(apiFolderName);
  const wantApi = norm(apiName);
  const vMajor = versionMajor(versionToken);

  let hit = folders.find((f) => norm(f.name) === wantExact);
  if (hit) return hit;

  hit = folders.find((f) => f.base === wantApi);
  if (hit) return hit;

  if (vMajor) {
    hit = folders.find(
      (f) => f.base.startsWith(wantApi) && new RegExp(`\\b${vMajor}\\b`).test(f.base)
    );
    if (hit) return hit;
  }

  const loose = folders.filter((f) => {
    const other = otherMajor(f.base, vMajor);
    if (other) return false;
    return f.base.includes(wantApi) || wantApi.includes(f.base);
  });
  if (loose.length === 1) return loose[0];
  const versionless = loose.find((f) => !/\bv\d+\b/.test(f.base));
  return versionless ?? loose[0] ?? null;
}

export function matchVersionFolder(apiFolder, versionFolderName, versionToken) {
  const versions = apiFolder?.versions ?? [];
  let hit = versions.find((v) => v.name === versionFolderName);
  if (hit) return hit;
  hit = versions.find((v) => norm(v.name).startsWith(norm(versionToken)));
  if (hit) return hit;
  hit = versions.find((v) => norm(v.name).includes(norm(versionToken)));
  return hit ?? null;
}

/**
 * The version token of an API folder's "[latest]"-labeled subfolder, or null
 * when the folder has no labeled version subfolders (functional layout).
 */
export function publishedLatestVersion(apiFolder) {
  if (!apiFolder || !apiFolder.hasVersionChildren) return null;
  for (const v of apiFolder.versions ?? []) {
    const token = parseLatestToken(v.name);
    if (token) return token;
  }
  return null;
}

/**
 * Build a map of `${group}\0${api}` → workspace presence, by locating each API's
 * folder in its grouping collection:
 *   - isPublished:     a collection folder exists for this API in the workspace
 *     (the API is curated/published, even if only directly in Postman)
 *   - publishedLatest: the "[latest]"-labeled version token, when the folder has
 *     labeled version subfolders (else null)
 * @param {Map<string, ReturnType<typeof indexFolders> | null>} indexByGrouping
 * @param {Array<{ group: string, api: string, groupingCollectionName: string, apiFolderName: string }>} apiList
 * @returns {Map<string, { isPublished: boolean, publishedLatest: string | null }>}
 */
export function buildWorkspacePresenceByApi(indexByGrouping, apiList) {
  const out = new Map();
  for (const a of apiList) {
    const key = `${a.group}\u0000${a.api}`;
    const idx = indexByGrouping.get(a.groupingCollectionName);
    if (!idx) {
      out.set(key, { isPublished: false, publishedLatest: null });
      continue;
    }
    const folder = matchApiFolder(idx, a.apiFolderName, a.api, null);
    out.set(key, {
      isPublished: Boolean(folder),
      publishedLatest: folder ? publishedLatestVersion(folder) : null
    });
  }
  return out;
}

export function versionMajor(versionToken) {
  const m = norm(versionToken).match(/^v\d+/);
  return m ? m[0] : null;
}

function otherMajor(base, vMajor) {
  const m = base.match(/\bv\d+\b/);
  if (!m) return null;
  return m[0] === vMajor ? null : m[0];
}
