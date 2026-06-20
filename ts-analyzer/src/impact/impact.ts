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
 * Live, per-root progress line written to stderr DURING the heavy per-PR/per-file
 * diff+parse. On a TTY it overwrites a single line in place (`\r`, no newline) so
 * the slow analysis shows which file it is on right now; off a TTY (piped to a log)
 * it falls back to one newline-terminated line per PR so the record is still legible.
 */
function makeProgress(label: string): (msg: string) => void {
  const tag = label ? `[${label}] ` : '';
  const tty = (process.stderr as unknown as { isTTY?: boolean }).isTTY;
  if (!tty) {
    return (msg) => process.stderr.write(`      ${tag}${msg}\n`);
  }
  const cols = (process.stderr as unknown as { columns?: number }).columns || 120;
  return (msg) => {
    const line = `      ${tag}${msg}`;
    process.stderr.write('\r' + (line.length > cols ? line.slice(0, cols - 1) + '…' : line.padEnd(cols)));
  };
}

/**
 * Analyze change impact for [pulls] against the current [graph]. [prefix] is the
 * repo-relative project dir (e.g. "front-official-desktop") prepended to git
 * paths so blob-derived ids match the graph's `<prefix>/...::Name` node ids.
 * [label] tags the live progress line so each per-root run is identifiable.
 */
export function analyze(
  repo: string,
  base: string,
  prefix: string,
  pulls: git.Pr[],
  graph: CallGraph,
  label = '',
): ImpactResult {
  const webBase = git.webBaseUrl(repo);
  const progress = makeProgress(label);
  const tty = (process.stderr as unknown as { isTTY?: boolean }).isTTY;
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

  const total = pulls.length;
  let pi = 0;
  for (const pr of pulls) {
    pi++;
    const sha = pr.mergeCommit;
    if (!sha) continue;
    const parent = git.firstParent(repo, sha);
    const changes = git.changesIn(repo, sha);
    const changedFns = new Map<string, FnRange>(); // id -> changed node's range (first-seen wins)
    const deletedIds = new Set<string>();

    let ci = 0;
    for (const ch of changes) {
      ci++;
      progress(`PR ${pi}/${total} #${pr.number} · file ${ci}/${changes.length} ${ch.path}`);
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
  // Clear the in-place progress line so the next stderr write starts clean.
  if (tty && total) process.stderr.write('\r' + ' '.repeat((process.stderr as unknown as { columns?: number }).columns || 120) + '\r');

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

/**
 * Merge a freshly-analyzed delta ([newResult], the analyze() output for the NEW
 * pulls only) into an [existing] impact index — for INCREMENTAL runs that reuse
 * already-analyzed PRs instead of re-mining the whole history.
 *
 * Pull rows are unioned (existing ∪ new), deduped by PR number (a re-analyzed PR's
 * NEW row wins), and sorted newest-first by mergedAt. Aggregates are recomputed
 * over the union: `impactedEndpointCount` from each row's `impactedEndpoints` ids
 * (carried in the index — no shard read), and `changedNodeCount` from the in-graph
 * changed node ids — taken from [newResult] shards for new PRs and from
 * [existingChangedInGraph] (a per-number reader over the existing shard files) for
 * the rest, so the count stays an exact union without re-running git/parse.
 *
 * Returns the merged index. Shards on disk are the union of the kept existing shard
 * files (left in place) and [newResult].shards (written by the caller); nothing is
 * pruned, since every existing PR is retained.
 */
export function mergeIndex(
  existing: Record<string, any>,
  newResult: ImpactResult,
  existingChangedInGraph: (prNumber: number) => string[],
): Record<string, unknown> {
  const byNumber = new Map<number, any>();
  for (const r of (existing.pulls as any[]) ?? []) byNumber.set(r.number, r);
  for (const r of (newResult.index.pulls as any[]) ?? []) byNumber.set(r.number, r); // new wins on re-analysis
  const rows = [...byNumber.values()].sort((a, b) => {
    const da = String(a.mergedAt ?? ''), db = String(b.mergedAt ?? '');
    if (da !== db) return da < db ? 1 : -1; // newest mergedAt first
    return (b.number ?? 0) - (a.number ?? 0);
  });

  const impacted = new Set<string>();
  const changed = new Set<string>();
  for (const r of rows) {
    for (const e of (r.impactedEndpoints as any[]) ?? []) if (e?.id) impacted.add(e.id);
    const shard = newResult.shards.get(r.number);
    const ids = shard
      ? ((shard.changedNodes as any[]) ?? []).filter((c) => c.inGraph).map((c) => c.id as string)
      : existingChangedInGraph(r.number);
    for (const id of ids) changed.add(id);
  }

  return {
    base: existing.base ?? newResult.index.base,
    repoUrl: newResult.index.repoUrl ?? existing.repoUrl ?? null,
    pullCount: rows.length,
    changedNodeCount: changed.size,
    impactedEndpointCount: impacted.size,
    deletedEndpointCount: 0,
    trulyDeletedEndpointCount: 0,
    breakingDeletionCount: 0,
    pulls: rows,
    deletedEndpoints: [],
  };
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
