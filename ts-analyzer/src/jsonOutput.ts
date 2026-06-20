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
  // Nested layout: leaf project dirs live at `<outDir>/<ns>/<repo>/<perRoot>/`. Recurse to the
  // dirs directly holding a `.json` artifact (skipping `.impact`/`.pulls` shard dirs).
  const leaves: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_'))) leaves.push(d);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.endsWith('.impact') && !e.name.endsWith('.pulls')) walk(path.join(d, e.name));
    }
  };
  walk(outDir);
  leaves.sort();

  // Frontend-only node layers — their presence marks a graph as a frontend graph.
  const FRONTEND_LAYERS = new Set(['SCREEN', 'HOOK', 'STORE', 'API']);
  // `<ns>/<repo>` path segments for a leaf dir (for graph-less entries with no meta to read).
  const segOf = (svcDir: string) => path.relative(outDir, svcDir).split(path.sep);

  const projects = leaves
    .map((svcDir) => {
      const service = path.basename(svcDir); // perRoot (leaf dir name)
      const rel = path.relative(outDir, svcDir).split(path.sep).join('/');
      // The one pure graph in a service dir: a `.json` that is neither a derived
      // sibling (.join/.screens/.openapi/.impact) nor an internal `_` file.
      const graphFile = fs
        .readdirSync(svcDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .find((f) => !MANIFEST_SUFFIXES.some((s) => f.endsWith(s)));
      if (!graphFile) return null;

      const base = graphFile.slice(0, -'.json'.length);
      const sibling = (suffix: string) =>
        fs.existsSync(path.join(svcDir, `${base}.${suffix}`)) ? `${rel}/${base}.${suffix}` : null;

      let nodes = 0;
      let edges = 0;
      let isFrontend = false;
      let repo: string | null = null;
      let namespace: string | null = null;
      let generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      try {
        const root = JSON.parse(fs.readFileSync(path.join(svcDir, graphFile), 'utf8'));
        nodes = int(root.meta, 'nodes') ?? (Array.isArray(root.nodes) ? root.nodes.length : 0);
        edges = int(root.meta, 'edges') ?? (Array.isArray(root.edges) ? root.edges.length : 0);
        // Detect type from node layers so a shared dir holding BOTH backend and
        // frontend graphs is catalogued correctly no matter which tool wrote last.
        isFrontend = Array.isArray(root.nodes) && root.nodes.some((n: { layer?: string }) => n.layer != null && FRONTEND_LAYERS.has(n.layer));
        // git namespace/repo this service belongs to (the analyzer stamps them):
        // monorepo sub-roots share one `repo`, so repo-level views can group them.
        namespace = str(root.meta, 'gitNamespace');
        repo = str(root.meta, 'gitRepo');
        const g = str(root.meta, 'generated');
        if (g) generated = g;
      } catch {
        // Unreadable/non-graph json — keep zero counts but still list it.
      }

      return {
        name: service,
        type: isFrontend ? 'frontend' : 'backend',
        namespace,
        repo,
        graph: `${rel}/${graphFile}`,
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

  // graph 없는 repo 단위 impact 엔트리 — 모노레포 sub-root 들을 한데 묶은 repo 폴더
  // (<ns>/<repo>/<repo>/<base>.impact.json 만 있고 graph.json 은 없음). namespace/repo 는 경로에서 도출.
  const graphDirs = new Set(projects.map((p) => p.graph.split('/').slice(0, -1).join('/')));
  const impactOnly = leaves
    .filter((svcDir) => !graphDirs.has(path.relative(outDir, svcDir).split(path.sep).join('/')))
    .map((svcDir) => {
      const service = path.basename(svcDir);
      const rel = path.relative(outDir, svcDir).split(path.sep).join('/');
      let impactFile: string | undefined;
      try {
        impactFile = fs.readdirSync(svcDir).find((f) => f.endsWith('.impact.json') && !f.startsWith('_'));
      } catch {
        return null;
      }
      if (!impactFile) return null;
      const seg = segOf(svcDir);
      return {
        name: service,
        type: 'frontend',
        namespace: seg.length >= 3 ? seg[seg.length - 3] : null,
        repo: seg.length >= 2 ? seg[seg.length - 2] : service,
        graph: null,
        openapi: null,
        impact: `${rel}/${impactFile}`,
        join: null,
        screens: null,
        nodes: 0,
        edges: 0,
        generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  const manifest = {
    version: 1,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    projects: [...projects, ...impactOnly],
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
