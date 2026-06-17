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
 * contract (version 1). Each service lives in its own subdirectory holding a pure
 * `<base>.json` graph; sibling join/screens/impact files (and graph/join/etc.
 * paths) are recorded relative to `outDir` as `<service>/<file>`.
 */
export function writeManifest(outDir: string): string {
  const services = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  // Frontend-only node layers — their presence marks a graph as a frontend graph.
  const FRONTEND_LAYERS = new Set(['SCREEN', 'HOOK', 'STORE', 'API']);

  const projects = services
    .map((service) => {
      const svcDir = path.join(outDir, service);
      // The one pure graph in a service dir: a `.json` that is neither a derived
      // sibling (.join/.screens/.openapi/.impact) nor an internal `_` file.
      const graphFile = fs
        .readdirSync(svcDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .find((f) => !MANIFEST_SUFFIXES.some((s) => f.endsWith(s)));
      if (!graphFile) return null;

      const base = graphFile.slice(0, -'.json'.length);
      const sibling = (suffix: string) =>
        fs.existsSync(path.join(svcDir, `${base}.${suffix}`)) ? `${service}/${base}.${suffix}` : null;

      let nodes = 0;
      let edges = 0;
      let isFrontend = false;
      let repo: string | null = null;
      let generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      try {
        const root = JSON.parse(fs.readFileSync(path.join(svcDir, graphFile), 'utf8'));
        nodes = int(root.meta, 'nodes') ?? (Array.isArray(root.nodes) ? root.nodes.length : 0);
        edges = int(root.meta, 'edges') ?? (Array.isArray(root.edges) ? root.edges.length : 0);
        // Detect type from node layers so a shared dir holding BOTH backend and
        // frontend graphs is catalogued correctly no matter which tool wrote last.
        isFrontend = Array.isArray(root.nodes) && root.nodes.some((n: { layer?: string }) => n.layer != null && FRONTEND_LAYERS.has(n.layer));
        // git work tree this service belongs to (the frontend analyzer stamps it):
        // monorepo sub-roots share one `repo`, so repo-level views can group them.
        repo = str(root.meta, 'gitRepo');
        const g = str(root.meta, 'generated');
        if (g) generated = g;
      } catch {
        // Unreadable/non-graph json — keep zero counts but still list it.
      }

      return {
        name: service,
        type: isFrontend ? 'frontend' : 'backend',
        repo,
        graph: `${service}/${graphFile}`,
        openapi: sibling('openapi.json'),
        impact: sibling('impact.json'),
        join: sibling('join.json'),
        screens: sibling('screens.json'),
        nodes,
        edges,
        generated,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

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
    aliases: Array.isArray(n.aliases) ? n.aliases.map((a: unknown) => String(a)) : null,
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
