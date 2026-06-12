/**
 * Output data model + node-link JSON shape. Schema-compatible with the Spring
 * backend (kotlin-analyzer .../Model.kt): same envelope, same MethodNode/CallEdge
 * keys and ordering, same null-inclusion. We extend the `layer` vocabulary with
 * frontend layers and add ONE additive key, `confidence`, on API/EXTERNAL nodes
 * (the backend contract explicitly allows additive keys).
 */

// Backend layers (kept so we can read a backend graph) + frontend layers.
export type Layer =
  // backend
  | 'CONTROLLER'
  | 'SERVICE'
  | 'REPOSITORY'
  | 'COMPONENT' // shared name; frontend React component also uses this
  | 'CONFIG'
  | 'BATCH'
  | 'EXTERNAL'
  | 'RESOURCE'
  | 'OTHER'
  // frontend
  | 'SCREEN'
  | 'HOOK'
  | 'STORE'
  | 'API';

export type EdgeKind = 'internal' | 'external' | 's2s' | 'batch' | 'resource';

export type CallMode = 'sync' | 'async';

export type Confidence = 'resolved' | 'partial' | 'unresolved';

export interface MethodNode {
  id: string; // "<file>::<Name>" | "ext:<METHOD> <path>" | "store:<kind>:<name>" | backend "<fqcn>#<method>"
  fqcn: string; // file/module qualifier (frontend) or fully-qualified class name (backend)
  method: string; // function/hook/action name
  layer: Layer;
  visibility: string; // "exported" | "local" (frontend) | "public"/... (backend)
  isAsync: boolean;
  returnType: string | null;
  httpMethod: string | null; // API/EXTERNAL verb, or controller verb (backend)
  endpoint: string | null; // normalized path — THE join basis
  externalService: string | null; // axios instance / wrapper module / host
  externalUrl: string | null; // raw resolved URL (display)
  file: string | null; // repo-relative
  line: number | null;
  project: string | null;
  module: string | null;
  urlPlaceholder: string | null; // residual "${...}"
  clientPackage: string | null; // wrapper module path
  resourceType: string | null; // STORE kind, etc.
  description: string | null; // route path / note
  confidence: Confidence | null; // ADDITIVE — API/EXTERNAL url resolution confidence
}

export interface CallEdge {
  source: string;
  target: string;
  mode: CallMode;
  kind: EdgeKind;
  relation: string; // "route" | "render" | "call" | "dispatch" | "store:read" | "http" | ...
  callSiteFile: string | null;
  callSiteLine: number | null;
}

export interface CallGraph {
  nodes: MethodNode[];
  edges: CallEdge[];
}

/** Dedup key — mirrors CallEdge.key(): (source, target, relation, callSiteLine). */
export function edgeKey(e: CallEdge): string {
  return JSON.stringify([e.source, e.target, e.relation, e.callSiteLine]);
}

/** Serialize one node preserving backend key order; `confidence` is appended additively. */
export function nodeToJson(n: MethodNode): Record<string, unknown> {
  return {
    id: n.id,
    fqcn: n.fqcn,
    method: n.method,
    layer: n.layer,
    visibility: n.visibility,
    async: n.isAsync,
    returnType: n.returnType,
    httpMethod: n.httpMethod,
    endpoint: n.endpoint,
    externalService: n.externalService,
    externalUrl: n.externalUrl,
    resourceType: n.resourceType,
    description: n.description,
    urlPlaceholder: n.urlPlaceholder,
    clientPackage: n.clientPackage,
    confidence: n.confidence,
    file: n.file,
    line: n.line,
    project: n.project,
    module: n.module,
  };
}

export function edgeToJson(e: CallEdge): Record<string, unknown> {
  return {
    source: e.source,
    target: e.target,
    mode: e.mode,
    kind: e.kind,
    relation: e.relation,
    callSiteFile: e.callSiteFile,
    callSiteLine: e.callSiteLine,
  };
}

export function toNodeLink(graph: CallGraph, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    directed: true,
    multigraph: true,
    meta,
    nodes: graph.nodes.map(nodeToJson),
    edges: graph.edges.map(edgeToJson),
  };
}

/** Factory with field defaults so call sites only specify what they care about. */
export function makeNode(partial: Partial<MethodNode> & Pick<MethodNode, 'id' | 'fqcn' | 'method' | 'layer'>): MethodNode {
  return {
    visibility: 'public',
    isAsync: false,
    returnType: null,
    httpMethod: null,
    endpoint: null,
    externalService: null,
    externalUrl: null,
    file: null,
    line: null,
    project: null,
    module: null,
    urlPlaceholder: null,
    clientPackage: null,
    resourceType: null,
    description: null,
    confidence: null,
    ...partial,
  };
}
