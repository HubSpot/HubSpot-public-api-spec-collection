/**
 * Naming and version-lifecycle conventions, derived from HubSpot's existing
 * public workspace so the migrated workspace looks identical to today.
 *
 * Collections tab:
 *   {Group} API Collections                ← grouping collection (curated; overridable)
 *   └── {API} API                          ← folder per API
 *       └── {version} [label]              ← subfolder per version + lifecycle label
 *
 * API / Spec tab:
 *   {Group} - {API} API Definition
 *
 * One spec per API (its latest version), so the version is NOT embedded in the
 * name — the name stays stable as the latest version rolls forward.
 *
 * The {Group} label is HubSpot-curated and does not always equal the monorepo
 * folder name (e.g. Engagements, Extend CRM). A group-label map can override the
 * default; without one we use the folder name, which discovery surfaces for
 * review.
 */

/**
 * Grouping collection name. Default: "{Group} API Collections".
 * @param {string} group
 * @param {Record<string, string>=} labelMap  optional override of group → label
 */
export function groupingCollectionName(group, labelMap) {
  const label = labelMap?.[group] ?? group;
  return `${label} API Collections`;
}

/**
 * API folder name inside a grouping collection. Default: "{API} API".
 * Avoids a doubled " API API" when the API name already ends in " API".
 * @param {string} api
 */
export function apiFolderName(api) {
  return /\bapi$/i.test(api) ? api : `${api} API`;
}

/**
 * Version subfolder name, including the lifecycle label when present.
 * @param {string} version
 * @param {string | null} label
 */
export function versionFolderName(version, label) {
  return label ? `${version} [${label}]` : version;
}

/**
 * Spec ("API Definition") name. One spec per API → no version embedded.
 * @param {string} group
 * @param {string} api
 * @param {Record<string, string>=} labelMap
 */
export function specName(group, api, labelMap) {
  const groupLabel = labelMap?.[group] ?? group;
  return `${groupLabel} - ${api} API Definition`;
}

/**
 * Load an optional JSON map file. Returns an empty object when no path is given
 * or the file is missing/unreadable (both maps are optional conveniences).
 * @param {string | null} path
 * @param {(p: string) => string} readText  injectable reader (fs.readFileSync)
 */
export function loadJsonMap(path, readText) {
  if (!path) return {};
  try {
    return JSON.parse(readText(path));
  } catch {
    return {};
  }
}

/**
 * Load an optional group-label map JSON file: { "<folderName>": "<curatedLabel>" }.
 * @param {string | null} path
 * @param {(p: string) => string} readText
 */
export function loadGroupLabelMap(path, readText) {
  return loadJsonMap(path, readText);
}

/**
 * Load an optional version-override map: { "<Group>/<API>": "<version>" }. Pins
 * the exact version to publish for APIs where the automatic "latest" pick is
 * ambiguous (e.g. an API that exists on both v3 and a date-based version with no
 * curated marker). Highest-priority signal in {@link selectLatestVersion}.
 * @param {string | null} path
 * @param {(p: string) => string} readText
 */
export function loadVersionOverrides(path, readText) {
  return loadJsonMap(path, readText);
}

/**
 * Load an optional collection-override map, keyed by "<Group>/<API>":
 *   {
 *     "Auth/Oauth": {
 *       "groupingCollection": "Auth - OAuth Collections",
 *       "groupingCollectionUid": "…",
 *       "apiFolderName": "v3 OAuth API",
 *       "apiFolderId": "…",
 *       "versionFolderName": "2026-03 [latest]",  // optional
 *       "versionFolderId": "…",                    // optional
 *       "bindingLevel": "api"                      // optional: 'api' | 'version'
 *     }
 *   }
 * Pins the exact workspace collection/folder for APIs whose curated collection
 * doesn't follow the "{Group} API Collections" → "{API} API" convention (e.g.
 * OAuth lives in "Auth - OAuth Collections", Subscriptions in a "Communcations
 * API" folder). Bypasses name-matching entirely, so it's the reliable escape
 * hatch when the workspace names don't line up with the monorepo.
 * @param {string | null} path
 * @param {(p: string) => string} readText
 */
export function loadCollectionOverrides(path, readText) {
  const map = loadJsonMap(path, readText);
  // Drop any documentation/comment keys (e.g. "__doc__") — only real overrides.
  return Object.fromEntries(
    Object.entries(map).filter(([, v]) => v && typeof v === 'object')
  );
}
