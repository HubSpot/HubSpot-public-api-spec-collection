/**
 * Postman public-API wrapper for the Phase 2 ongoing sync.
 *
 * Same dryRun contract as Phase 1: in plan mode every POST/PUT/DELETE is
 * recorded and a synthetic response returned, so a run reports exactly what it
 * WOULD change without touching the workspace. GET always hits the network so
 * plan mode still reflects live state.
 */

/**
 * @typedef {Object} PostmanClient
 * @property {boolean} dryRun
 * @property {Array<{method:string,path:string,body?:any}>} planned
 * @property {(p:string,h?:object)=>Promise<any>} get
 * @property {(p:string,b:any,h?:object)=>Promise<any>} post
 * @property {(p:string,b:any,h?:object)=>Promise<any>} put
 * @property {(p:string,b:any,h?:object)=>Promise<any>} patch
 * @property {(p:string,h?:object)=>Promise<any>} del
 */

/**
 * Works with either a personal API key or a service account API key: both go in
 * the X-Api-Key header. (A service account's short-lived access token is for the
 * Postman CLI, not the Postman API, so it is not used here.)
 *
 * Retries: 429 is retried for every method (the request was rejected, not
 * processed), honoring Retry-After. 502/503/504 and network errors are retried
 * for GET only, since a write may already have landed.
 *
 * @param {{ apiKey:string, baseUrl?:string, dryRun?:boolean, maxRetries?:number,
 *           fetchImpl?:typeof fetch, sleepImpl?:(ms:number)=>Promise<void> }} options
 */
export function createPostmanClient(options) {
  const baseUrl = options.baseUrl || 'https://api.getpostman.com';
  const apiKey = options.apiKey;
  const dryRun = options.dryRun ?? false;
  const maxRetries = options.maxRetries ?? 5;
  const doFetch = options.fetchImpl ?? fetch;
  const wait = options.sleepImpl ?? sleep;
  const planned = [];
  if (!apiKey) throw new Error('PostmanClient: apiKey required');

  async function request(method, path, body, extraHeaders = {}) {
    if (dryRun && method !== 'GET') {
      planned.push({ method, path, body });
      return { __planned: true, method, path };
    }
    const init = {
      method,
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json', ...extraHeaders }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await doFetch(baseUrl + path, init);
      } catch (networkError) {
        if (method === 'GET' && attempt < maxRetries) {
          await wait(backoffMs(attempt));
          continue;
        }
        throw networkError;
      }

      const retryable =
        response.status === 429 || (method === 'GET' && [502, 503, 504].includes(response.status));
      if (retryable && attempt < maxRetries) {
        await wait(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }

      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const error = new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.body = parsed;
        throw error;
      }
      return parsed;
    }
  }

  return {
    dryRun,
    planned,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b, h),
    put: (p, b, h) => request('PUT', p, b, h),
    patch: (p, b, h) => request('PATCH', p, b, h),
    del: (p, h) => request('DELETE', p, undefined, h)
  };
}

export function specTypeForOpenApi(openapiVersion) {
  return String(openapiVersion ?? '').startsWith('3.1') ? 'OPENAPI:3.1' : 'OPENAPI:3.0';
}

/** POST /specs?workspaceId= — create a spec from monorepo JSON. */
export function createSpec(client, workspaceId, spec) {
  return client.post(`/specs?workspaceId=${encodeURIComponent(workspaceId)}`, {
    name: spec.name,
    type: spec.type,
    files: [{ path: spec.rootFileName, content: spec.content }]
  });
}

/** GET /specs/{specId}/files — list a spec's files (to find the ROOT path). */
export function getSpecFiles(client, specId) {
  return client.get(`/specs/${encodeURIComponent(specId)}/files`);
}

/**
 * PATCH /specs/{specId}/files/{filePath} — replace a spec file's content. This is
 * how a changed monorepo spec is pushed to the SAME specId (the spec name/id are
 * stable, so links never break). Note: the Spec Hub file endpoint is PATCH, not
 * PUT (PUT 404s), and the body must carry exactly one property (`content`).
 */
export function updateSpecFileContent(client, specId, filePath, content) {
  return client.patch(
    `/specs/${encodeURIComponent(specId)}/files/${encodeURIComponent(filePath)}`,
    { content }
  );
}

/** GET /specs/{specId}/collections — collections generated from / linked to a spec. */
export function getSpecCollections(client, specId) {
  return client.get(`/specs/${encodeURIComponent(specId)}/collections`);
}

/**
 * POST /specs/{specId}/generations/collection — generate a collection from a spec.
 * The element type ("collection") is a PATH segment, not a body/query field.
 * Async: returns HTTP 202 with { taskId, url }. Use {@link pollTask} to await it.
 */
export function generateCollection(client, specId, name, options = {}) {
  return client.post(`/specs/${encodeURIComponent(specId)}/generations/collection`, {
    name,
    options: {
      requestNameSource: 'Fallback',
      parametersResolution: 'Example',
      folderStrategy: 'Paths',
      ...options
    }
  });
}

/** GET /collections/{uid} — full collection document incl. folder/request tree. */
export function getCollection(client, uid) {
  return client.get(`/collections/${encodeURIComponent(uid)}`);
}

/** POST /collections/{id}/folders — create a folder (optionally nested via folder). */
export function createCollectionFolder(client, collectionId, name, parentFolderId = null) {
  const body = { name };
  if (parentFolderId) body.folder = parentFolderId;
  return client.post(`/collections/${encodeURIComponent(collectionId)}/folders`, body);
}

/**
 * The owner prefix on a collection uid ("{ownerId}-{uuid}"). Folder/request items
 * in the same collection share this prefix in their uid form.
 */
export function ownerPrefix(collectionUid) {
  const s = String(collectionUid ?? '');
  const dash = s.indexOf('-');
  return dash > 0 ? s.slice(0, dash) : null;
}

/**
 * Normalize a folder/request id to the PREFIXED uid the granular item endpoints
 * require in the path (e.g. PUT/DELETE .../folders/{uid}). Phase 1 stores the BARE
 * id (from the collection tree); POST ?folder= accepts the bare id but path-addressed
 * PUT/DELETE do not — they 404 ("instanceNotFound") without the owner prefix.
 */
export function toItemUid(collectionUid, id) {
  if (!id) return id;
  const prefix = ownerPrefix(collectionUid);
  if (!prefix) return id;
  return String(id).startsWith(`${prefix}-`) ? id : `${prefix}-${id}`;
}

/**
 * PUT /collections/{id}/folders/{folderId} — PATCH-like update. Used to relabel a
 * version subfolder (e.g. strip "[latest]" from the previous latest version). The
 * folder must be addressed by its prefixed uid, so we normalize the (possibly bare)
 * id first.
 */
export function updateCollectionFolder(client, collectionId, folderId, patch) {
  return client.put(
    `/collections/${encodeURIComponent(collectionId)}/folders/${encodeURIComponent(
      toItemUid(collectionId, folderId)
    )}`,
    patch
  );
}

/** Extract a newly-created folder's id across the API's response shapes. */
export function folderIdFrom(res) {
  return res?.data?.id ?? res?.model_id ?? res?.id ?? res?.folder?.id ?? null;
}

/**
 * POST /collections/{id}/requests[?folder=] — ADDITIVELY create one request in a
 * folder. This is the doc-preserving primitive: it only inserts, so curated
 * requests/examples/descriptions already in the folder are never touched.
 */
export function createCollectionRequest(client, collectionId, folderId, request) {
  const q = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
  return client.post(`/collections/${encodeURIComponent(collectionId)}/requests${q}`, request);
}

/** DELETE /collections/{uid} — used only to remove a throwaway generated collection. */
export function deleteCollection(client, uid) {
  return client.del(`/collections/${encodeURIComponent(uid)}`);
}

/**
 * Poll an async task (generation, etc.) to completion. Postman returns a task
 * with a status URL; we poll until it's finished or times out. In dry-run the
 * task is synthetic, so we short-circuit.
 * @returns {Promise<any>} the finished task document
 */
export async function pollTask(client, task, { intervalMs = 1500, timeoutMs = 60000 } = {}) {
  if (client.dryRun || task?.__planned) return task;
  // The generations endpoint returns { taskId, url:"/specs/{id}/tasks/{taskId}" }.
  const href = task?.url ?? task?.metadata?.taskLink ?? task?.taskLink ?? task?.links?.status ?? null;
  const taskId = task?.taskId ?? task?.id ?? null;
  const url = href ?? (taskId ? `/tasks/${encodeURIComponent(taskId)}` : null);
  if (!url) return task; // nothing to poll; caller handles the raw response
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;

  const deadline = Date.now() + timeoutMs;
  let last = task;
  while (Date.now() < deadline) {
    last = await client.get(path);
    const status = String(last?.status ?? last?.state ?? '').toLowerCase();
    if (['completed', 'success', 'succeeded', 'done'].includes(status)) return last;
    if (['failed', 'error'].includes(status)) {
      const err = new Error(`async task failed: ${JSON.stringify(last)}`);
      err.body = last;
      throw err;
    }
    await sleep(intervalMs);
  }
  const err = new Error('async task timed out');
  err.body = last;
  throw err;
}

/**
 * GET /specs?workspaceId= (all pages) — every spec in the workspace. Used to make
 * new-service onboarding idempotent: a spec with the expected name is reused
 * instead of created again.
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listSpecs(client, workspaceId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const q = new URLSearchParams({ workspaceId, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const res = await client.get(`/specs?${q}`);
    out.push(...(res?.specs ?? res?.data ?? []));
    cursor = res?.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** GET /collections?workspace= — every collection in the workspace (uid + name). */
export async function listCollections(client, workspaceId) {
  const res = await client.get(`/collections?workspace=${encodeURIComponent(workspaceId)}`);
  return res?.collections ?? [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with a little jitter: ~1s, 2s, 4s, 8s, 16s (capped at 30s). */
export function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Honor Retry-After (seconds or HTTP date) when the API sends it. */
export function retryAfterMs(response) {
  const h = response?.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(60000, Math.max(0, secs * 1000));
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(60000, Math.max(0, at - Date.now())) : null;
}
