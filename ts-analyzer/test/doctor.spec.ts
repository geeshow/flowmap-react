/** Graph health checker: orphan detection, dangling edges, connectivity signals. */
import { describe, expect, it } from 'vitest';
import { checkGraph } from '../src/doctor';
import { CallEdge, CallGraph, makeNode } from '../src/model';

const edge = (source: string, target: string, relation: string): CallEdge => ({
  source, target, relation, mode: 'sync', kind: 'internal', callSiteFile: null, callSiteLine: null,
});

function graph(): CallGraph {
  return {
    nodes: [
      makeNode({ id: 'P::Page', fqcn: 'P', method: 'Page', layer: 'SCREEN', project: 'p' }),
      makeNode({ id: 'P::Child', fqcn: 'P', method: 'Child', layer: 'COMPONENT', project: 'p' }),
      makeNode({ id: 'P::Lonely', fqcn: 'P', method: 'Lonely', layer: 'COMPONENT', project: 'p' }),
      makeNode({ id: 'ext:GET /x', fqcn: 'x', method: 'GET', layer: 'API', project: 'p', confidence: 'unresolved' }),
    ],
    edges: [
      edge('P::Page', 'P::Child', 'render'),
      edge('P::Child', 'ext:GET /x', 'http'),
    ],
  };
}

describe('doctor / checkGraph', () => {
  it('flags the disconnected node as an orphan', () => {
    const h = checkGraph(graph());
    expect(h.orphans.total).toBe(1);
    expect(h.orphans.ids).toEqual(['P::Lonely']);
    expect(h.orphans.byLayer).toEqual({ COMPONENT: 1 });
    expect(h.ok).toBe(false);
  });

  it('counts connectivity signals (never-rendered, route-less, unresolved api)', () => {
    const h = checkGraph(graph());
    expect(h.componentsNeverRendered).toBe(1); // Lonely (Child has incoming render)
    expect(h.screensWithoutRoute).toBe(1); // Page has no incoming route edge
    expect(h.unresolvedApi).toBe(1);
    expect(h.apiWithoutCaller).toBe(0); // GET /x has an incoming http edge
  });

  it('detects dangling edges to missing nodes', () => {
    const g = graph();
    g.edges.push(edge('P::Page', 'P::Ghost', 'render'));
    const h = checkGraph(g);
    expect(h.danglingEdges).toBe(1);
    expect(h.ok).toBe(false);
  });

  it('reports ok on a fully connected graph', () => {
    const g = graph();
    g.nodes = g.nodes.filter((n) => n.id !== 'P::Lonely');
    g.edges.push(edge('route:/p', 'P::Page', 'route'));
    g.nodes.push(makeNode({ id: 'route:/p', fqcn: '/p', method: '/p', layer: 'SCREEN', project: 'p' }));
    const h = checkGraph(g);
    expect(h.orphans.total).toBe(0);
    expect(h.danglingEdges).toBe(0);
    expect(h.ok).toBe(true);
  });
});
