/**
 * Assembles the CallGraph from resolved IrFile[]. Pure — no ts.* / no IO.
 * Mirrors the backend GraphBuilder.kt: first-seen node ordering,
 * (source,target,relation,line) edge dedup, and node creation only for tracked
 * layers. Frontend layers: SCREEN / COMPONENT / HOOK / STORE / API / EXTERNAL.
 */

import type { ApiResolution, IrComponent, IrFile, IrRoute, IrStore } from './ir';
import {
  CallEdge,
  CallGraph,
  CallMode,
  EdgeKind,
  Layer,
  MethodNode,
  edgeKey,
  makeNode,
} from './model';
import { normalize, normPath } from './norm';

interface CompEntry {
  comp: IrComponent;
  file: IrFile;
}

export class GraphBuilder {
  private readonly nodes = new Map<string, MethodNode>();
  private readonly edges = new Map<string, CallEdge>();

  private readonly compById = new Map<string, CompEntry>();
  private readonly storeById = new Map<string, { store: IrStore; file: IrFile }>();
  /** screen component id -> route path */
  private readonly screenPath = new Map<string, string>();

  constructor(private readonly files: IrFile[]) {
    for (const f of files) {
      for (const c of f.components) this.compById.set(c.id, { comp: c, file: f });
      for (const s of f.stores) this.storeById.set(s.storeId, { store: s, file: f });
    }
    for (const f of files) for (const r of f.routes) this.indexRoute(r);
  }

  build(): CallGraph {
    // 1) component / hook / screen nodes
    for (const { comp, file } of this.compById.values()) this.addNode(this.componentNode(comp, file));
    // 2) store nodes (+ container→action edges so a slice/module is linked to the actions it defines)
    for (const { store, file } of this.storeById.values()) {
      this.addNode(this.storeNode(store, file));
      // 액션 노드(store:<kind>:<ns>#<action>)는 별도 컴포넌트로 생성되므로 id 프리픽스로 컨테이너에 연결
      const prefix = `${store.storeId}#`;
      for (const id of this.compById.keys()) {
        if (id.startsWith(prefix)) this.emit(store.storeId, id, 'sync', 'internal', 'store:action', file.path, store.line);
      }
    }
    // 3) edges (render / call / http / store) and pulled-in API/EXTERNAL nodes
    for (const f of this.files) {
      for (const c of f.components) {
        this.wireRenders(c, f);
        this.wireCalls(c, f);
      }
    }
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }

  // ---- routes / screens ----

  private indexRoute(r: IrRoute): void {
    if (!r.screenComponentId) return;
    const p = r.routePath != null ? normalize(r.routePath.replace(/:[^/]+/g, '{}')) : '/';
    // first route path wins for a screen
    if (!this.screenPath.has(r.screenComponentId)) this.screenPath.set(r.screenComponentId, p);
  }

  // ---- node construction ----

  private componentNode(c: IrComponent, f: IrFile): MethodNode {
    // Vuex action: a STORE-layer node that is also an http source (its calls wire to API nodes)
    if (c.kind === 'action') {
      return makeNode({
        id: c.id,
        fqcn: c.id.split('#')[0], // store:vuex:<ns>
        method: c.name,
        layer: 'STORE',
        resourceType: 'vuex-action',
        visibility: c.exported ? 'exported' : 'local',
        isAsync: c.isAsync,
        file: f.path,
        line: c.line,
        project: f.project,
        module: f.module,
      });
    }
    const isScreen = this.screenPath.has(c.id);
    const layer: Layer = isScreen ? 'SCREEN' : c.kind === 'hook' ? 'HOOK' : 'COMPONENT';
    const routePath = this.screenPath.get(c.id) ?? null;
    return makeNode({
      id: c.id,
      fqcn: f.path,
      method: c.name,
      layer,
      visibility: c.exported ? 'exported' : 'local',
      isAsync: c.isAsync,
      endpoint: routePath,
      description: routePath,
      file: f.path,
      line: c.line,
      project: f.project,
      module: f.module,
    });
  }

  private storeNode(s: IrStore, f: IrFile): MethodNode {
    return makeNode({
      id: s.storeId,
      fqcn: s.storeId,
      method: s.name,
      layer: 'STORE',
      resourceType: s.kind,
      returnType: s.actions.length ? s.actions.join(',') : null,
      file: f.path,
      line: s.line,
      project: f.project,
      module: f.module,
    });
  }

  private apiNode(r: ApiResolution): MethodNode {
    const host = this.hostOf(r.url);
    const isExternalHost = host != null;
    const layer: Layer = isExternalHost ? 'EXTERNAL' : 'API';
    const ep = r.endpoint;
    const id = isExternalHost
      ? `ext:${r.httpMethod ?? 'ANY'} ${host}${ep ?? ''}`
      : ep
        ? `ext:${r.httpMethod ?? 'ANY'} ${ep}`
        : `ext:${r.service ?? 'http'}#unresolved`;
    return makeNode({
      id,
      fqcn: r.service ?? 'http',
      method: r.httpMethod?.toLowerCase() ?? 'request',
      layer,
      httpMethod: r.httpMethod,
      endpoint: ep,
      externalService: host ?? r.service,
      externalUrl: r.url,
      urlPlaceholder: r.urlPlaceholder,
      clientPackage: r.clientPackage,
      confidence: r.confidence,
    });
  }

  // ---- edges ----

  private wireRenders(c: IrComponent, f: IrFile): void {
    for (const u of c.jsxUsages) {
      if (!u.targetComponentId || !this.compById.has(u.targetComponentId)) continue;
      this.emit(c.id, u.targetComponentId, u.lazy ? 'async' : 'sync', 'internal', 'render', f.path, u.line);
    }
  }

  private wireCalls(c: IrComponent, f: IrFile): void {
    for (const call of c.calls) {
      const r = call.resolution;
      const mode: CallMode = call.inAsyncCtx ? 'async' : 'sync';
      switch (r.kind) {
        case 'internal': {
          if (!this.compById.has(r.calleeComponentId)) break;
          const m: CallMode = call.inAsyncCtx || r.calleeIsAsync ? 'async' : 'sync';
          this.emit(c.id, r.calleeComponentId, m, 'internal', 'call', f.path, call.line);
          break;
        }
        case 'api': {
          const node = this.apiNode(r);
          this.addNode(node);
          this.emit(c.id, node.id, mode, 'external', 'http', f.path, call.line);
          break;
        }
        case 'storeRead': {
          this.ensureStoreTarget(r.storeId, f);
          this.emit(c.id, r.storeId, mode, 'internal', 'store:read', f.path, call.line);
          break;
        }
        case 'storeDispatch': {
          // target may be a Vuex action node (a component) or a store module
          this.ensureStoreTarget(r.storeId, f);
          this.emit(c.id, r.storeId, mode, 'internal', 'dispatch', f.path, call.line);
          break;
        }
        case 'unresolved':
          break;
      }
    }
  }

  /** Ensure a dispatch/read target exists: an action node (component) or a store module; else phantom. */
  private ensureStoreTarget(targetId: string, f: IrFile): void {
    if (this.compById.has(targetId) || this.storeById.has(targetId) || this.nodes.has(targetId)) return;
    this.addPhantomStore(targetId, f);
  }

  /** A store referenced by usage but whose definition we never saw (e.g. external pkg). */
  private addPhantomStore(storeId: string, f: IrFile): void {
    const kind = storeId.split(':')[1] ?? 'store';
    this.addNode(
      makeNode({ id: storeId, fqcn: storeId, method: storeId.split(':').pop() ?? storeId, layer: 'STORE', resourceType: kind }),
    );
    this.storeById.set(storeId, { store: { storeId, name: storeId, kind: 'context', actions: [], line: null }, file: f });
  }

  // ---- url helpers (mirror backend hostOf) ----

  private hostOf(url: string | null): string | null {
    if (!url || url.includes('${')) return null;
    const idx = url.indexOf('://');
    if (idx < 0) return null;
    const afterScheme = url.slice(idx + 3);
    const host = afterScheme.split('/')[0];
    return host || null;
  }

  // ---- low-level ----

  private addNode(node: MethodNode): void {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
  }

  private emit(
    source: string,
    target: string,
    mode: CallMode,
    kind: EdgeKind,
    relation: string,
    file: string | null,
    line: number | null,
  ): void {
    const e: CallEdge = { source, target, mode, kind, relation, callSiteFile: file, callSiteLine: line };
    const k = edgeKey(e);
    if (!this.edges.has(k)) this.edges.set(k, e);
  }
}

/** Re-export normPath so callers (join) share the exact key. */
export { normPath };
