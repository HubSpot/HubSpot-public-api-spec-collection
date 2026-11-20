/**
 * Additive collection sync — the doc-preserving strategy.
 *
 * Postman's native spec→collection sync (and PUT /collections replace) rebuild
 * the whole collection, which would wipe HubSpot's curated descriptions and
 * examples. Instead we:
 *   1. generate a throwaway collection from the (updated) spec,
 *   2. diff its requests against the curated folder by (METHOD + normalized path),
 *   3. create ONLY the missing requests in the curated folder,
 *   4. delete the throwaway collection.
 * Existing curated requests are never modified or removed, so documentation and
 * examples stay exactly as HubSpot wrote them.
 *
 * These are pure functions (no network) so they're unit-testable; the network
 * orchestration lives in sync.mjs.
 */

/** Recursively flatten a collection item tree into request leaves. */
export function flattenRequests(items, trail = []) {
  const out = [];
  for (const node of items ?? []) {
    if (Array.isArray(node.item)) {
      out.push(...flattenRequests(node.item, [...trail, node.name]));
    } else if (node.request) {
      out.push({ name: node.name, trail, request: node.request });
    }
  }
  return out;
}

/** Raw URL string from a collection request (handles string or {raw} object). */
export function rawUrl(request) {
  const u = request?.url;
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (typeof u.raw === 'string') return u.raw;
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host ?? '');
  const path = Array.isArray(u.path) ? u.path.join('/') : (u.path ?? '');
  return `${host}/${path}`;
}

/**
 * A stable request signature: METHOD + path with host, query, and path-variable
 * names normalized away, so "{{baseUrl}}/crm/v3/objects/{objectId}" and
 * "https://api.hubapi.com/crm/v3/objects/:objectId" collapse to the same key.
 */
export function requestSignature(method, url) {
  const m = String(method ?? 'GET').toUpperCase();
  let path = String(url ?? '');
  path = path.replace(/^\{\{[^}]+\}\}/, ''); // leading {{baseUrl}}
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''); // scheme://host
  path = path.split(/[?#]/)[0]; // drop query/fragment
  path = path.replace(/\{\{[^}]+\}\}/g, ''); // stray variables
  path = path
    .split('/')
    .map((seg) => (/^[:{]/.test(seg) ? ':var' : seg)) // :id / {id} → :var
    .join('/');
  path = path.replace(/\/+/g, '/').replace(/\/$/, ''); // tidy slashes
  return `${m} ${path || '/'}`;
}

/** Set of signatures already present in a folder's existing requests. */
export function existingSignatures(existingItems) {
  const set = new Set();
  for (const r of flattenRequests(existingItems)) {
    set.add(requestSignature(r.request?.method, rawUrl(r.request)));
  }
  return set;
}

/**
 * Requests present in the freshly generated collection but NOT in the curated
 * folder — i.e. the new endpoints to add.
 * @returns {Array<{ name:string, request:object, signature:string }>}
 */
export function newRequests(generatedItems, existingItems) {
  const have = existingSignatures(existingItems);
  const seen = new Set();
  const out = [];
  for (const r of flattenRequests(generatedItems)) {
    const sig = requestSignature(r.request?.method, rawUrl(r.request));
    if (have.has(sig) || seen.has(sig)) continue;
    seen.add(sig);
    out.push({ name: r.name, request: r.request, signature: sig });
  }
  return out;
}

/**
 * Map a collection v2.1 request into the createCollectionRequest body shape.
 * Kept faithful but minimal: name, method, url, description, headers, raw body.
 */
export function toCreatePayload(name, request) {
  const payload = {
    name: name ?? 'Untitled request',
    method: String(request?.method ?? 'GET').toUpperCase(),
    url: rawUrl(request)
  };
  if (request?.description) payload.description = request.description;

  const headers = Array.isArray(request?.header) ? request.header : [];
  if (headers.length) {
    payload.headerData = headers.map((h) => ({
      key: h.key,
      value: h.value ?? '',
      description: h.description
    }));
  }

  const body = request?.body;
  if (body?.mode === 'raw' && typeof body.raw === 'string') {
    payload.dataMode = 'raw';
    payload.rawModeData = body.raw;
    const lang = body.options?.raw?.language;
    if (lang) payload.dataOptions = { raw: { language: lang } };
  }
  return payload;
}
