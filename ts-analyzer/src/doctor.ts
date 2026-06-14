/**
 * Graph health check — pure analysis over a CallGraph, used by the `doctor` CLI
 * command and tests to validate that a (periodically refreshed) output graph is
 * well-formed and draws without orphan nodes.
 *
 * "Orphan" = a node with neither incoming nor outgoing edges; such nodes float
 * disconnected in any node-link rendering. We additionally surface softer
 * connectivity issues (components never rendered, screens with no route, stores
 * never referenced, API nodes with no caller) so refreshes can be triaged.
 */

import type { CallGraph, Layer, MethodNode } from './model';

export interface OrphanBreakdown {
  total: number;
  byLayer: Record<string, number>;
  byProject: Record<string, number>;
  ids: string[]; // all orphan ids (sorted)
}

export interface GraphHealth {
  nodes: number;
  edges: number;
  danglingEdges: number; // edges referencing a missing node (sorted sample in `danglingSample`)
  danglingSample: string[];
  orphans: OrphanBreakdown;
  // softer connectivity signals (subset relationships with orphans possible)
  componentsNeverRendered: number; // COMPONENT/SCREEN with no incoming render edge
  screensWithoutRoute: number; // SCREEN with no route relation
  storesNeverReferenced: number; // STORE with no dispatch/read edge
  apiWithoutCaller: number; // API/EXTERNAL with no incoming edge
  unresolvedApi: number; // API/EXTERNAL nodes with confidence 'unresolved'
  ok: boolean; // no orphans and no dangling edges
}

interface Degree {
  in: number;
  out: number;
  inByRelation: Set<string>;
}

function degrees(graph: CallGraph): { deg: Map<string, Degree>; dangling: string[] } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const deg = new Map<string, Degree>();
  for (const n of graph.nodes) deg.set(n.id, { in: 0, out: 0, inByRelation: new Set() });
  const dangling: string[] = [];
  for (const e of graph.edges) {
    const okS = ids.has(e.source);
    const okT = ids.has(e.target);
    if (!okS || !okT) {
      dangling.push(`${e.source} -[${e.relation}]-> ${e.target}`);
      continue;
    }
    deg.get(e.source)!.out++;
    const t = deg.get(e.target)!;
    t.in++;
    t.inByRelation.add(e.relation);
  }
  return { deg, dangling };
}

const RENDER_RELATIONS = new Set(['render', 'route']);

export function checkGraph(graph: CallGraph): GraphHealth {
  const { deg, dangling } = degrees(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const orphanNodes = graph.nodes.filter((n) => {
    const d = deg.get(n.id)!;
    return d.in === 0 && d.out === 0;
  });
  const byLayer: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const o of orphanNodes) {
    byLayer[o.layer] = (byLayer[o.layer] ?? 0) + 1;
    const p = o.project ?? '(none)';
    byProject[p] = (byProject[p] ?? 0) + 1;
  }

  const is = (n: MethodNode, ...ls: Layer[]) => ls.includes(n.layer);
  let componentsNeverRendered = 0;
  let screensWithoutRoute = 0;
  let storesNeverReferenced = 0;
  let apiWithoutCaller = 0;
  let unresolvedApi = 0;
  for (const n of graph.nodes) {
    const d = deg.get(n.id)!;
    if (is(n, 'COMPONENT', 'HOOK') && d.in === 0) componentsNeverRendered++;
    if (is(n, 'SCREEN') && !d.inByRelation.has('route')) screensWithoutRoute++;
    if (is(n, 'STORE') && d.in === 0) storesNeverReferenced++;
    if (is(n, 'API', 'EXTERNAL')) {
      if (d.in === 0) apiWithoutCaller++;
      if (n.confidence === 'unresolved') unresolvedApi++;
    }
  }

  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    danglingEdges: dangling.length,
    danglingSample: dangling.slice(0, 20),
    orphans: {
      total: orphanNodes.length,
      byLayer,
      byProject,
      ids: orphanNodes.map((n) => n.id).sort(),
    },
    componentsNeverRendered,
    screensWithoutRoute,
    storesNeverReferenced,
    apiWithoutCaller,
    unresolvedApi,
    ok: orphanNodes.length === 0 && dangling.length === 0,
  };
}

/** Human-readable report. `maxSample` caps orphan ids printed per layer. */
export function formatHealth(h: GraphHealth, opts: { maxSample?: number; orphanIds?: (id: string) => boolean } = {}): string {
  const max = opts.maxSample ?? 10;
  const lines: string[] = [];
  lines.push(`nodes: ${h.nodes}   edges: ${h.edges}   dangling: ${h.danglingEdges}`);
  lines.push(`orphans: ${h.orphans.total}   by layer: ${JSON.stringify(h.orphans.byLayer)}`);
  if (Object.keys(h.orphans.byProject).length > 1) lines.push(`         by project: ${JSON.stringify(h.orphans.byProject)}`);
  lines.push(
    `connectivity: components-never-rendered=${h.componentsNeverRendered}` +
      `  screens-without-route=${h.screensWithoutRoute}` +
      `  stores-never-referenced=${h.storesNeverReferenced}` +
      `  api-without-caller=${h.apiWithoutCaller}` +
      `  api-unresolved=${h.unresolvedApi}`,
  );
  if (h.danglingEdges) {
    lines.push(`dangling edges (first ${h.danglingSample.length}):`);
    for (const d of h.danglingSample) lines.push(`  ! ${d}`);
  }
  if (h.orphans.total) {
    lines.push(`orphan nodes (first ${max} of ${h.orphans.total}):`);
    for (const id of h.orphans.ids.slice(0, max)) lines.push(`  · ${id}`);
  }
  lines.push(h.ok ? 'OK — no orphans, no dangling edges' : 'PROBLEMS FOUND');
  return lines.join('\n');
}
