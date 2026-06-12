/**
 * Path-normalization functions — the load-bearing JOIN KEY between the React
 * graph and the Spring backend graph. These are byte-for-byte ports of the
 * backend so that a frontend API node's (httpMethod, normalizedPath) matches a
 * backend CONTROLLER node's key exactly.
 *
 * Ports of:
 *   - RestDocs.normalize  (kotlin-analyzer .../RestDocs.kt:40)   -> normalize()
 *   - CrossRun.normPath   (kotlin-analyzer .../CrossRun.kt:71)   -> normPath()
 *   - CrossRun.verbOk     (kotlin-analyzer .../CrossRun.kt:78)   -> verbOk()
 *
 * Any divergence here silently breaks the join, so this module is covered by a
 * golden test table mirrored from the backend (see test/norm.spec.ts).
 */

// UUID-ish id segment, e.g. "550e8400-e29b-41d4-a716-446655440000".
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$/;

function looksLikeId(seg: string): boolean {
  return (seg.length > 0 && /^[0-9]+$/.test(seg)) || UUID_RE.test(seg);
}

/**
 * Canonical endpoint form. Splits on '/', drops empty segments, replaces any
 * segment that is a path variable ("{...}") or looks like a concrete id with
 * "{}", and rejoins with a leading '/'. Empty/undefined -> "".
 *
 * Mirrors RestDocs.normalize.
 */
export function normalize(path: string | null | undefined): string {
  if (path == null || path === '') return '';
  const parts = path
    .split('?')[0]
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) => (seg.startsWith('{') || looksLikeId(seg) ? '{}' : seg));
  return '/' + parts.join('/');
}

/**
 * Match-time path normalization: strip query, collapse any "{...}" placeholder
 * to "{}", trim a trailing slash (when length > 1). Empty/undefined -> "".
 *
 * Mirrors CrossRun.normPath. NOTE this does NOT collapse concrete ids the way
 * normalize() does — the backend applies normalize() to controller endpoints at
 * build time and normPath() at match time, so both sides should already be in
 * "{}" form. We keep the same split of responsibilities.
 */
export function normPath(p: string | null | undefined): string {
  if (p == null || p === '') return '';
  let s = p.split('?')[0].replace(/\{[^}]*\}/g, '{}');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/**
 * HTTP verb compatibility. A null/"ANY" verb on either side is a wildcard.
 * Mirrors CrossRun.verbOk.
 */
export function verbOk(providerVerb: string | null | undefined, callVerb: string | null | undefined): boolean {
  return (
    callVerb == null ||
    callVerb === 'ANY' ||
    providerVerb == null ||
    providerVerb === 'ANY' ||
    providerVerb === callVerb
  );
}
