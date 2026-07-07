import { Env } from "..";
import { errorString } from "./utils";
import { isValidDigest } from "./user";

// Header set on responses for cacheable paths indicating whether the response
// was served from the edge cache ("HIT") or from the origin (R2) ("MISS").
export const EDGE_CACHE_STATUS_HEADER = "X-Registry-Cache";

// Digest-addressed content (blobs and manifests fetched by digest) is immutable:
// the digest is the sha256 of the content. The TTL only bounds how long deleted
// content can still be served from a data center that cached it.
export const IMMUTABLE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// Manifests fetched by tag are mutable (a new push can retag). cache.delete()
// only purges the data center that ran the Worker, so this TTL is the upper
// bound on how long other data centers can serve a stale tag.
export const TAG_MAX_AGE_SECONDS = 60;

// The Cache API refuses to store bodies over 512MB.
const MAXIMUM_CACHEABLE_BYTES = 512 * 1024 * 1024;

export function edgeCacheEnabled(env: Env): boolean {
  return env.EDGE_CACHE !== "off";
}

// Only content-addressable read endpoints are cached:
//   /v2/<name>/manifests/<tag|digest> and /v2/<name>/blobs/<digest>.
// Upload paths (/v2/<name>/blobs/uploads/...) and list endpoints (_catalog,
// tags/list, referrers) never match this regex. It re-states the two route
// shapes owned by src/router.ts; if they ever fall out of sync the failure
// mode is safe — unmatched paths are simply not cached.
const cacheablePathRegex = /^\/v2\/.+\/(manifests|blobs)\/([^/]+)$/;

function maxAgeForPath(pathname: string): number | null {
  const match = cacheablePathRegex.exec(pathname);
  if (match === null) {
    return null;
  }

  const [, kind, rawReference] = match;
  if (kind === "blobs") {
    return IMMUTABLE_MAX_AGE_SECONDS;
  }

  // The router matches against the decoded reference (sha256%3A... is served
  // as a digest), so classify the same way
  let reference = rawReference;
  try {
    reference = decodeURIComponent(rawReference);
  } catch {
    // not valid percent-encoding, classify the raw segment
  }

  return isValidDigest(reference) ? IMMUTABLE_MAX_AGE_SECONDS : TAG_MAX_AGE_SECONDS;
}

// The cache key ignores every request header, so the entry is shared across
// clients; authentication has already happened in the main fetch handler.
function cacheKey(url: string): Request {
  return new Request(url);
}

function toClientResponse(cached: Response, method: string, context: ExecutionContext): Response {
  const response = method === "HEAD" ? new Response(null, cached) : new Response(cached.body, cached);
  if (method === "HEAD" && cached.body !== null) {
    context.waitUntil(cached.body.cancel().catch(() => {}));
  }

  // The stored Cache-Control only exists to set the edge TTL. It must not reach
  // clients: "public" would allow shared HTTP caches between the client and
  // Cloudflare to store responses that required authentication.
  response.headers.delete("Cache-Control");
  return response;
}

// A copy is made instead of mutating in place because responses that come out
// of fetch() or the Cache API have immutable headers.
function withCacheStatus(response: Response, status: "HIT" | "MISS"): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set(EDGE_CACHE_STATUS_HEADER, status);
  return wrapped;
}

function storeInEdgeCache(cache: Cache, url: string, response: Response, maxAge: number, context: ExecutionContext) {
  // Content-Length is also what lets cache.match() synthesize 206 responses
  // for ranged requests, so don't store responses without it.
  const contentLength = Number(response.headers.get("Content-Length") ?? NaN);
  if (!Number.isFinite(contentLength) || contentLength > MAXIMUM_CACHEABLE_BYTES) {
    return;
  }

  // Storing is best effort and must never break the response being served
  try {
    const forCache = withCacheStatus(response.clone(), "HIT");
    forCache.headers.set("Cache-Control", `public, max-age=${maxAge}`);
    context.waitUntil(
      cache.put(cacheKey(url), forCache).catch((err) => {
        console.error("edge cache: error storing response:", errorString(err));
      }),
    );
  } catch (err) {
    console.error("edge cache: error storing response:", errorString(err));
  }
}

// Purges the cached manifest entries for the given references. The DELETE
// manifest handler uses this when deleting by digest, which also removes every
// tag alias of that digest from R2: the tags' cache entries must not outlive
// their R2 objects. Like all invalidation here, it only purges the data center
// that runs the Worker.
export async function purgeCachedManifests(
  env: Env,
  requestUrl: URL,
  name: string,
  references: string[],
): Promise<void> {
  if (!edgeCacheEnabled(env) || references.length === 0) {
    return;
  }

  await Promise.all(
    references.map((reference) =>
      caches.default.delete(cacheKey(new URL(`/v2/${name}/manifests/${reference}`, requestUrl).toString())),
    ),
  );
}

// Wraps the v2 router for read-through edge caching of manifest and blob
// downloads. Must only run after the request has been authenticated.
//
// Note that the Cache API is a no-op on *.workers.dev domains; caching only
// takes effect when the Worker runs on a custom domain or route.
export async function withEdgeCache(
  request: Request,
  env: Env,
  context: ExecutionContext,
  next: () => Promise<Response>,
): Promise<Response> {
  const isRead = request.method === "GET" || request.method === "HEAD";
  const isWrite = request.method === "PUT" || request.method === "DELETE";
  if ((!isRead && !isWrite) || !edgeCacheEnabled(env)) {
    return await next();
  }

  const url = new URL(request.url);
  const maxAge = maxAgeForPath(url.pathname);
  if (maxAge === null) {
    return await next();
  }

  const cache = caches.default;
  const cacheUrl = url.toString();

  if (isRead) {
    // Matching with the original request (instead of the header-less cache key)
    // lets cache.match() honor Range headers by synthesizing a 206 response.
    const matchRequest = new Request(cacheUrl, request);
    const cached = await cache.match(matchRequest, { ignoreMethod: request.method === "HEAD" });
    if (cached !== undefined) {
      return toClientResponse(cached, request.method, context);
    }

    const response = await next();
    if (request.method === "GET" && response.status === 200) {
      storeInEdgeCache(cache, cacheUrl, response, maxAge, context);
    }

    return withCacheStatus(response, "MISS");
  }

  // PUT or DELETE
  const response = await next();
  if (response.status >= 200 && response.status < 300) {
    // Awaited so that a client that writes and immediately reads back gets
    // fresh data from this data center; other data centers rely on the TTL.
    await cache.delete(cacheKey(cacheUrl));
  }

  return response;
}
