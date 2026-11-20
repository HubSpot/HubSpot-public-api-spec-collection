/**
 * Read/update the Phase 1 → Phase 2 contract, migration-state.json.
 *
 * The file is keyed by "{group}/{api}" (one entry per API, the latest version):
 *   { repo: { specPath, blobSha, githubUrl, ... },
 *     postman: { specId, groupingCollectionUid, apiFolderId, versionFolderId, bindingLevel, ... } }
 *
 * Phase 2 reads it to know which spec id maps to which monorepo file (and which
 * collection folder to sync), and writes it back after applying changes so the
 * blob hashes and any newly-created ids stay current for the next run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function loadState(path) {
  if (!existsSync(path)) {
    throw new Error(`migration-state.json not found at ${path}. Phase 1 must run first.`);
  }
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.apis ??= {};
  state.skipped ??= [];
  return state;
}

export function saveState(path, state) {
  state.updatedAt = new Date().toISOString();
  state.apiCount = Object.keys(state.apis ?? {}).length;
  state.skippedCount = (state.skipped ?? []).length;
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

/** The stable per-API key used everywhere. */
export function apiKey(group, api) {
  return `${group}/${api}`;
}
