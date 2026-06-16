/**
 * Per-blob symbol parser — the frontend analog of the Spring analyzer's
 * PsiSourceParser. Given a file's repo-relative [path] and its [content] AT A
 * REVISION (a git blob), it returns the graph node ids defined in that file with
 * their line ranges and visibility, so [impact] can attribute a PR's changed
 * line ranges to node ids exactly the way the Spring side attributes them to
 * Kotlin/Java methods.
 *
 * It is a faithful, STANDALONE re-derivation of the node-id naming the graph
 * builders use (so ids match a graph built by `analyze`), implemented with
 * `ts.createSourceFile` (no Program/type-checker — fast, content-only):
 *   - React `.tsx/.ts/.jsx/.js` → top-level component/hook declarations
 *     (`<path>::<Name>`), mirroring TsResolver.discoverComponents.
 *   - Vue `.vue` SFC → ONE component node (`<path>::<Name>`), name from the
 *     `name:` option or the file-path PascalCase convention, mirroring
 *     VueResolver.parseSfc. The whole SFC is one node (range = whole file).
 *   - Vuex `store/**.{js,ts}` → one action node per `actions` key
 *     (`store:vuex:<ns>#<action>`), mirroring vuexResolver.
 *
 * Ids that this standalone pass cannot reproduce (Next.js route handlers retagged
 * to `ext:<M> <path>`, redux thunks, xstate actors) simply won't match a graph
 * node — they report `inGraph:false` and don't seed the screen reverse-walk,
 * exactly as Spring's parser skips file types it doesn't model.
 */

import * as path from 'path';
import * as ts from 'typescript';

export type FnKind = 'component' | 'hook' | 'action';

/** A parsed symbol: its graph node id, NEW-revision line range, visibility, kind. */
export interface FnRange {
  nodeId: string;
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  kind: FnKind;
}

/** visibility string matching the graph: exported → 'exported', else 'local'. */
export function visibilityOf(f: FnRange): string {
  return f.exported ? 'exported' : 'local';
}

/** A custom hook by React convention: `use` + UpperCase. (mirror classify.isHookName) */
function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

/** A React component by convention: PascalCase. (mirror classify.isComponentName) */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.tsx': ts.ScriptKind.TSX,
  '.ts': ts.ScriptKind.TS,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/**
 * Parse a single file blob into the graph node ranges it defines. [idPath] is the
 * repo-relative path used to form `<idPath>::<name>` ids (so it must carry the
 * same project prefix the graph's node ids do).
 */
export function functions(idPath: string, content: string): FnRange[] {
  const lower = idPath.toLowerCase();
  if (lower.endsWith('.vue')) return vueFunctions(idPath, content);
  if (!Object.keys(SCRIPT_KINDS).some((e) => lower.endsWith(e))) return [];
  const sf = makeSource(idPath, content);
  const out: FnRange[] = [];
  const seen = new Set<string>();
  const add = (fns: FnRange[]) => {
    for (const f of fns) if (!seen.has(f.nodeId)) {
      seen.add(f.nodeId);
      out.push(f);
    }
  };
  add(reactFunctions(idPath, sf)); // components / hooks
  add(reactStoreFunctions(sf)); // redux / zustand / context / jotai / recoil
  const ns = vuexNamespaceOf(idPath); // Vue projects' store/**.{js,ts}
  if (ns != null) add(vuexFunctions(sf, ns));
  return out;
}

function makeSource(fileName: string, content: string): ts.SourceFile {
  const ext = path.extname(fileName).toLowerCase();
  return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function endLineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

// ---- React (.tsx/.ts/.jsx/.js) ----

/** Mirror of TsResolver.discoverComponents: top-level component/hook declarations. */
function reactFunctions(idPath: string, sf: ts.SourceFile): FnRange[] {
  const out: FnRange[] = [];
  const push = (name: string, declStart: ts.Node, rangeNode: ts.Node, exported: boolean, forceKind?: FnKind) => {
    const kind = forceKind ?? (isComponentName(name) ? 'component' : isHookName(name) ? 'hook' : null);
    if (!kind) return; // plain utilities aren't nodes
    out.push({
      nodeId: `${idPath}::${name}`,
      name,
      startLine: lineOf(sf, declStart),
      endLine: endLineOf(sf, rangeNode),
      exported,
      kind,
    });
  };

  for (const stmt of sf.statements) {
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    // function Foo() {}
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      push(stmt.name.text, stmt, stmt, exported);
      continue;
    }
    // export default function Foo() {} / function() {}
    if (ts.isFunctionDeclaration(stmt) && !stmt.name && stmt.body && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      push('default', stmt, stmt, true, 'component');
      continue;
    }
    // const Foo = () => {} | fn | observer(() => {}) | memo(forwardRef(...))
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        let isFn = false;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) isFn = true;
        else if (ts.isCallExpression(decl.initializer)) isFn = unwrapsToFn(decl.initializer);
        if (isFn) push(decl.name.text, decl, stmt, exported);
      }
      continue;
    }
    // class Foo extends React.Component {}
    if (ts.isClassDeclaration(stmt) && stmt.name && isComponentName(stmt.name.text)) {
      push(stmt.name.text, stmt, stmt, exported, 'component');
    }
  }
  return out;
}

const COMPONENT_WRAPPER_FNS = new Set(['observer', 'memo', 'forwardRef']);

/** Whether a `const X = wrapper(...)` initializer wraps an inline component fn. */
function unwrapsToFn(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  if (!name || !COMPONENT_WRAPPER_FNS.has(name)) return false;
  for (const arg of call.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return true;
    if (ts.isCallExpression(arg) && unwrapsToFn(arg)) return true;
  }
  return false;
}

// ---- Vue SFC (.vue) ----

/** Mirror of VueResolver.parseSfc naming: one component node for the whole SFC. */
function vueFunctions(idPath: string, content: string): FnRange[] {
  const script = extractScript(content);
  const name = (script && sfcNameOption(idPath, script)) || pascalFromFile(idPath);
  const total = Math.max(1, content.split('\n').length);
  return [
    {
      nodeId: `${idPath}::${name}`,
      name,
      startLine: 1,
      endLine: total,
      exported: true,
      kind: 'component',
    },
  ];
}

/** Read the SFC default-export object's `name:` string option, if any. */
function sfcNameOption(idPath: string, script: string): string | null {
  const sf = makeSource(idPath.replace(/\.vue$/i, '.ts'), script);
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const obj = unwrapObject(stmt.expression);
      if (obj) return stringProp(obj, 'name');
    }
  }
  return null;
}

/** Extract the first `<script ...>...</script>` block's content. */
function extractScript(sfc: string): string | null {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(sfc);
  return m ? m[1] : null;
}

/** PascalCase a component name from a `.vue` file path (mirror VueResolver.pascalFromFile). */
function pascalFromFile(idPath: string): string {
  const base = path.basename(idPath).replace(/\.vue$/i, '');
  const cleaned = base === 'index' ? path.basename(path.dirname(idPath)) : base;
  return (
    cleaned
      .split(/[-_]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('') || 'Default'
  );
}

// ---- React state stores (redux / zustand / context / jotai / recoil) ----

const REDUX_MODULE = '@reduxjs/toolkit';
const ZUSTAND_MODULE = 'zustand';
const JOTAI_MODULES = new Set(['jotai', 'jotai/utils', 'jotai/vanilla']);
const RECOIL_MODULES = new Set(['recoil']);
const JOTAI_ATOM_FNS = new Set(['atom', 'atomWithStorage', 'atomWithDefault', 'atomWithReset', 'atomFamily']);
const RECOIL_ATOM_FNS = new Set(['atom', 'atomFamily', 'selector', 'selectorFamily']);
const ZUSTAND_CREATE_FNS = new Set(['create', 'createStore']);

/**
 * Standalone port of storeResolver.collectStores — emits the STORE node ids a
 * file defines (redux slices + thunks, zustand stores + actions, context, jotai/
 * recoil atoms). Library detection is by IMPORT SOURCE (the same contract
 * classify.ts uses), so no type-checker is needed: the factory identifier's
 * module is looked up in the file's own import map. The cross-file usage bindings
 * the real resolver builds aren't needed here — impact only needs node id+range.
 */
function reactStoreFunctions(sf: ts.SourceFile): FnRange[] {
  const importMod = importModuleMap(sf);
  const out: FnRange[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const varName = decl.name.text;
      const head = headCallee(decl.initializer);
      if (!head) continue;
      const mod = importMod.get(head.idText) ?? null;
      const range: [number, number] = [lineOf(sf, decl), endLineOf(sf, stmt)];

      if (head.name === 'createSlice' && mod === REDUX_MODULE) {
        out.push(storeRange(`store:redux:${sliceName(decl.initializer, varName)}`, varName, range, exported, 'action'));
      } else if (head.name === 'createAsyncThunk' && mod === REDUX_MODULE) {
        const prefix = (firstStringArg(decl.initializer) ?? '').split('/')[0];
        if (prefix) out.push(storeRange(`store:redux:${prefix}#${varName}`, varName, range, exported, 'action'));
      } else if (ZUSTAND_CREATE_FNS.has(head.name) && mod === ZUSTAND_MODULE) {
        const storeId = `store:zustand:${varName}`;
        out.push(storeRange(storeId, varName, range, exported, 'action'));
        const state = findStateObject(decl.initializer);
        if (state) {
          for (const p of state.properties) {
            const k = propName(p);
            if (k && isFunctionProp(p)) out.push(storeRange(`${storeId}#${k}`, k, [lineOf(sf, p), endLineOf(sf, p)], true, 'action'));
          }
        }
      } else if (JOTAI_ATOM_FNS.has(head.name) && mod != null && JOTAI_MODULES.has(mod)) {
        out.push(storeRange(`store:jotai:${varName}`, varName, range, exported, 'action'));
      } else if (RECOIL_ATOM_FNS.has(head.name) && mod != null && RECOIL_MODULES.has(mod)) {
        out.push(storeRange(`store:recoil:${varName}`, varName, range, exported, 'action'));
      } else if (head.name === 'createContext' && mod === 'react') {
        out.push(storeRange(`store:context:${varName}`, varName, range, exported, 'action'));
      }
    }
  }
  return out;
}

function storeRange(nodeId: string, name: string, range: [number, number], exported: boolean, kind: FnKind): FnRange {
  return { nodeId, name, startLine: range[0], endLine: range[1], exported, kind };
}

/** Map each imported identifier (default + named) to its module specifier. */
function importModuleMap(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause?.name) out.set(clause.name.text, mod);
    if (clause?.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) out.set(el.name.text, mod);
      else if (ts.isNamespaceImport(clause.namedBindings)) out.set(clause.namedBindings.name.text, mod);
    }
  }
  return out;
}

/**
 * Head callee of an expression, unwrapping currying (`create()(impl)`). Returns
 * the call name + the identifier text to resolve the import from. Mirrors
 * storeResolver.headCallee (so `axios.create(...)` resolves on `axios`, not
 * zustand's bare `create`).
 */
function headCallee(expr: ts.Expression): { name: string; idText: string } | null {
  let e: ts.Expression = expr;
  while (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee)) return { name: callee.text, idText: callee.text };
    if (ts.isPropertyAccessExpression(callee)) {
      if (ts.isCallExpression(callee.expression)) {
        e = callee.expression; // curried create<T>()(impl)
        continue;
      }
      return { name: callee.name.text, idText: ts.isIdentifier(callee.expression) ? callee.expression.text : '' };
    }
    if (ts.isCallExpression(callee)) {
      e = callee;
      continue;
    }
    break;
  }
  return null;
}

/** Redux slice name: the `name:` string option, else varName minus a `Slice` suffix. */
function sliceName(init: ts.Expression, varName: string): string {
  const cfg = ts.isCallExpression(init) ? init.arguments.find(ts.isObjectLiteralExpression) : undefined;
  const nameExpr = cfg && propValue(cfg, 'name');
  if (nameExpr && ts.isStringLiteralLike(nameExpr)) return nameExpr.text;
  return varName.replace(/Slice$/, '');
}

function firstStringArg(init: ts.Expression): string | undefined {
  if (ts.isCallExpression(init)) {
    const a = init.arguments[0];
    if (a && ts.isStringLiteralLike(a)) return a.text;
  }
  return undefined;
}

/** Object literal a zustand impl returns: `create((set) => ({...}))` / `create(() => ({...}))`. */
function findStateObject(init: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isArrowFunction(node)) {
      if (ts.isParenthesizedExpression(node.body) && ts.isObjectLiteralExpression(node.body.expression)) result = node.body.expression;
      else if (ts.isObjectLiteralExpression(node.body)) result = node.body;
      if (result) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(init);
  return result;
}

function propValue(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) if (ts.isPropertyAssignment(p) && propName(p) === key) return p.initializer;
  return undefined;
}

function isFunctionProp(p: ts.ObjectLiteralElementLike): boolean {
  if (ts.isMethodDeclaration(p)) return true;
  if (ts.isPropertyAssignment(p)) return ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer);
  return false;
}

// ---- Vuex (store/**.{js,ts}) ----

/** Namespace from a repo-relative store-file path, or null if not under `store/`. */
function vuexNamespaceOf(idPath: string): string | null {
  if (!/\.(t|j)s$/.test(idPath)) return null;
  const parts = idPath.split('/');
  const i = parts.lastIndexOf('store');
  if (i < 0 || i === parts.length - 1) return null;
  let ns = parts.slice(i + 1).join('/').replace(/\.(t|j)s$/, '');
  if (ns === 'index') return '';
  ns = ns.replace(/\/index$/, '');
  return ns;
}

/** Mirror of vuexResolver: one action node per `actions` key. */
function vuexFunctions(sf: ts.SourceFile, ns: string): FnRange[] {
  const actionsObj = exportedObject(sf, 'actions');
  if (!actionsObj) return [];
  const out: FnRange[] = [];
  for (const p of actionsObj.properties) {
    const name = propName(p);
    if (!name) continue;
    let fn: ts.Node | null = null;
    if (ts.isMethodDeclaration(p)) fn = p;
    else if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) fn = p.initializer;
    if (!fn) continue;
    out.push({
      nodeId: `store:vuex:${ns || 'root'}#${name}`,
      name,
      startLine: lineOf(sf, fn),
      endLine: endLineOf(sf, fn),
      exported: true,
      kind: 'action',
    });
  }
  return out;
}

function exportedObject(sf: ts.SourceFile, key: string): ts.ObjectLiteralExpression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === key && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        return decl.initializer;
      }
    }
  }
  return null;
}

// ---- shared AST helpers ----

function unwrapObject(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isCallExpression(expr)) {
    const arg = expr.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) return arg;
  }
  return null;
}

function stringProp(obj: ts.ObjectLiteralExpression, key: string): string | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === key && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  }
  return null;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}
