#!/usr/bin/env node
/**
 * Phase 2: ongoing sync (runs inside HubSpot's monorepo).
 *
 * Keeps the Postman workspace in step with the monorepo, using migration-state.json
 * (produced by Phase 1) as the source-of-truth mapping. Each run:
 *
 *   1. Plans (lib/sync-plan.mjs, pure): for every API in state, is there a newer
 *      released version (roll), the same version under a new rollout (moved), a
 *      content edit (blob SHA changed), or nothing? Which monorepo APIs are new?
 *
 *   2. Specs: pushes changed content to the SAME specId (name/id stay stable).
 *      Brand-new services get a spec, reusing an existing spec of the same name
 *      if one is already in the workspace, so a re-run never duplicates.
 *
 *   3. Collections (only with collections on, always additive):
 *      - roll on a version-subfolder layout: reuse a folder for the new version if
 *        HubSpot already made one, else create "{version} [latest]", populate it
 *        from the spec, and move the [latest] label off the previous version.
 *      - roll on any other layout: spec only. The curated folder documents the old
 *        version, so mixing new-version requests into it is left as a decision
 *        (reported as needs-layout-decision).
 *      - edit: add only brand-new endpoints, and only when the bound folder
 *        documents the same version as the spec.
 *      - new service: "{API} API" > "{version} [latest]" inside the group's
 *        grouping collection (created if the group is new), reusing anything
 *        that already exists by name.
 *
 *   4. Removed APIs are reported, never deleted.
 *
 * Safety: --plan (default) writes nothing. Every create first looks for an
 * existing match, so a run that repeats (e.g. the state PR wasn't merged yet)
 * converges instead of duplicating. State is saved even if some APIs error.
 *
 * Usage (from the monorepo root):
 *   node .postman/sync.mjs --plan  [--repo .] [--state .postman/migration-state.json]
 *   node .postman/sync.mjs --apply [--no-collections] [--no-create]
 * Env: POSTMAN_API_KEY (personal or service account key), POSTMAN_WORKSPACE_ID
 *      (optional; defaults to targetWorkspaceId in the state file).
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadState, saveState } from './lib/state.mjs';
import {
  createPostmanClient,
  createSpec,
  getSpecFiles,
  updateSpecFileContent,
  generateCollection,
  getCollection,
  createCollectionFolder,
  updateCollectionFolder,
  createCollectionRequest,
  deleteCollection,
  folderIdFrom,
  pollTask,
  specTypeForOpenApi,
  listSpecs,
  listCollections
} from './lib/postman.mjs';
import { discoverCells, gitBlobSha, readSpec } from './lib/monorepo.mjs';
import { planSync, backfillBoundVersion, groupingCollectionForGroup } from './lib/sync-plan.mjs';
import { versionTokenOf } from './lib/select.mjs';
import {
  loadGroupLabelMap,
  loadVersionOverrides,
  loadJsonMap,
  specName,
  apiFolderName,
  groupingCollectionName,
  versionFolderName
} from './lib/naming.mjs';
import { newRequests, toCreatePayload, flattenRequests } from './lib/collection-merge.mjs';

const args = parseArgs(process.argv.slice(2));
const mode = args.apply ? 'apply' : 'plan';

const state = backfillBoundVersion(loadState(args.state));
const workspaceId = args.workspace || state.targetWorkspaceId || null;

// A plan can run with no key (e.g. right after install): it reads only the
// monorepo and the state file, and skips the workspace duplicate checks.
const offline = mode === 'plan' && !args.pmak;
if (mode === 'apply' && !args.pmak) {
  process.stderr.write('POSTMAN_API_KEY is required for --apply.\n');
  process.exit(2);
}

const client = createPostmanClient({
  apiKey: args.pmak || 'offline-plan',
  baseUrl: process.env.POSTMAN_API_BASE,
  dryRun: mode !== 'apply'
});

banner(mode, args);

const labelMap = loadGroupLabelMap(args.groupLabelMap, read);
const overrides = loadVersionOverrides(firstExisting(args.versionMap, [
  join(args.repo, '.postman', 'version-overrides.json'),
  join(args.repo, 'version-overrides.json')
]), read);
const config = loadSyncConfig(firstExisting(args.config, [join(args.repo, '.postman', 'sync-config.json')]));

const { cells } = discoverCells(args.repo);
const plan = planSync({
  state,
  cells,
  blobSha: (cell) => gitBlobSha(cell.specAbsPath),
  overrides,
  config,
  now: new Date()
});

const report = {
  changedSpecs: [],
  newServices: [],
  removed: [],
  collectionUpdates: [],
  review: plan.review,
  warnings: [],
  errors: []
};

let ws = null; // workspace index (existing specs/collections by name), loaded on demand

try {
  // ── 1. APIs already in state ─────────────────────────────────────────────────
  for (const item of plan.known) {
    try {
      await handleKnown(item);
    } catch (error) {
      report.errors.push({ key: item.key, phase: item.action, error: describe(error) });
    }
  }

  // ── 2. New services, plus any earlier ones still waiting on a collection ─────
  const pending = args.collections
    ? Object.entries(state.apis).filter(([, e]) => e.postman?.collectionPending)
    : [];
  if ((args.create && plan.newServices.length > 0) || pending.length > 0) {
    ws = await loadWorkspaceIndex();
  }

  if (args.create) {
    for (const svc of plan.newServices) {
      try {
        report.newServices.push(await onboardNewService(svc));
      } catch (error) {
        report.errors.push({ key: svc.key, phase: 'new', error: describe(error) });
      }
    }
  }

  for (const [key, entry] of pending) {
    try {
      const res = await createCollectionForNew(entry);
      report.collectionUpdates.push({ key, ...res });
    } catch (error) {
      report.errors.push({ key, phase: 'pending-collection', error: describe(error) });
    }
  }
} catch (fatal) {
  report.errors.push({ key: '*', phase: 'run', error: describe(fatal) });
} finally {
  // Persist whatever succeeded, even when some APIs failed, so the next run
  // doesn't redo finished work.
  if (mode === 'apply') saveState(args.state, state);
}

printSummary(report, mode);
if (report.errors.length > 0) process.exitCode = 1;

// ────────────────────────────────────────────────────────────────────────────────

async function handleKnown(item) {
  const { key, entry, action } = item;
  if (action === 'unchanged') return;
  if (action === 'removed') {
    report.removed.push({ key, specPath: item.from });
    return;
  }

  const p = entry.postman ?? {};
  const change = {
    key,
    action,
    specId: p.specId ?? null,
    fromVersion: item.fromVersion,
    toVersion: item.toVersion,
    from: item.from,
    to: item.to
  };
  if (!p.specId) {
    change.status = 'skipped-no-specId';
    report.changedSpecs.push(change);
    return;
  }

  const pushContent = action === 'roll' || action === 'edit' || (action === 'moved' && item.contentChanged);
  if (pushContent) {
    const content = readFileSync(item.cell.specAbsPath, 'utf8');
    const rootPath = await resolveRootFilePath(p.specId, item.to);
    await updateSpecFileContent(client, p.specId, rootPath, content);
  }
  change.status = pushContent ? (client.dryRun ? 'planned' : 'updated') : 'path-only';

  // Keep state current.
  entry.repo = {
    ...entry.repo,
    rollout: item.cell.rollout,
    otherRollouts: item.cell.otherRollouts,
    specPath: item.to,
    blobSha: item.sha,
    githubUrl: githubUrl(item.to),
    curatedCollectionPath: item.cell.curatedCollectionPath ?? null,
    curatedCollectionUrl: item.cell.curatedCollectionPath ? githubUrl(item.cell.curatedCollectionPath) : null
  };
  if (action === 'roll') {
    entry.latestVersion = item.toVersion;
    entry.selectionReason = item.selectionReason;
  }
  report.changedSpecs.push(change);

  if (!args.collections || !pushContent) return;
  const res = await syncCollectionsFor(entry, key, action);
  if (res) report.collectionUpdates.push(res);
}

async function syncCollectionsFor(entry, key, action) {
  const p = entry.postman;
  if (action === 'roll') {
    const versionLayout = p.bindingLevel === 'version';
    // Opt-in (sync-config.json): give API-folder-bound APIs a "{version} [latest]"
    // subfolder too, next to their curated functional folders.
    const apiLayoutOptIn = p.bindingLevel === 'api' && config.rollApiLevelFolders;
    if ((versionLayout || apiLayoutOptIn) && p.groupingCollectionUid && p.apiFolderId) {
      return rollVersionFolder(entry, key);
    }
    return {
      key,
      status: 'needs-layout-decision',
      bindingLevel: p.bindingLevel ?? null,
      note: `spec is now ${entry.latestVersion}; the bound collection documents ${p.boundVersion ?? 'no specific version'} and was left as is`
    };
  }
  if (!p.groupingCollectionUid || !(p.versionFolderId ?? p.apiFolderId)) {
    return { key, status: 'skipped-no-folder', bindingLevel: p.bindingLevel ?? null };
  }
  if (p.boundVersion !== entry.latestVersion) {
    return { key, status: 'skipped-bound-folder-is-other-version', boundVersion: p.boundVersion, specVersion: entry.latestVersion };
  }
  return syncCollectionAdditive(entry, key);
}

/** Find the spec's ROOT file path (fallback to the monorepo basename). */
async function resolveRootFilePath(specId, specPath) {
  const fallback = basename(specPath);
  if (client.dryRun) return fallback;
  try {
    const res = await getSpecFiles(client, specId);
    const files = res?.files ?? res?.data ?? [];
    const root = files.find((f) => String(f.type).toUpperCase() === 'ROOT') ?? files[0];
    return root?.path ?? fallback;
  } catch {
    return fallback;
  }
}

/** Same-version edit: add only the new endpoints to the bound curated folder. */
async function syncCollectionAdditive(entry, key) {
  const p = entry.postman ?? {};
  const collectionUid = p.groupingCollectionUid;
  const folderId = p.versionFolderId ?? p.apiFolderId ?? null;
  if (!collectionUid || !folderId) {
    return { key, status: 'skipped-no-folder', bindingLevel: p.bindingLevel ?? null };
  }
  if (client.dryRun) {
    return { key, status: 'planned', note: 'would add any new endpoints to the bound folder' };
  }

  const curatedDoc = await getCollection(client, collectionUid);
  const folder = findFolderById(curatedDoc?.collection?.item ?? [], folderId);
  if (!folder) return { key, status: 'error', error: 'bound folder not found in collection' };

  const added = await withGenerated(p.specId, key, async (genItems) => {
    let n = 0;
    for (const r of newRequests(genItems, folder.item ?? [])) {
      await createCollectionRequest(client, collectionUid, folderId, toCreatePayload(r.name, r.request));
      n += 1;
    }
    return { n, generated: flattenRequests(genItems).length };
  });
  return {
    key,
    status: 'merged',
    generatedRequests: added.generated,
    existingRequests: flattenRequests(folder.item ?? []).length,
    added: added.n
  };
}

/**
 * A new version became the latest on a version-subfolder layout: reuse or create
 * the version folder, fill in what's missing, and move the [latest] label.
 */
async function rollVersionFolder(entry, key) {
  const p = entry.postman;
  const version = entry.latestVersion;
  const latestName = versionFolderName(version, 'latest');
  if (client.dryRun) {
    return { key, status: 'planned', note: `would reuse or add '${latestName}' under '${p.apiFolderName}' and move the [latest] label` };
  }

  const doc = await getCollection(client, p.groupingCollectionUid);
  const apiFolder = findFolderById(doc?.collection?.item ?? [], p.apiFolderId);
  if (!apiFolder) return { key, status: 'error', error: 'bound API folder not found in collection' };

  const filled = await ensureVersionFolder(p.groupingCollectionUid, apiFolder, version, p.specId, key);

  // Move the [latest] label: strip it from siblings, make sure the new one has it.
  for (const f of subfolders(apiFolder)) {
    if (f.id === filled.folderId || !/\[latest\]/i.test(f.name)) continue;
    const stripped = f.name.replace(/\s*\[latest\]\s*/i, ' ').trim();
    await updateCollectionFolder(client, p.groupingCollectionUid, f.id, { name: stripped }).catch((e) =>
      report.warnings.push({ key, warning: `could not relabel '${f.name}'`, error: describe(e) })
    );
  }
  if (!/\[latest\]/i.test(filled.folderName)) {
    await updateCollectionFolder(client, p.groupingCollectionUid, filled.folderId, { name: latestName })
      .then(() => (filled.folderName = latestName))
      .catch((e) => report.warnings.push({ key, warning: `could not label '${filled.folderName}' as latest`, error: describe(e) }));
  }

  p.versionFolderId = filled.folderId;
  p.versionFolderName = filled.folderName;
  p.bindingLevel = 'version';
  p.boundVersion = version;
  return { key, status: filled.created ? 'new-version-folder' : 'reused-version-folder', versionFolder: filled.folderName, added: filled.added };
}

/**
 * Make sure `apiFolder` has a subfolder for `version` holding every endpoint in
 * the spec. Reuses a folder whose name starts with the version token, so a folder
 * HubSpot already created (or one left by an earlier run) is filled in, not
 * duplicated.
 */
async function ensureVersionFolder(collectionUid, apiFolder, version, specId, key) {
  let folder = subfolders(apiFolder).find((f) => versionTokenOf(f.name) === version) ?? null;
  let created = false;
  if (!folder) {
    const name = versionFolderName(version, 'latest');
    const res = await createCollectionFolder(client, collectionUid, name, apiFolder.id);
    const id = folderIdFrom(res);
    if (!id) throw new Error(`could not resolve id of new folder '${name}'`);
    folder = { id, name, item: [] };
    created = true;
  }

  const added = await withGenerated(specId, key, async (genItems) =>
    created
      ? copyItemsInto(collectionUid, folder.id, genItems)
      : addMissing(collectionUid, folder.id, genItems, folder.item ?? [])
  );
  return { folderId: folder.id, folderName: folder.name, created, added };
}

/** Onboard a monorepo API that isn't in state yet. */
async function onboardNewService(svc) {
  const { content, parsed } = readSpec(svc.cell);
  const name = specName(svc.group, svc.api, labelMap);

  let specId = ws?.specsByName.get(name) ?? null;
  let status;
  if (specId) {
    status = 'adopted-existing-spec';
  } else {
    if (!workspaceId) throw new Error('no workspace id (set POSTMAN_WORKSPACE_ID or targetWorkspaceId in state)');
    const created = await createSpec(client, workspaceId, {
      name,
      type: specTypeForOpenApi(parsed?.openapi ?? parsed?.swagger ?? '3.0'),
      rootFileName: basename(svc.cell.specPath),
      content
    });
    specId = created?.id ?? null;
    status = client.dryRun ? 'planned' : 'created';
    if (specId && ws) ws.specsByName.set(name, specId);
  }

  const entry = {
    group: svc.group,
    api: svc.api,
    latestVersion: svc.version,
    selectionReason: svc.selectionReason,
    repo: {
      rollout: svc.cell.rollout,
      otherRollouts: svc.cell.otherRollouts,
      specPath: svc.cell.specPath,
      blobSha: gitBlobSha(svc.cell.specAbsPath),
      githubUrl: githubUrl(svc.cell.specPath),
      curatedCollectionPath: svc.cell.curatedCollectionPath ?? null
    },
    postman: {
      specName: name,
      specId,
      groupingCollection: null,
      groupingCollectionUid: null,
      apiFolderName: null,
      apiFolderId: null,
      versionFolderName: null,
      versionFolderId: null,
      bindingLevel: null,
      boundVersion: null,
      collectionPending: true
    },
    createdBy: 'phase2-sync',
    createdAt: new Date().toISOString()
  };
  state.apis[svc.key] = entry;

  const result = { key: svc.key, version: svc.version, specName: name, specId, status };
  if (args.collections) result.collection = await createCollectionForNew(entry);
  return result;
}

/**
 * Place a new service's collection where HubSpot's taxonomy expects it:
 * "{Group} API Collections" > "{API} API" > "{version} [latest]". Reuses the
 * group's grouping collection (or creates it for a brand-new group) and any
 * folder that already exists by name.
 */
async function createCollectionForNew(entry) {
  const p = entry.postman;
  const version = entry.latestVersion;
  const groupName = groupingCollectionName(entry.group, labelMap);
  const folderName = apiFolderName(entry.api);
  let groupingUid = groupingCollectionForGroup(state, entry.group) ?? ws?.collectionsByName.get(groupName) ?? null;

  if (client.dryRun) {
    return {
      status: 'planned',
      note: groupingUid || !ws
        ? `would add '${folderName}' > '${versionFolderName(version, 'latest')}' to '${groupName}'`
        : `would create '${groupName}' (new group) with '${folderName}' > '${versionFolderName(version, 'latest')}'`
    };
  }
  if (!p.specId) return { status: 'skipped-no-specId' };
  if (!ws) throw new Error('workspace index unavailable; refusing to create collections blind');

  let newGrouping = false;
  if (!groupingUid) {
    const res = await client.post(`/collections?workspace=${encodeURIComponent(workspaceId)}`, {
      collection: { info: { name: groupName, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }
    });
    groupingUid = res?.collection?.uid ?? null;
    if (!groupingUid) throw new Error(`could not create grouping collection '${groupName}'`);
    ws.collectionsByName.set(groupName, groupingUid);
    newGrouping = true;
  }

  const doc = await getCollection(client, groupingUid);
  let apiFolder = subfolders({ item: doc?.collection?.item ?? [] }).find(
    (f) => f.name.trim().toLowerCase() === folderName.toLowerCase()
  );
  if (!apiFolder) {
    const res = await createCollectionFolder(client, groupingUid, folderName);
    const id = folderIdFrom(res);
    if (!id) throw new Error(`could not resolve id of new folder '${folderName}'`);
    apiFolder = { id, name: folderName, item: [] };
  }

  const filled = await ensureVersionFolder(groupingUid, apiFolder, version, p.specId, `${entry.group}/${entry.api}`);

  Object.assign(p, {
    groupingCollection: doc?.collection?.info?.name ?? groupName,
    groupingCollectionUid: groupingUid,
    apiFolderName: apiFolder.name,
    apiFolderId: apiFolder.id,
    versionFolderName: filled.folderName,
    versionFolderId: filled.folderId,
    bindingLevel: 'version',
    boundVersion: version
  });
  delete p.collectionPending;
  return { status: filled.created ? 'created' : 'reused', groupingCollection: p.groupingCollection, newGroupingCollection: newGrouping, versionFolder: filled.folderName, added: filled.added };
}

/** Generate a throwaway collection from the spec, hand its items to fn, always delete it. */
async function withGenerated(specId, key, fn) {
  const gen = await pollTask(client, await generateCollection(client, specId, `__tmp ${key}`));
  const tmpUid = generatedCollectionUid(gen);
  if (!tmpUid) throw new Error('could not resolve generated collection id');
  try {
    const genDoc = await getCollection(client, tmpUid);
    return await fn(genDoc?.collection?.item ?? []);
  } finally {
    await deleteCollection(client, tmpUid).catch(() => {});
  }
}

/** Recursively copy a generated collection's folder/request tree into a folder. */
async function copyItemsInto(collectionUid, parentFolderId, items) {
  let count = 0;
  for (const node of items ?? []) {
    if (Array.isArray(node.item)) {
      const folder = await createCollectionFolder(client, collectionUid, node.name, parentFolderId);
      const childId = folderIdFrom(folder);
      // Without an id the requests would land at the collection root; stop instead.
      if (!childId) throw new Error(`could not resolve id of new folder '${node.name}'`);
      count += await copyItemsInto(collectionUid, childId, node.item);
    } else if (node.request) {
      await createCollectionRequest(client, collectionUid, parentFolderId, toCreatePayload(node.name, node.request));
      count += 1;
    }
  }
  return count;
}

/** Add generated requests that the folder doesn't already have (flat, additive). */
async function addMissing(collectionUid, folderId, genItems, existingItems) {
  let n = 0;
  for (const r of newRequests(genItems, existingItems)) {
    await createCollectionRequest(client, collectionUid, folderId, toCreatePayload(r.name, r.request));
    n += 1;
  }
  return n;
}

/** Existing specs and collections in the workspace, by name (for idempotent creates). */
async function loadWorkspaceIndex() {
  if (offline) {
    report.warnings.push({ warning: 'no POSTMAN_API_KEY: offline preview, workspace duplicate checks skipped' });
    return null;
  }
  if (!workspaceId) {
    report.warnings.push({ warning: 'no workspace id; cannot check for existing specs/collections' });
    return null;
  }
  try {
    const [specs, collections] = await Promise.all([listSpecs(client, workspaceId), listCollections(client, workspaceId)]);
    const specsByName = new Map();
    for (const s of specs) {
      if (specsByName.has(s.name)) report.warnings.push({ warning: `workspace has more than one spec named '${s.name}'` });
      else specsByName.set(s.name, s.id);
    }
    const collectionsByName = new Map();
    for (const c of collections) if (!collectionsByName.has(c.name)) collectionsByName.set(c.name, c.uid);
    return { specsByName, collectionsByName };
  } catch (error) {
    // In apply mode we must not create anything without knowing what exists.
    if (mode === 'apply') throw error;
    report.warnings.push({ warning: 'could not read workspace (plan continues without duplicate checks)', error: describe(error) });
    return null;
  }
}

/** Resolve a generated collection's uid across the generation-response shapes. */
function generatedCollectionUid(gen) {
  return (
    gen?.details?.resources?.[0]?.id ??
    gen?.collection?.uid ??
    gen?.collection?.id ??
    gen?.result?.collection?.uid ??
    gen?.model_id ??
    gen?.id ??
    null
  );
}

function subfolders(node) {
  return (node?.item ?? []).filter((n) => Array.isArray(n.item));
}

function findFolderById(items, id) {
  for (const node of items ?? []) {
    if (!Array.isArray(node.item)) continue;
    if (node.id === id || node.uid === id || String(node.uid ?? '').endsWith(`-${id}`)) return node;
    const nested = findFolderById(node.item, id);
    if (nested) return nested;
  }
  return null;
}

function githubUrl(path) {
  const m = state.monorepo ?? {};
  if (!m.owner || !m.name) return null;
  return `https://github.com/${m.owner}/${m.name}/blob/${m.branch ?? 'main'}/${encodeURI(path)}`;
}

function loadSyncConfig(path) {
  const cfg = loadJsonMap(path, read);
  return {
    ignoreGroups: Array.isArray(cfg.ignoreGroups) ? cfg.ignoreGroups : ['Test'],
    ignoreApis: Array.isArray(cfg.ignoreApis) ? cfg.ignoreApis : [],
    rollApiLevelFolders: cfg.rollApiLevelFolders === true
  };
}

function firstExisting(explicit, candidates) {
  if (explicit) return explicit;
  return candidates.find((p) => existsSync(p)) ?? null;
}

function parseArgs(argv) {
  const get = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  // `||` (not `??`) so an empty env var from an unset Actions secret falls through.
  return {
    apply: argv.includes('--apply'),
    collections: !argv.includes('--no-collections'),
    create: !argv.includes('--no-create'),
    repo: get('--repo') || process.env.HUBSPOT_REPO_PATH || '.',
    state: get('--state') || process.env.STATE_PATH || './.postman/migration-state.json',
    workspace: get('--workspace') || process.env.POSTMAN_WORKSPACE_ID || process.env.TARGET_WORKSPACE_ID || null,
    pmak: get('--pmak') || process.env.POSTMAN_API_KEY,
    groupLabelMap: get('--group-label-map') || process.env.GROUP_LABEL_MAP || null,
    versionMap: get('--version-map') || process.env.VERSION_OVERRIDES || null,
    config: get('--config') || process.env.SYNC_CONFIG || null
  };
}

function read(p) {
  return readFileSync(p, 'utf8');
}

function banner(mode, args) {
  const label = mode === 'apply' ? 'APPLY (mutating)' : 'PLAN (read-only)';
  process.stderr.write(
    `\n${'='.repeat(60)}\nPhase 2 sync: ${label}\n` +
      `repo: ${args.repo}  state: ${args.state}\n` +
      `collections: ${args.collections ? 'on' : 'off'}  new-services: ${args.create ? 'on' : 'off'}\n` +
      `${'='.repeat(60)}\n\n`
  );
}

function printSummary(r, mode) {
  const by = (a) => r.changedSpecs.filter((c) => c.action === a).length;
  const addedEndpoints = r.collectionUpdates.reduce((n, c) => n + (c.added ?? 0), 0);
  const statusCounts = {};
  for (const c of r.collectionUpdates) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  process.stderr.write(
    `\n${mode.toUpperCase()} summary\n` +
      `  version rolls:     ${by('roll')}\n` +
      `  content edits:     ${by('edit')}\n` +
      `  rollout moves:     ${by('moved')}\n` +
      `  new services:      ${r.newServices.length}\n` +
      `  collection steps:  ${r.collectionUpdates.length} ${JSON.stringify(statusCounts)} (${addedEndpoints} endpoint(s) added)\n` +
      `  removed (flagged): ${r.removed.length}\n` +
      `  needs review:      ${r.review.length}\n` +
      `  warnings:          ${r.warnings.length}\n` +
      `  errors:            ${r.errors.length}\n`
  );
  if (r.removed.length) process.stderr.write(`  removed: ${r.removed.map((x) => x.key).join(', ')}\n`);
  for (const e of r.errors) process.stderr.write(`  ERROR ${e.key} (${e.phase}): ${e.error?.message ?? e.error}\n`);
  // Machine-readable report on stdout for the workflow to archive.
  process.stdout.write(JSON.stringify({ mode, ...r }, null, 2) + '\n');
}

function describe(error) {
  if (error && typeof error === 'object') return { message: error.message, status: error.status, body: error.body };
  return { message: String(error) };
}
