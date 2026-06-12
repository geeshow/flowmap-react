/**
 * Intermediate Representation (IR) — fully resolved, pure data with NO `ts.*`
 * types leaking out. Mirrors the backend's Ir.kt isolation boundary: the
 * compiler-backed Resolver produces IR; the pure GraphBuilder consumes it.
 * Swapping the parser later means reimplementing only `Resolver`.
 */

import type { Confidence } from './model';

export type ComponentKind = 'component' | 'hook' | 'function';
export type StoreKind = 'redux-slice' | 'zustand' | 'context';
export type RouteSource = 'react-router' | 'next-pages' | 'next-app';

/** A use of a child component in JSX (`<UserCard/>`). */
export interface IrJsxUsage {
  tagName: string; // raw tag, e.g. "UserCard" or "Lib.Foo"
  targetComponentId: string | null; // resolved "<file>::<Name>" or null (lib/native/unresolved)
  lazy: boolean; // via React.lazy / dynamic import
  line: number | null;
}

/** A resolved HTTP/api call. */
export interface ApiResolution {
  kind: 'api';
  httpMethod: string | null;
  url: string | null; // raw resolved url (with literal values; display)
  endpoint: string | null; // normalized path (join key basis); null if unresolved
  urlPlaceholder: string | null; // residual "${...}"
  service: string | null; // axios instance / wrapper module / host
  clientPackage: string | null; // module path of the wrapper/instance
  confidence: Confidence;
  wrapperChain: string[]; // e.g. ["getUser", "http.get"] for debuggability
}

export type CallResolution =
  | { kind: 'internal'; calleeComponentId: string; calleeName: string; calleeIsAsync: boolean }
  | ApiResolution
  | { kind: 'storeDispatch'; storeId: string; action: string | null }
  | { kind: 'storeRead'; storeId: string; selector: string | null }
  | { kind: 'unresolved' };

export interface IrCall {
  line: number | null;
  inAsyncCtx: boolean; // inside an async function / promise chain
  resolution: CallResolution;
}

export interface IrComponent {
  id: string; // "<repo-relative-file>::<Name>"
  name: string; // "UserList"; hooks keep "useFoo"
  kind: ComponentKind;
  exported: boolean;
  isAsync: boolean;
  line: number | null;
  jsxUsages: IrJsxUsage[]; // children rendered
  calls: IrCall[]; // resolved call sites
}

export interface IrRoute {
  routePath: string | null; // raw router path, e.g. "/users/:id" or "/users/{}"
  screenComponentId: string | null; // resolved page/screen component id
  lazy: boolean;
  source: RouteSource;
  line: number | null;
}

export interface IrStore {
  storeId: string; // "store:<kind>:<name>"
  name: string;
  kind: StoreKind;
  actions: string[];
  line: number | null;
}

export interface IrFile {
  path: string; // repo-relative
  project: string | null; // .repo/<project>/...  (parts[0])
  module: string | null; // .repo/<project>/<module>/... (parts[1])
  language: 'tsx' | 'ts' | 'jsx' | 'js';
  components: IrComponent[];
  routes: IrRoute[];
  stores: IrStore[];
}

export interface ResolveOptions {
  repoRoot: string;
  projectFilter?: string | null;
  env?: Record<string, string>;
}

export interface Resolver {
  analyze(opts: ResolveOptions): IrFile[];
}
