/**
 * In-repo server-side route detection — Express/connect routers and Vite dev
 * middleware. These define endpoints the FRONTEND repo serves itself (a BFF /
 * dev middleware), so a component calling them is an internal frontend→handler
 * edge, NOT a backend call. graphBuilder turns each into a `route-handler`
 * provider node (id `ext:<METHOD> <path>`) that merges with the consumer's call
 * node, and join classifies it `internal` instead of a false external.
 *
 * Detected shapes (by import + call shape, no resolved library types needed):
 *   - `const app = express()` / `express.Router()` / `Router()` (from 'express')
 *     → `app.get('/path', h)`, `router.post('/x', h)`, `app.use('/p', h)`
 *   - sub-router mounts: `app.use('/api', router)` → the router's routes are
 *     prefixed with `/api` (resolved transitively).
 *   - Vite/connect dev middleware: `server.middlewares.use('/path', h)`.
 *
 * Only string-literal paths are taken (the common case); dynamic paths are
 * skipped rather than guessed, so this never invents a wrong endpoint.
 */

import * as ts from 'typescript';
import { normalize } from '../norm';

export interface ServerRoute {
  method: string | null; // 'GET' | 'POST' | ... ; null = ANY (use/all)
  endpoint: string; // normalized, e.g. '/api/users/{}'
  handler: ts.FunctionLikeDeclaration | null; // the (req,res) handler, walked for upstream calls
  node: ts.Node; // the registration call (fallback bodyOwner / line source)
  source: 'express' | 'vite';
}

/** Express verb methods that register a route (`router.<verb>(path, handler)`). */
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);

/** Module specifier of an imported identifier (default / named / namespace), or null. */
function importModuleOf(checker: ts.TypeChecker, ident: ts.Identifier): string | null {
  const sym = checker.getSymbolAtLocation(ident);
  const decl = sym?.declarations?.[0];
  if (!decl) return null;
  let cand: ts.Node | undefined;
  if (ts.isImportClause(decl)) cand = decl.parent;
  else if (ts.isImportSpecifier(decl)) cand = decl.parent.parent.parent;
  else if (ts.isNamespaceImport(decl)) cand = decl.parent.parent;
  if (!cand || !ts.isImportDeclaration(cand)) return null;
  return ts.isStringLiteral(cand.moduleSpecifier) ? cand.moduleSpecifier.text : null;
}

/** True if [ident] resolves to a named import whose imported name is [name]. */
function isNamedImportOf(checker: ts.TypeChecker, ident: ts.Identifier, name: string): boolean {
  const decl = checker.getSymbolAtLocation(ident)?.declarations?.[0];
  return !!decl && ts.isImportSpecifier(decl) && (decl.propertyName?.text ?? decl.name.text) === name;
}

/** `express()` → 'app', `Router()` / `express.Router()` → 'router', else null. */
function instanceKindOf(checker: ts.TypeChecker, init: ts.Expression): 'app' | 'router' | null {
  if (!ts.isCallExpression(init)) return null;
  const callee = init.expression;
  if (ts.isIdentifier(callee)) {
    if (importModuleOf(checker, callee) === 'express') {
      return isNamedImportOf(checker, callee, 'Router') ? 'router' : 'app';
    }
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router' && ts.isIdentifier(callee.expression)) {
    if (importModuleOf(checker, callee.expression) === 'express') return 'router';
  }
  return null;
}

function symOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* not an alias */
    }
  }
  return sym;
}

function isHandlerFn(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** String-literal path argument, or null (dynamic paths are skipped, not guessed). */
function literalPath(arg: ts.Expression | undefined): string | null {
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Join a mount prefix with a route path and normalize (`/api` + `/users/:id` → `/api/users/{}`). */
function joinPath(prefix: string, p: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = p.startsWith('/') ? p : '/' + p;
  return normalize(a + b) || '/';
}

export function findServerRoutes(sourceFiles: readonly ts.SourceFile[], checker: ts.TypeChecker): ServerRoute[] {
  // 1) express/router instance symbols
  const instances = new Map<ts.Symbol, 'app' | 'router'>();
  for (const sf of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const kind = instanceKindOf(checker, node.initializer);
        const sym = kind ? checker.getSymbolAtLocation(node.name) : undefined;
        if (kind && sym) instances.set(sym, kind);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 2) sub-router mounts: `app.use('/api', router)` → routerSym mounted at prefix.
  const rawMount = new Map<ts.Symbol, { parent: ts.Symbol; prefix: string }>();
  const isUseCall = (callee: ts.Expression): callee is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(callee) && callee.name.text === 'use';
  for (const sf of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isUseCall(node.expression) && ts.isIdentifier(node.expression.expression)) {
        const parent = symOf(checker, node.expression.expression);
        const prefix = literalPath(node.arguments[0]);
        const mountedIdent = node.arguments[1];
        if (parent && instances.has(parent) && prefix != null && mountedIdent && ts.isIdentifier(mountedIdent)) {
          const childSym = symOf(checker, mountedIdent);
          if (childSym && instances.get(childSym) === 'router') rawMount.set(childSym, { parent, prefix });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const prefixOf = (sym: ts.Symbol, seen = new Set<ts.Symbol>()): string => {
    const m = rawMount.get(sym);
    if (!m || seen.has(sym)) return '';
    seen.add(sym);
    return joinPathRaw(prefixOf(m.parent, seen), m.prefix);
  };

  // 3) route registrations on an instance + Vite `server.middlewares.use(...)`.
  const routes: ServerRoute[] = [];
  for (const sf of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const method = callee.name.text;
        const recv = callee.expression;

        // Vite/connect: `<x>.middlewares.use('/path', handler)`
        if (
          method === 'use' &&
          ts.isPropertyAccessExpression(recv) &&
          recv.name.text === 'middlewares'
        ) {
          const p = literalPath(node.arguments[0]);
          const handler = node.arguments.find(isHandlerFn) ?? null;
          if (p != null && handler) {
            routes.push({ method: null, endpoint: normalize(p) || '/', handler, node, source: 'vite' });
          }
        }

        // Express: `<instance>.<verb|use>('/path', ...handlers)`
        if (ts.isIdentifier(recv)) {
          const sym = symOf(checker, recv);
          const kind = sym ? instances.get(sym) : undefined;
          if (sym && kind) {
            const p = literalPath(node.arguments[0]);
            const handler = node.arguments.slice(1).find(isHandlerFn) ?? null;
            const mountsRouter = node.arguments[1] && ts.isIdentifier(node.arguments[1]) && instances.get(symOf(checker, node.arguments[1])!) === 'router';
            if (ROUTE_VERBS.has(method) && p != null) {
              routes.push({ method: method === 'all' ? null : method.toUpperCase(), endpoint: joinPath(prefixOf(sym), p), handler, node, source: 'express' });
            } else if (method === 'use' && p != null && handler && !mountsRouter) {
              // `app.use('/path', handler)` — a path-scoped middleware that serves the route.
              routes.push({ method: null, endpoint: joinPath(prefixOf(sym), p), handler, node, source: 'express' });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return routes;
}

/** Like joinPath but without final normalize — used while accumulating nested mount prefixes. */
function joinPathRaw(prefix: string, p: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = p.startsWith('/') ? p : '/' + p;
  return a + b;
}
