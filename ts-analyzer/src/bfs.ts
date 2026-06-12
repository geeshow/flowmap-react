/**
 * BFS over the graph to extract a node's callers/callees subgraph.
 * Port of the backend Bfs.kt.
 */

import { CallEdge, CallGraph, MethodNode, edgeKey } from './model';

export type Direction = 'both' | 'callers' | 'callees';

/** Match by exact id, then exact method name, then substring. */
export function findNodes(graph: CallGraph, query: string): MethodNode[] {
  const q = query.trim();
  const byId = graph.nodes.filter((n) => n.id === q);
  if (byId.length) return byId;
  const byMethod = graph.nodes.filter((n) => n.method === q);
  if (byMethod.length) return byMethod;
  const ql = q.toLowerCase();
  return graph.nodes.filter(
    (n) => n.id.toLowerCase().includes(ql) || `${n.fqcn}.${n.method}`.toLowerCase().includes(ql),
  );
}

export function bfs(graph: CallGraph, roots: string[], direction: Direction, depth: number): CallGraph {
  const outAdj = new Map<string, CallEdge[]>();
  const inAdj = new Map<string, CallEdge[]>();
  for (const e of graph.edges) {
    (outAdj.get(e.source) ?? outAdj.set(e.source, []).get(e.source)!).push(e);
    (inAdj.get(e.target) ?? inAdj.set(e.target, []).get(e.target)!).push(e);
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const keptNodes = new Set<string>();
  const keptEdges = new Map<string, CallEdge>();
  const visited = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    if (nodeById.has(r)) {
      visited.set(r, 0);
      keptNodes.add(r);
      queue.push(r);
    }
  }

  const followOut = direction === 'both' || direction === 'callees';
  const followIn = direction === 'both' || direction === 'callers';

  while (queue.length) {
    const cur = queue.shift()!;
    const d = visited.get(cur)!;
    if (d >= depth) continue;
    if (followOut) {
      for (const e of outAdj.get(cur) ?? []) {
        keptEdges.set(edgeKey(e), e);
        keptNodes.add(e.target);
        if (!visited.has(e.target)) {
          visited.set(e.target, d + 1);
          queue.push(e.target);
        }
      }
    }
    if (followIn) {
      for (const e of inAdj.get(cur) ?? []) {
        keptEdges.set(edgeKey(e), e);
        keptNodes.add(e.source);
        if (!visited.has(e.source)) {
          visited.set(e.source, d + 1);
          queue.push(e.source);
        }
      }
    }
  }

  const nodes = [...keptNodes].map((id) => nodeById.get(id)).filter((n): n is MethodNode => !!n);
  return { nodes, edges: [...keptEdges.values()] };
}
