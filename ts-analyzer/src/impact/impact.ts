/**
 * Change-impact analysis for a frontend graph — a port of the Spring analyzer's
 * Impact.kt, with its backend CONTROLLER entry-point mapped to the frontend's
 * entry-point analog, the SCREEN (page). Emitted as a LEAN INDEX + per-PR SHARDS
 * so the index doesn't grow with every node a PR touches.
 *
 * - INDEX (`<base>.impact.json`): per-PR metadata, `changedNodeCount`,
 *   `changedFileCount`, and `impactedEndpoints` — the SCREEN nodes a PR's changed
 *   API surface reaches, found by a reverse walk over the render/call graph. The
 *   key is named `impactedEndpoints` (not `impactedScreens`) for byte-for-byte
 *   parity with the Spring impact JSON the flowmap UI consumes: a frontend SCREEN
 *   is the entry-point analog of a backend CONTROLLER endpoint, so it fills the
 *   same slot (route → `endpoint`, project → `service`, `httpMethod` is null).
 * - SHARD (`<base>.impact/<number>.json`): the heavy per-PR detail
 *   (`changedNodes` with visibility/inGraph/kind, `changedApiMethods` seeds,
 *   `changedFiles`, `deletedNodes`), lazy-loaded by the UI on commit open.
 *
 * Changed model: a node is "changed" in a PR when the merge commit's NEW-side
 * changed line ranges intersect the node's range at that revision ([fileParser]
 * on the blob). Nodes absent from the current graph report `inGraph:false`.
 *
 * API surface = changed nodes whose visibility is not `local` (the frontend
 * analog of Spring's non-`private`): exported components/hooks/actions another
 * module could render/call. These seed the reverse walk to screens.
 *
 * Deletion model: nodes present in the PR's base blob but gone after the merge
 * are "deleted" (reported in the shard). The Spring side's deleted-ENDPOINT
 * breaking analysis is endpoint-semantic and intentionally dropped here (the
 * frontend impact target is screens, not served endpoints).
 */

import * as path from 'path';
import { CallGraph, MethodNode } from '../model';
import { FnRange, functions, visibilityOf } from './fileParser';
import * as git from './git';

export interface ImpactResult {
  index: Record<string, unknown>;
  shards: Map<number, Record<string, unknown>>;
}

const SOURCE_EXT = /\.(tsx|ts|jsx|js|mjs|cjs|vue)$/i;

/**
 * Analyze change impact for [pulls] against the current [graph]. [prefix] is the
 * repo-relative project dir (e.g. "front-official-desktop") prepended to git
 * paths so blob-derived ids match the graph's `<prefix>/...::Name` node ids.
 */
export function analyze(repo: string, base: string, prefix: string, pulls: git.Pr[], graph: CallGraph): ImpactResult {
  const webBase = git.webBaseUrl(repo);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // callers adjacency: target id -> source ids (for the reverse walk to screens)
  const callers = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = callers.get(e.target);
    if (list) list.push(e.source);
    else callers.set(e.target, [e.source]);
  }

  const perPullIndex: Array<Record<string, unknown>> = [];
  const shards = new Map<number, Record<string, unknown>>();
  const allChangedInGraph = new Set<string>();
  const allImpacted = new Set<string>();

  for (const pr of pulls) {
    const sha = pr.mergeCommit;
    if (!sha) continue;
    const parent = git.firstParent(repo, sha);
    const changes = git.changesIn(repo, sha);
    const changedFns = new Map<string, FnRange>(); // id -> changed node's range (first-seen wins)
    const deletedIds = new Set<string>();

    for (const ch of changes) {
      if (!SOURCE_EXT.test(ch.path)) continue; // non-source file: no node mapping
      const idPath = prefix ? `${prefix}/${ch.path}` : ch.path;
      const newFns =
        ch.changeType === 'DELETE' ? [] : parseBlob(git.fileAt(repo, sha, ch.path), idPath);

      // changed nodes: hunks ∩ new-revision node ranges
      if (ch.changeType !== 'DELETE' && ch.newRanges.length) {
        for (const fn of newFns) {
          if (ch.newRanges.some(([s, e]) => s <= fn.endLine && fn.startLine <= e) && !changedFns.has(fn.nodeId)) {
            changedFns.set(fn.nodeId, fn);
          }
        }
      }

      // deleted nodes: present in the PR's base, gone after the merge
      if (parent) {
        const oldPath = ch.oldPath ?? ch.path;
        const oldIdPath = prefix ? `${prefix}/${oldPath}` : oldPath;
        const oldFns = parseBlob(git.fileAt(repo, parent, oldPath), oldIdPath);
        const newIds = new Set(newFns.map((f) => f.nodeId));
        for (const fn of oldFns) if (!newIds.has(fn.nodeId)) deletedIds.add(fn.nodeId);
      }
    }

    for (const id of changedFns.keys()) if (nodeById.has(id)) allChangedInGraph.add(id);

    // visibility: prefer the analyzed graph node (authoritative), else the blob.
    const visOf = (fn: FnRange) => nodeById.get(fn.nodeId)?.visibility ?? visibilityOf(fn);
    const changedNodes = [...changedFns.values()].map((fn) => ({
      id: fn.nodeId,
      inGraph: nodeById.has(fn.nodeId),
      visibility: visOf(fn),
      kind: fn.kind,
    }));
    const changedApi = [...changedFns.values()].filter((fn) => visOf(fn) !== 'local').map((fn) => fn.nodeId);
    // impacted screens: reverse-walk callers from the in-graph non-local seeds.
    const seeds = changedApi.filter((id) => nodeById.has(id));
    const impacted = impactedScreens(seeds, callers, nodeById);
    for (const s of impacted) allImpacted.add(s.id);

    // LEAN index row: list/overview data only (counts + precomputed endpoints).
    // Spring-parity key order so the flowmap UI's commit list/aggregate render.
    perPullIndex.push({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      mergedAt: pr.mergedAt,
      mergeCommit: sha,
      changedNodeCount: changedFns.size,
      changedFileCount: changes.length,
      impactedEndpoints: impacted.map(endpointRef),
    });
    // HEAVY shard: full per-PR detail, lazy-loaded on commit open. Spring-parity
    // keys (incl. an always-empty `deletedEndpoints` — the breaking-deletion
    // analysis is backend-only) so the flowmap UI's shard reader finds each field.
    shards.set(pr.number, {
      number: pr.number,
      mergeCommit: sha,
      changedFiles: changes.map((c) => c.path),
      changedNodes,
      changedApiMethods: changedApi,
      deletedNodes: [...deletedIds],
      deletedEndpoints: [],
    });
  }

  // Spring-parity top-level shape (the flowmap UI sums these). The deleted/
  // breaking-endpoint counters are backend-semantic and always 0 for a frontend
  // (the impact target is screens), but kept so the UI's stat cards render.
  const index: Record<string, unknown> = {
    base,
    repoUrl: webBase,
    pullCount: pulls.length,
    changedNodeCount: allChangedInGraph.size,
    impactedEndpointCount: allImpacted.size,
    deletedEndpointCount: 0,
    trulyDeletedEndpointCount: 0,
    breakingDeletionCount: 0,
    pulls: perPullIndex,
    deletedEndpoints: [],
  };
  return { index, shards };
}

function parseBlob(content: string | null, idPath: string): FnRange[] {
  if (content == null) return [];
  try {
    return functions(idPath, content);
  } catch {
    return []; // a malformed blob never fails the whole PR
  }
}

/** Reverse-walk callers from [seeds]; collect the SCREEN nodes reached (seed included). */
function impactedScreens(seeds: string[], callers: Map<string, string[]>, nodeById: Map<string, MethodNode>): MethodNode[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const s of seeds) if (nodeById.has(s) && !seen.has(s)) {
    seen.add(s);
    stack.push(s);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (nodeById.get(cur)?.layer === 'SCREEN') found.add(cur);
    for (const src of callers.get(cur) ?? []) if (!seen.has(src)) {
      seen.add(src);
      stack.push(src);
    }
  }
  return [...found].map((id) => nodeById.get(id)!).filter(Boolean);
}

/**
 * A reference to an impacted SCREEN, shaped to fill the Spring impact's
 * `impactedEndpoints` slot the flowmap UI renders: `endpoint` = the screen's
 * route, `service` = its project, `httpMethod` = null (screens have no verb).
 */
function endpointRef(n: MethodNode): Record<string, unknown> {
  return {
    id: n.id,
    httpMethod: null,
    endpoint: n.endpoint ?? n.description,
    service: n.project,
  };
}

/** Shard-dir path for an `--out <base>.impact.json` (mirrors Spring's `<project>.impact/`). */
export function shardDirOf(out: string): string {
  return out.replace(/\.json$/i, '');
}

/** Service/base name from an impact out path, for messages. */
export function baseNameOf(out: string): string {
  return path.basename(out).replace(/\.impact\.json$/i, '').replace(/\.json$/i, '');
}
