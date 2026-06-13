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

  const projects = entries.map((graphFile) => {
    const base = graphFile.slice(0, -'.json'.length);
    const joinFile = `${base}.join.json`;
    const screensFile = `${base}.screens.json`;

    let nodes = 0;
    let edges = 0;
    let generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      const root = JSON.parse(fs.readFileSync(path.join(outDir, graphFile), 'utf8'));
      nodes = int(root.meta, 'nodes') ?? (Array.isArray(root.nodes) ? root.nodes.length : 0);
      edges = int(root.meta, 'edges') ?? (Array.isArray(root.edges) ? root.edges.length : 0);
      const g = str(root.meta, 'generated');
      if (g) generated = g;
    } catch {
      // Unreadable/non-graph json — keep zero counts but still list it.
    }

    return {
      name: base,
      type: 'frontend',
      graph: graphFile,
      join: fs.existsSync(path.join(outDir, joinFile)) ? joinFile : null,
      screens: fs.existsSync(path.join(outDir, screensFile)) ? screensFile : null,
      openapi: null,
      impact: null,
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
