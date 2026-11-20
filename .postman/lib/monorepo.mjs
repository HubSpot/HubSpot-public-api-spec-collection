/**
 * Discovery over a local checkout of HubSpot/HubSpot-public-api-spec-collection.
 *
 * The repo lays specs out as:
 *
 *   PublicApiSpecs/{Group}/{API}/Rollouts/{rolloutId}/{Version}/
 *     - {apiName}.json                    ← OpenAPI 3 spec (the cell's root spec)
 *     - "Collection Directory ..." dir    ← HubSpot's curated collection (optional)
 *          - *.json                       ← Collection v2.1.0 document
 *
 * A "cell" is one (Group, API, Version) coordinate. Because the same version can
 * appear under multiple rollout IDs (e.g. Account Info v3 under 136890 and
 * 144923), we collapse to one cell per (Group, API, Version) keeping the highest
 * rollout ID — rollout IDs are monotonic, so newest wins — and record collapsed
 * rollouts as conflicts for review.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * @typedef {Object} Cell
 * @property {string} group
 * @property {string} api
 * @property {string} version
 * @property {string} rollout                 chosen rollout id (highest)
 * @property {string} specPath                repo-relative path to the root spec json
 * @property {string} specAbsPath             absolute path on disk
 * @property {string | null} curatedCollectionPath  repo-relative path to curated collection json
 * @property {string | null} curatedCollectionAbsPath
 * @property {string[]} otherRollouts         rollout ids that were collapsed away
 */

const COLLECTION_DIR_RE = /collection[ _-]?directory/i;

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Find the curated collection json inside a version directory, if any.
 * @returns {string | null} absolute path to the curated collection json
 */
function findCuratedCollection(versionAbsPath) {
  const collectionDir = listDirs(versionAbsPath).find((d) =>
    COLLECTION_DIR_RE.test(d)
  );
  if (!collectionDir) return null;
  const dirAbs = join(versionAbsPath, collectionDir);
  const json = listFiles(dirAbs).find((f) => f.toLowerCase().endsWith('.json'));
  return json ? join(dirAbs, json) : null;
}

/**
 * Find the root spec json directly inside a version directory (the file that is
 * NOT inside a Collection Directory).
 * @returns {string | null} filename of the spec json
 */
function findRootSpec(versionAbsPath) {
  const jsons = listFiles(versionAbsPath).filter((f) =>
    f.toLowerCase().endsWith('.json')
  );
  return jsons[0] ?? null;
}

/**
 * Walk the repo and return one collapsed cell per (Group, API, Version).
 *
 * @param {string} repoPath  path to a checkout of the monorepo
 * @returns {{ cells: Cell[], conflicts: Array<{ group: string, api: string, version: string, chosenRollout: string, otherRollouts: string[] }>, groups: string[] }}
 */
export function discoverCells(repoPath) {
  const specsRoot = join(repoPath, 'PublicApiSpecs');
  if (!existsSync(specsRoot)) {
    throw new Error(
      `${specsRoot} not found. Set HUBSPOT_REPO_PATH to a checkout of ` +
        `HubSpot/HubSpot-public-api-spec-collection.`
    );
  }

  /** @type {Map<string, Cell[]>} */
  const byCoord = new Map();

  for (const group of listDirs(specsRoot)) {
    const groupAbs = join(specsRoot, group);
    for (const api of listDirs(groupAbs)) {
      const rolloutsAbs = join(groupAbs, api, 'Rollouts');
      if (!existsSync(rolloutsAbs)) continue;
      for (const rollout of listDirs(rolloutsAbs)) {
        const rolloutAbs = join(rolloutsAbs, rollout);
        for (const version of listDirs(rolloutAbs)) {
          const versionAbs = join(rolloutAbs, version);
          const specFile = findRootSpec(versionAbs);
          if (!specFile) continue;

          const specAbsPath = join(versionAbs, specFile);
          const curatedAbs = findCuratedCollection(versionAbs);
          const relBase = `PublicApiSpecs/${group}/${api}/Rollouts/${rollout}/${version}`;

          /** @type {Cell} */
          const cell = {
            group,
            api,
            version,
            rollout,
            specPath: `${relBase}/${specFile}`,
            specAbsPath,
            curatedCollectionPath: curatedAbs
              ? curatedAbs.slice(repoPath.length + 1)
              : null,
            curatedCollectionAbsPath: curatedAbs,
            otherRollouts: []
          };

          const coord = `${group}\u0000${api}\u0000${version}`;
          if (!byCoord.has(coord)) byCoord.set(coord, []);
          byCoord.get(coord).push(cell);
        }
      }
    }
  }

  /** @type {Cell[]} */
  const cells = [];
  /** @type {Array<{ group: string, api: string, version: string, chosenRollout: string, otherRollouts: string[] }>} */
  const conflicts = [];

  for (const candidates of byCoord.values()) {
    candidates.sort((a, b) => compareRollout(b.rollout, a.rollout));
    const chosen = candidates[0];
    const others = candidates.slice(1).map((c) => c.rollout);
    chosen.otherRollouts = others;
    cells.push(chosen);
    if (others.length > 0) {
      conflicts.push({
        group: chosen.group,
        api: chosen.api,
        version: chosen.version,
        chosenRollout: chosen.rollout,
        otherRollouts: others
      });
    }
  }

  cells.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.api.localeCompare(b.api) ||
      a.version.localeCompare(b.version)
  );

  const groups = [...new Set(cells.map((c) => c.group))].sort();
  return { cells, conflicts, groups };
}

/**
 * Compare rollout ids numerically when possible, else lexically. Higher = newer.
 */
function compareRollout(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * Read and JSON-parse a spec file, returning content string + parsed object.
 * @param {Cell} cell
 */
export function readSpec(cell) {
  const content = readFileSync(cell.specAbsPath, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  return { content, parsed };
}

/**
 * Read and JSON-parse a curated collection file.
 * @param {Cell} cell
 * @returns {object | null}
 */
export function readCuratedCollection(cell) {
  if (!cell.curatedCollectionAbsPath) return null;
  try {
    return JSON.parse(readFileSync(cell.curatedCollectionAbsPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compute a file's git blob SHA (the same id GitHub returns in its trees API),
 * so Phase 2 can detect when a spec file changed in the monorepo without
 * downloading the content: `sha1("blob " + byteLength + "\0" + bytes)`.
 * @param {string} absPath
 * @returns {string | null}
 */
export function gitBlobSha(absPath) {
  try {
    const buf = readFileSync(absPath);
    const header = Buffer.from(`blob ${buf.length}\u0000`, 'utf8');
    return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Group cells by (group, api) so collection assembly can build one API folder
 * with one subfolder per version.
 * @param {Cell[]} cells
 * @returns {Map<string, { group: string, api: string, versions: Cell[] }>}
 */
export function groupByApi(cells) {
  /** @type {Map<string, { group: string, api: string, versions: Cell[] }>} */
  const map = new Map();
  for (const cell of cells) {
    const key = `${cell.group}\u0000${cell.api}`;
    if (!map.has(key)) {
      map.set(key, { group: cell.group, api: cell.api, versions: [] });
    }
    map.get(key).versions.push(cell);
  }
  return map;
}
