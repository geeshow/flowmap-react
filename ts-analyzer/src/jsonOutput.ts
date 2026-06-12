/**
 * Node-link JSON writer + reader. Mirrors the backend JsonOutput.kt contract:
 * pretty 2-space indent, explicit null inclusion, stable key order (provided by
 * model.nodeToJson / edgeToJson). `read` parses either a frontend graph or a
 * backend graph (same envelope) — used by `join`, `search`, `stats`.
 */

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
