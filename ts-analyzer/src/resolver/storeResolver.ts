/**
 * State-store discovery — Redux Toolkit slices, Zustand stores, React Context.
 * Produces IrStore[] (the store nodes) plus StoreBindings that let the component
 * walk in irBuilder resolve usages (useSelector / useContext / zustand hook /
 * dispatch(action)) back to the right store id.
 *
 * Symbols are comparable across files within one Program, so the symbol-keyed
 * maps work project-wide once all files have been collected.
 */

import * as ts from 'typescript';
import {
  CONTEXT_CREATE_FN,
  JOTAI_ATOM_FNS,
  JOTAI_MODULES,
  RECOIL_ATOM_FNS,
  RECOIL_MODULES,
  REDUX_ASYNC_THUNK_FN,
  REDUX_SLICE_FN,
  ZUSTAND_CREATE_FNS,
} from '../classify';
import type { IrComponent, IrStore } from '../ir';
import { AnalysisContext } from './context';

export interface StoreBindings {
  /** hook var / context var / async-thunk symbol → storeId */
  bySymbol: Map<ts.Symbol, string>;
  /** slice state key (== slice `name`) → storeId */
  reduxByKey: Map<string, string>;
  /** slice variable symbol → storeId (for `dispatch(slice.actions.foo())`) */
  sliceVarSymbol: Map<ts.Symbol, string>;
}

/** A createAsyncThunk whose payload-creator body must be walked (so thunk → API edges form). */
export interface ThunkMeta {
  comp: IrComponent; // kind: 'action' STORE-layer node
  bodyOwner: ts.Node; // the payload-creator arrow/function expression
  file: ts.SourceFile;
}

export interface StoreAccumulator {
  stores: IrStore[];
  bindings: StoreBindings;
  thunks: ThunkMeta[];
}

export function emptyAccumulator(): StoreAccumulator {
  return {
    stores: [],
    bindings: { bySymbol: new Map(), reduxByKey: new Map(), sliceVarSymbol: new Map() },
    thunks: [],
  };
}

export function collectStores(sf: ts.SourceFile, ctx: AnalysisContext, acc: StoreAccumulator): void {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const varName = decl.name.text;
      const init = decl.initializer;
      const head = headCallee(init);
      if (!head) continue;
      const mod = ctx.importModuleOf(head.idNode);

      if (head.name === REDUX_SLICE_FN && isFrom(mod, '@reduxjs/toolkit')) {
        handleSlice(decl, init, varName, ctx, acc, sf);
      } else if (head.name === REDUX_ASYNC_THUNK_FN && isFrom(mod, '@reduxjs/toolkit')) {
        handleThunk(decl, init, varName, ctx, acc, sf);
      } else if (ZUSTAND_CREATE_FNS.has(head.name) && isFrom(mod, 'zustand')) {
        handleZustand(decl, init, varName, ctx, acc, sf);
      } else if (JOTAI_ATOM_FNS.has(head.name) && isFromAny(mod, JOTAI_MODULES)) {
        handleAtomStore(decl, varName, ctx, acc, sf, 'jotai');
      } else if (RECOIL_ATOM_FNS.has(head.name) && isFromAny(mod, RECOIL_MODULES)) {
        handleAtomStore(decl, varName, ctx, acc, sf, 'recoil');
      } else if (head.name === CONTEXT_CREATE_FN && isFrom(mod, 'react')) {
        handleContext(decl, varName, ctx, acc, sf);
      }
    }
  }
}

function handleSlice(
  decl: ts.VariableDeclaration,
  init: ts.Expression,
  varName: string,
  ctx: AnalysisContext,
  acc: StoreAccumulator,
  sf: ts.SourceFile,
): void {
  const cfg = firstObjectArg(init);
  let name = varName.replace(/Slice$/, '');
  const actions: string[] = [];
  if (cfg) {
    const nameExpr = propValue(cfg, 'name');
    if (nameExpr && ts.isStringLiteralLike(nameExpr)) name = nameExpr.text;
    const reducers = propValue(cfg, 'reducers');
    if (reducers && ts.isObjectLiteralExpression(reducers)) {
      for (const p of reducers.properties) {
        const k = propKeyName(p);
        if (k) actions.push(k);
      }
    }
  }
  const storeId = `store:redux:${name}`;
  pushStore(acc, ctx, sf, { storeId, name, kind: 'redux-slice', actions, line: lineOf(sf, decl) });
  acc.bindings.reduxByKey.set(name, storeId);
  const sym = ctx.symbolAt(decl.name);
  if (sym) acc.bindings.sliceVarSymbol.set(sym, storeId);
}

function handleThunk(
  decl: ts.VariableDeclaration,
  init: ts.Expression,
  varName: string,
  ctx: AnalysisContext,
  acc: StoreAccumulator,
  sf: ts.SourceFile,
): void {
  // createAsyncThunk('user/fetchUser', payloadCreator) → slice key is the prefix before '/'.
  const typeArg = firstStringArg(init);
  if (!typeArg) return;
  const prefix = typeArg.split('/')[0];
  const sym = ctx.symbolAt(decl.name);

  // The thunk becomes its own STORE-layer "action" node whose body is walked, so the
  // page → dispatch → thunk → apiWrapper → request → http chain is traceable (the
  // redux analog of a Vuex action). `dispatch(thunk(...))` targets this node.
  const payload = thunkPayloadCreator(init);
  if (payload) {
    const nodeId = `store:redux:${prefix}#${varName}`;
    const comp: IrComponent = {
      id: nodeId,
      name: varName,
      kind: 'action',
      exported: true,
      isAsync: isAsyncNode(payload),
      line: lineOf(sf, decl),
      jsxUsages: [],
      calls: [],
    };
    acc.thunks.push({ comp, bodyOwner: payload, file: sf });
    if (sym) acc.bindings.bySymbol.set(sym, nodeId);
    return;
  }

  // No traceable payload creator — fall back to binding the thunk to its slice module.
  if (sym) acc.bindings.bySymbol.set(sym, `store:redux:${prefix}`);
}

/** The payload-creator function (2nd arg) of `createAsyncThunk(type, fn, options?)`. */
function thunkPayloadCreator(init: ts.Expression): ts.Node | null {
  if (!ts.isCallExpression(init)) return null;
  const fn = init.arguments[1];
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return fn;
  return null;
}

function isAsyncNode(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function handleZustand(
  decl: ts.VariableDeclaration,
  init: ts.Expression,
  varName: string,
  ctx: AnalysisContext,
  acc: StoreAccumulator,
  sf: ts.SourceFile,
): void {
  const storeId = `store:zustand:${varName}`;
  const actions: string[] = [];
  const stateObj = findStateObject(init);
  if (stateObj) {
    for (const p of stateObj.properties) {
      const k = propKeyName(p);
      if (!k) continue;
      if (isFunctionProp(p)) actions.push(k);
    }
  }
  pushStore(acc, ctx, sf, { storeId, name: varName, kind: 'zustand', actions, line: lineOf(sf, decl) });
  const sym = ctx.symbolAt(decl.name);
  if (sym) acc.bindings.bySymbol.set(sym, storeId);
}

/**
 * Jotai `atom(...)` / Recoil `atom({...})` declarations become STORE nodes keyed
 * by the variable symbol, so a component using `useAtom(x)` / `useRecoilState(x)`
 * resolves to the same id. Both libraries use the `atom` factory; the import
 * module disambiguates jotai from recoil.
 */
function handleAtomStore(
  decl: ts.VariableDeclaration,
  varName: string,
  ctx: AnalysisContext,
  acc: StoreAccumulator,
  sf: ts.SourceFile,
  kind: 'jotai' | 'recoil',
): void {
  const storeId = `store:${kind}:${varName}`;
  pushStore(acc, ctx, sf, { storeId, name: varName, kind, actions: [], line: lineOf(sf, decl) });
  const sym = ctx.symbolAt(decl.name);
  if (sym) acc.bindings.bySymbol.set(sym, storeId);
}

function handleContext(
  decl: ts.VariableDeclaration,
  varName: string,
  ctx: AnalysisContext,
  acc: StoreAccumulator,
  sf: ts.SourceFile,
): void {
  const name = varName;
  const storeId = `store:context:${name}`;
  pushStore(acc, ctx, sf, { storeId, name, kind: 'context', actions: [], line: lineOf(sf, decl) });
  const sym = ctx.symbolAt(decl.name);
  if (sym) acc.bindings.bySymbol.set(sym, storeId);
}

/** Push a store, stashing its repo-relative file on an internal `__file` field. */
function pushStore(acc: StoreAccumulator, ctx: AnalysisContext, sf: ts.SourceFile, store: IrStore): void {
  (store as IrStore & { __file?: string }).__file = ctx.repoRel(sf.fileName);
  acc.stores.push(store);
}

// ---- helpers ----

/**
 * Head callee of an expression, unwrapping currying (create()(impl)). Returns the
 * call name plus the node to resolve the import from (the bare identifier, or the
 * receiver for `rtk.createSlice`). Distinguishes zustand `create(...)` from
 * `axios.create(...)` because the latter's idNode is `axios`.
 */
function headCallee(expr: ts.Expression): { name: string; idNode: ts.Node } | null {
  let e: ts.Expression = expr;
  while (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee)) return { name: callee.text, idNode: callee };
    if (ts.isPropertyAccessExpression(callee)) {
      if (ts.isCallExpression(callee.expression)) {
        e = callee.expression; // curried create<T>()(impl)
        continue;
      }
      return { name: callee.name.text, idNode: callee.expression };
    }
    if (ts.isCallExpression(callee)) {
      e = callee;
      continue;
    }
    break;
  }
  return null;
}

function isFrom(mod: string | null, expected: string): boolean {
  return mod === expected;
}

function isFromAny(mod: string | null, expected: Set<string>): boolean {
  return mod != null && expected.has(mod);
}

function firstObjectArg(init: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isCallExpression(init)) {
    for (const a of init.arguments) if (ts.isObjectLiteralExpression(a)) return a;
  }
  return undefined;
}

function firstStringArg(init: ts.Expression): string | undefined {
  if (ts.isCallExpression(init)) {
    const a = init.arguments[0];
    if (a && ts.isStringLiteralLike(a)) return a.text;
  }
  return undefined;
}

/** Find the object literal a zustand impl returns: create((set) => ({...})) or create(() => ({...})). */
function findStateObject(init: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isArrowFunction(node)) {
      if (ts.isParenthesizedExpression(node.body) && ts.isObjectLiteralExpression(node.body.expression)) {
        result = node.body.expression;
        return;
      }
      if (ts.isObjectLiteralExpression(node.body)) {
        result = node.body;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(init);
  return result;
}

function propValue(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propKeyName(p) === key) return p.initializer;
  }
  return undefined;
}

function propKeyName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}

function isFunctionProp(p: ts.ObjectLiteralElementLike): boolean {
  if (ts.isMethodDeclaration(p)) return true;
  if (ts.isPropertyAssignment(p)) {
    return ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer);
  }
  return false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
