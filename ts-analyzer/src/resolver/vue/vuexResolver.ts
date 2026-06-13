/**
 * Vuex (module-mode) parsing. Each `store/<path>.js` is a namespaced module:
 *   store/index.js → root, store/login.js → 'login', store/products/list.js → 'products/list'.
 * Emits a STORE module node (for getter/state reads) and one ACTION node per
 * `actions` key. Action bodies are walked so the http edge (action → API),
 * including wrapper calls into apis/*.js, is captured — this is the link that
 * makes `page → dispatch → action → API → backend` traceable.
 */

import * as path from 'path';
import * as ts from 'typescript';
import type { IrComponent, IrStore } from '../../ir';
import { realFileName } from '../program';
import { VueBodyWalker, vuexActionId, vuexModuleId } from './vueBodyWalker';

export interface VuexFileResult {
  ns: string;
  module: IrStore;
  actions: IrComponent[];
}

/** Namespace from a store file path. Returns null if the file is not under store/. */
export function vuexNamespace(absFile: string, storeDir: string): string | null {
  const real = realFileName(absFile);
  const rel = path.relative(storeDir, real).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  let ns = rel.replace(/\.(t|j)s$/, '');
  if (ns === 'index') return '';
  ns = ns.replace(/\/index$/, '');
  return ns;
}

export function resolveVuexFile(
  sf: ts.SourceFile,
  storeDir: string,
  walker: VueBodyWalker,
  repoRel: (f: string) => string,
): VuexFileResult | null {
  const ns = vuexNamespace(sf.fileName, storeDir);
  if (ns == null) return null;

  const exports = collectExportedObjects(sf);
  const actionsObj = exports.get('actions');
  const gettersObj = exports.get('getters');
  const mutationsObj = exports.get('mutations');
  if (!actionsObj && !gettersObj && !exports.get('state')) return null; // not a Vuex module

  const file = repoRel(sf.fileName);
  const line = sf.getLineAndCharacterOfPosition(0).line + 1;

  const actionNames: string[] = [];
  const actions: IrComponent[] = [];
  if (actionsObj) {
    for (const fn of objectFunctions(actionsObj)) {
      actionNames.push(fn.name);
      actions.push({
        id: vuexActionId(ns, fn.name),
        name: fn.name,
        kind: 'action',
        exported: true,
        isAsync: fn.isAsync,
        line: lineOf(sf, fn.node),
        jsxUsages: [],
        calls: walker.collect(fn.node, ns, fn.isAsync),
      });
    }
  }

  const module: IrStore = {
    storeId: vuexModuleId(ns),
    name: ns || 'root',
    kind: 'vuex',
    actions: [
      ...actionNames,
      ...(gettersObj ? objectKeys(gettersObj).map((k) => `get:${k}`) : []),
      ...(mutationsObj ? objectKeys(mutationsObj).map((k) => `mut:${k}`) : []),
    ],
    line,
  };
  (module as IrStore & { __file?: string }).__file = file;

  return { ns, module, actions };
}

// ---- AST helpers ----

/** `export const <name> = {...}` (and `export const <name>: T = {...}`) → name→object. */
function collectExportedObjects(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        out.set(decl.name.text, decl.initializer);
      }
    }
  }
  return out;
}

interface ObjFn {
  name: string;
  node: ts.FunctionLikeDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
  isAsync: boolean;
}

function objectFunctions(obj: ts.ObjectLiteralExpression): ObjFn[] {
  const out: ObjFn[] = [];
  for (const p of obj.properties) {
    const name = propName(p);
    if (!name) continue;
    if (ts.isMethodDeclaration(p)) {
      out.push({ name, node: p, isAsync: hasAsync(p) });
    } else if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
      out.push({ name, node: p.initializer, isAsync: hasAsync(p.initializer) });
    }
  }
  return out;
}

function objectKeys(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties.map(propName).filter((n): n is string => !!n);
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}

function hasAsync(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
