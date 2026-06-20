/**
 * Join: link the frontend graph's API/EXTERNAL nodes to the backend graph.
 *
 * Three-stage matching, most specific first:
 *   1. DIRECT — match a backend CONTROLLER by (httpMethod, normPath(endpoint)).
 *      Same key + verbOk rules as the backend's CrossRun S2S matching, so a
 *      frontend `GET /users/{}` resolves to the controller that serves it.
 *   2. ALIAS — if no path matches, probe each segment of the call path against
 *      backend nodes' declared `aliases` (alternate match keys). This handles
 *      endpoints addressed by an opaque token rather than their REST path — e.g.
 *      a NEXCORE `.jmd` transaction whose controller declares alias `TACU0001`,
 *      called from the frontend as `/std/TACU0001`, `/lng/TACU0001`, `/TACU0001`
 *      (with or without `.jmd`): every form reduces to the bare token, so the
 *      context prefix no longer has to be enumerated. Backends that declare no
 *      aliases (e.g. the Spring graph) never participate, so existing joins are
 *      unaffected.
 *   3. GATEWAY fallback — if neither matches (the usual case for calls that
 *      go through an API gateway: the frontend hits a PUBLIC path that the gateway
 *      rewrites before the backend sees it), match a backend GATEWAY node whose
 *      public prefix is a prefix of the call path (longest-prefix wins). The link
 *      then reads `frontend -> gateway`, and the backend's existing `gateway`
 *      edges carry it on to the endpoint — completing `frontend -> gateway ->
 *      endpoint` without forcing a (broken) direct frontend↔controller match.
 *
 * Unmatched calls are listed explicitly so coverage is auditable. Produces a
 * SEPARATE join file (graphs are not merged).
 */

import { CallGraph, Confidence, MethodNode } from './model';
import { normPath, verbOk } from './norm';

export interface JoinLink {
  frontendNodeId: string;
  httpMethod: string | null;
  normalizedPath: string;
  rawUrl: string | null;
  confidence: Confidence | null;
  backendNodeId: string | null;
  backendProject: string | null;
  // `internal` — the call targets an in-repo frontend route (a Next.js route
  // handler), not a backend, so it is NOT a "false external" even though it never
  // joins to the backend graph.
  matchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'internal';
  via: 'direct' | 'alias' | 'gateway' | 'internal' | null; // how it matched (null when unmatched)
  candidates: string[];
}

export interface JoinResult {
  meta: {
    matched: number;
    unmatched: number;
    ambiguous: number;
    internal: number; // calls to in-repo frontend routes (Next.js handlers) — not backend, not external
    viaGateway: number; // of the matched/ambiguous links, how many resolved through a gateway
    viaAlias: number; // ...how many resolved through a backend alias (segment probe)
    viaAffinity: number; // ...how many ambiguous ties an affinity hint broke (fe-svc ↔ backend-project)
  };
  links: JoinLink[];
}

/**
 * fe-svc → backend-project affinity hint. Keys are frontend-service globs
 * (matched against the joined graph's service name); values are backend-project
 * globs. When a call's REST path is served by MORE THAN ONE backend project (the
 * commonest cause of a false "ambiguous" → external), the candidates are narrowed
 * to the project(s) the frontend service is known to talk to. If exactly one
 * survives, the tie is broken and the call counts as `matched` instead of
 * `ambiguous`. A no-op (empty map) leaves every existing join unchanged.
 */
export type Affinity = Map<string, string[]>;

export interface JoinOptions {
  affinity?: Affinity;
  /** The joined frontend graph's service name (graph meta.project), for affinity matching. */
  frontendService?: string | null;
}

/** Glob match: `*` = any run of chars, full-string, case-insensitive. */
function globMatch(value: string | null, pattern: string): boolean {
  if (value == null) return false;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

/** Backend-project globs configured for [fesvc] — the union over every matching fe-svc key. */
function affinityPatternsFor(fesvc: string | null, aff: Affinity): string[] {
  if (!fesvc || aff.size === 0) return [];
  const out: string[] = [];
  for (const [key, pats] of aff) if (globMatch(fesvc, key)) out.push(...pats);
  return out;
}

/**
 * Narrow tied backend candidates to those whose project matches the fe-svc's
 * affinity patterns. Returns the lone survivor, or null when 0 / 2+ survive (no
 * confident pick — leave the call ambiguous).
 */
function pickByAffinity(fesvc: string | null, candidates: MethodNode[], aff: Affinity): MethodNode | null {
  const pats = affinityPatternsFor(fesvc, aff);
  if (!pats.length) return null;
  const picked = candidates.filter((c) => pats.some((p) => globMatch(c.project, p)));
  return picked.length === 1 ? picked[0] : null;
}

/**
 * Match a call path to a GATEWAY node by public-prefix. A gateway node's
 * `endpoint` is the frontend-facing prefix (e.g. `/api/sib`); a call to
 * `/api/sib/customers/{}` belongs to it. Longest matching prefix wins (most
 * specific route); a catch-all `/` route matches only the exact `/` path so it
 * is not greedily claimed. Returns the chosen node + any same-length ties.
 */
function matchGateway(
  gateways: MethodNode[],
  np: string,
  verb: string | null,
): { chosen: MethodNode | null; tied: MethodNode[] } {
  const cands = gateways.filter((g) => {
    if (!verbOk(g.httpMethod, verb)) return false;
    const gp = normPath(g.endpoint);
    if (gp === '' ) return false;
    if (gp === '/') return np === '/';
    return np === gp || np.startsWith(gp + '/');
  });
  if (cands.length === 0) return { chosen: null, tied: [] };
  const maxLen = Math.max(...cands.map((g) => normPath(g.endpoint).length));
  const best = cands.filter((g) => normPath(g.endpoint).length === maxLen);
  return { chosen: best[0], tied: best.length > 1 ? best : [] };
}

/**
 * Match a call path to a backend node by ALIAS. The path is split into segments,
 * each segment's `.jmd` extension stripped, and each is looked up in [aliasIndex]
 * (built from backend nodes' `aliases`). First segment that hits wins, so a context
 * prefix (`/std`, `/lng`, none) is ignored automatically — only the token segment
 * (e.g. `TACU0001`) is in the index. Returns the chosen node + any same-key ties.
 */
function matchAlias(
  aliasIndex: Map<string, MethodNode[]>,
  np: string,
  verb: string | null,
): { chosen: MethodNode | null; tied: MethodNode[] } {
  if (aliasIndex.size === 0) return { chosen: null, tied: [] };
  const segs = np.split('/').filter((s) => s.length > 0).map((s) => s.replace(/\.jmd$/i, ''));
  for (const s of segs) {
    const cands = (aliasIndex.get(s) ?? []).filter((n) => verbOk(n.httpMethod, verb));
    if (cands.length > 0) return { chosen: cands[0], tied: cands.length > 1 ? cands : [] };
  }
  return { chosen: null, tied: [] };
}

/** Tokens that hint at the target service (Feign-name analog): host + ${...} segments. */
function hintTokens(n: MethodNode): string[] {
  const toks: string[] = [];
  if (n.externalService) toks.push(n.externalService);
  for (const raw of [n.externalUrl, n.urlPlaceholder]) {
    if (!raw) continue;
    const re = /\$\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) toks.push(m[1].split('.').pop()!);
  }
  return toks.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((t) => t.length > 0);
}

function projectMatchesHint(project: string | null, tokens: string[]): boolean {
  if (!project || !tokens.length) return false;
  const p = project.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tokens.some((t) => t === p || t.includes(p) || p.includes(t));
}

export function join(frontend: CallGraph, backend: CallGraph, opts: JoinOptions = {}): JoinResult {
  const affinity = opts.affinity ?? new Map<string, string[]>();
  const fesvc = opts.frontendService ?? null;
  let viaAffinity = 0; // ambiguous ties broken by an affinity hint (any tier)
  // index backend controller endpoints + gateway route nodes
  const providers = backend.nodes.filter((n) => n.layer === 'CONTROLLER' && n.endpoint && n.endpoint.length > 0);
  const gateways = backend.nodes.filter((n) => n.layer === 'GATEWAY' && n.endpoint && n.endpoint.length > 0);
  // alias index: every backend node that declares alternate match keys (e.g. a
  // nexcore `.jmd` transaction id). Empty for backends without aliases (Spring).
  const aliasIndex = new Map<string, MethodNode[]>();
  for (const n of backend.nodes) {
    for (const a of n.aliases ?? []) {
      if (!a) continue;
      const list = aliasIndex.get(a);
      if (list) list.push(n);
      else aliasIndex.set(a, [n]);
    }
  }

  const links: JoinLink[] = [];
  const apiNodes = frontend.nodes.filter((n) => (n.layer === 'API' || n.layer === 'EXTERNAL') && n.endpoint);

  // Internal-route set: in-repo provider endpoints (Next.js route handlers, Express/
  // Vite in-repo routers). A call to one of these is internal (frontend→handler), not
  // a backend call. The provider node itself carries the marker; a consumer node that
  // did NOT merge with it (e.g. a GET call vs an ANY `use` handler) is caught by its
  // (normPath, verb) matching the set — so neither is mislabelled a false external.
  const internalRoutes = apiNodes
    .filter((n) => n.description === 'next-route-handler' || n.description === 'express-route-handler')
    .map((n) => ({ np: normPath(n.endpoint), method: n.httpMethod }));
  const isInternalCall = (fn: MethodNode): boolean => {
    if (fn.description === 'next-route-handler' || fn.description === 'express-route-handler') return true;
    const np = normPath(fn.endpoint);
    return internalRoutes.some((r) => r.np === np && verbOk(r.method, fn.httpMethod));
  };

  for (const fn of apiNodes) {
    const np = normPath(fn.endpoint);

    let backendNodeId: string | null = null;
    let backendProject: string | null = null;
    let status: JoinLink['matchStatus'] = 'unmatched';
    let via: JoinLink['via'] = null;
    let candidates: string[] = [];

    // 0) in-repo frontend route (a Next.js route handler, or an Express/Vite in-repo
    //    router) — the call's own provider lives in this graph, not the backend. It can
    //    never match a backend node, so counting it as `unmatched` mislabels an internal
    //    route as a false external. Classify it `internal` and skip the backend tiers.
    if (isInternalCall(fn)) {
      status = 'internal';
      via = 'internal';
    } else {
      const matches = providers.filter((p) => normPath(p.endpoint) === np && verbOk(p.httpMethod, fn.httpMethod));

      if (matches.length === 1) {
        // 1) direct controller match
        backendNodeId = matches[0].id;
        backendProject = matches[0].project;
        status = 'matched';
        via = 'direct';
      } else if (matches.length > 1) {
        // Tie: prefer a host/${} token hint, then a fe-svc↔backend-project affinity hint.
        const hints = hintTokens(fn);
        let preferred = matches.find((p) => projectMatchesHint(p.project, hints));
        if (!preferred) {
          const picked = pickByAffinity(fesvc, matches, affinity);
          if (picked) { preferred = picked; viaAffinity++; }
        }
        const chosen = preferred ?? matches[0];
        backendNodeId = chosen.id;
        backendProject = chosen.project;
        status = preferred ? 'matched' : 'ambiguous';
        via = 'direct';
        candidates = matches.map((p) => p.id);
      } else {
        // 2) alias probe — opaque-token endpoints (e.g. nexcore `.jmd` transaction id)
        const al = matchAlias(aliasIndex, np, fn.httpMethod);
        if (al.chosen) {
          via = 'alias';
          candidates = al.tied.map((n) => n.id);
          const picked = al.tied.length > 0 ? pickByAffinity(fesvc, al.tied, affinity) : null;
          const chosen = picked ?? al.chosen;
          if (picked) viaAffinity++;
          backendNodeId = chosen.id;
          backendProject = chosen.project;
          status = al.tied.length > 0 && !picked ? 'ambiguous' : 'matched';
        } else {
          // 3) gateway fallback — public path the gateway rewrites before the backend
          const gw = matchGateway(gateways, np, fn.httpMethod);
          if (gw.chosen) {
            via = 'gateway';
            candidates = gw.tied.map((g) => g.id);
            const picked = gw.tied.length > 0 ? pickByAffinity(fesvc, gw.tied, affinity) : null;
            const chosen = picked ?? gw.chosen;
            if (picked) viaAffinity++;
            backendNodeId = chosen.id;
            backendProject = chosen.project;
            status = gw.tied.length > 0 && !picked ? 'ambiguous' : 'matched';
          }
        }
      }
    }

    links.push({
      frontendNodeId: fn.id,
      httpMethod: fn.httpMethod,
      normalizedPath: np,
      rawUrl: fn.externalUrl,
      confidence: fn.confidence,
      backendNodeId,
      backendProject,
      matchStatus: status,
      via,
      candidates,
    });
  }

  return {
    meta: {
      matched: links.filter((l) => l.matchStatus === 'matched').length,
      unmatched: links.filter((l) => l.matchStatus === 'unmatched').length,
      ambiguous: links.filter((l) => l.matchStatus === 'ambiguous').length,
      internal: links.filter((l) => l.matchStatus === 'internal').length,
      viaGateway: links.filter((l) => l.via === 'gateway' && l.matchStatus !== 'unmatched').length,
      viaAlias: links.filter((l) => l.via === 'alias' && l.matchStatus !== 'unmatched').length,
      viaAffinity,
    },
    links,
  };
}
