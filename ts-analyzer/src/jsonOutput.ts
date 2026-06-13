/**
 * Node-link JSON writer + reader. Mirrors the backend JsonOutput.kt contract:
 * pretty 2-space indent, explicit null inclusion, stable key order (provided by
 * model.nodeToJson / edgeToJson). `read` parses either a frontend graph or a
 * backend graph (same envelope) — used by `join`, `search`, `stats`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CallEdge, CallGraph, CallMode, EdgeKind, Layer, MethodNode, toNodeLink } from './model';

export function write(graph: CallGraph, meta: Record<string, unknown>): string {
  return JSON.stringify(toNodeLink(graph, meta), null, 2);
}

export function writeValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function str(obj: any, field: string): string | null {
  const v = obj?.[field];
  return v == null ? null : String(v);
}

function int(obj: any, field: string): number | null {
  const v = obj?.[field];
  return v == null ? null : Number(v);
}

const EDGE_KINDS: EdgeKind[] = ['internal', 'external', 's2s', 'batch', 'resource'];

// Sibling suffixes that mark a derived artifact rather than a pure `<project>.json` graph.
const MANIFEST_SUFFIXES = ['.join.json', '.screens.json', '.openapi.json', '.impact.json'];

/**
 * Scan `outDir` and (re)write `_manifest.json` — a lightweight catalogue of the
 * frontend graphs present, shared verbatim with the backend analyzer's manifest
 * contract (version 1). One entry per pure `<project>.json`; sibling join/screens
 * files are linked when they actually exist on disk.
 */
export function writeManifest(outDir: string): string {
  const entries = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .filter((f) => !MANIFEST_SUFFIXES.some((s) => f.endsWith(s)))
    .sort();

  // Frontend-only node layers — their presence marks a graph as a frontend graph.
  const FRONTEND_LAYERS = new Set(['SCREEN', 'HOOK', 'STORE', 'API']);

  const projects = entries.map((graphFile) => {
    const base = graphFile.slice(0, -'.json'.length);
    const sibling = (suffix: string) => (fs.existsSync(path.join(outDir, `${base}.${suffix}`)) ? `${base}.${suffix}` : null);

    let nodes = 0;
    let edges = 0;
    let isFrontend = false;
    let generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      const root = JSON.parse(fs.readFileSync(path.join(outDir, graphFile), 'utf8'));
      nodes = int(root.meta, 'nodes') ?? (Array.isArray(root.nodes) ? root.nodes.length : 0);
      edges = int(root.meta, 'edges') ?? (Array.isArray(root.edges) ? root.edges.length : 0);
      // Detect type from node layers so a shared dir holding BOTH backend and
      // frontend graphs is catalogued correctly no matter which tool wrote last.
      isFrontend = Array.isArray(root.nodes) && root.nodes.some((n: { layer?: string }) => n.layer != null && FRONTEND_LAYERS.has(n.layer));
      const g = str(root.meta, 'generated');
      if (g) generated = g;
    } catch {
      // Unreadable/non-graph json — keep zero counts but still list it.
    }

    return {
      name: base,
      type: isFrontend ? 'frontend' : 'backend',
      graph: graphFile,
      openapi: sibling('openapi.json'),
      impact: sibling('impact.json'),
      join: sibling('join.json'),
      screens: sibling('screens.json'),
      nodes,
      edges,
      generated,
    };
  });

  const manifest = {
    version: 1,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    projects,
  };
  const text = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(outDir, '_manifest.json'), text);
  return text;
}

export function read(text: string): CallGraph {
  const root = JSON.parse(text);
  const nodes: MethodNode[] = (root.nodes ?? []).map((n: any): MethodNode => ({
    id: str(n, 'id')!,
    fqcn: str(n, 'fqcn')!,
    method: str(n, 'method')!,
    layer: (str(n, 'layer') ?? 'OTHER') as Layer,
    visibility: str(n, 'visibility') ?? 'public',
    isAsync: n.async === true,
    returnType: str(n, 'returnType'),
    httpMethod: str(n, 'httpMethod'),
    endpoint: str(n, 'endpoint'),
    externalService: str(n, 'externalService'),
    externalUrl: str(n, 'externalUrl'),
    file: str(n, 'file'),
    line: int(n, 'line'),
    project: str(n, 'project'),
    module: str(n, 'module'),
    urlPlaceholder: str(n, 'urlPlaceholder'),
    clientPackage: str(n, 'clientPackage'),
    resourceType: str(n, 'resourceType'),
    description: str(n, 'description'),
    confidence: (str(n, 'confidence') as MethodNode['confidence']) ?? null,
  }));
  const edges: CallEdge[] = (root.edges ?? []).map((e: any): CallEdge => {
    const kind = str(e, 'kind');
    return {
      source: str(e, 'source')!,
      target: str(e, 'target')!,
      mode: (str(e, 'mode') === 'async' ? 'async' : 'sync') as CallMode,
      kind: (EDGE_KINDS.includes(kind as EdgeKind) ? kind : 'internal') as EdgeKind,
      relation: str(e, 'relation') ?? 'call',
      callSiteFile: str(e, 'callSiteFile'),
      callSiteLine: int(e, 'callSiteLine'),
    };
  });
  return { nodes, edges };
}
