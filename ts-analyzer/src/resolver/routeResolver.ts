/**
 * Route / screen discovery — react-router (JSX + object form, incl. lazy) and
 * Next.js filesystem routing (pages/ and app/). Produces IrRoute[] that point at
 * the screen component id, plus the set of component ids that ARE screens (so
 * the render-graph pass can mark them SCREEN with their route path).
 */

import * as path from 'path';
import * as ts from 'typescript';
import { NEXT_NON_SCREEN, ROUTER_FACTORY_FNS, ROUTER_ROUTE_TAGS } from '../classify';
import type { IrRoute } from '../ir';
import { AnalysisContext } from './context';

/** A route's data function (react-router v6.4+ `loader`/`action`) and its screen. */
export interface RouteDataFn {
  screenComponentId: string | null;
  fn: ts.FunctionLikeDeclaration;
}

/** AST-based react-router routes within one source file. `dataFns`, if given,
 *  collects route `loader`/`action` functions (their HTTP calls belong to the screen). */
export function findReactRouterRoutes(sf: ts.SourceFile, ctx: AnalysisContext, dataFns?: RouteDataFn[]): IrRoute[] {
  const routes: IrRoute[] = [];

  const visit = (node: ts.Node) => {
    // JSX: <Route path="..." element={<Comp/>} /> | component={Comp}
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf);
      if (ROUTER_ROUTE_TAGS.has(tag)) {
        const route = routeFromJsxAttrs(node.attributes, sf, ctx);
        if (route) routes.push(route);
      }
    }
    // Object form: createBrowserRouter([...]) / useRoutes([...]) — inline array or
    // an identifier referencing a routes array declared/imported elsewhere.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ROUTER_FACTORY_FNS.has(node.expression.text)) {
      const arr = node.arguments[0];
      if (arr && ts.isArrayLiteralExpression(arr)) {
        collectObjectRoutes(arr, sf, ctx, routes, dataFns);
      } else if (arr && ts.isIdentifier(arr)) {
        const resolved = resolveRoutesArray(arr, ctx);
        if (resolved) collectObjectRoutes(resolved, resolved.getSourceFile(), ctx, routes, dataFns);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return routes;
}

/** Resolve a `createBrowserRouter(routes)` identifier to its array-literal declaration. */
function resolveRoutesArray(id: ts.Identifier, ctx: AnalysisContext): ts.ArrayLiteralExpression | null {
  const sym = ctx.symbolAt(id);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
    return decl.initializer;
  }
  return null;
}

function routeFromJsxAttrs(attrs: ts.JsxAttributes, sf: ts.SourceFile, ctx: AnalysisContext): IrRoute | null {
  let routePath: string | null = null;
  let comp: { id: string | null; lazy: boolean } | null = null;
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText(sf);
    if (name === 'path' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
      routePath = attr.initializer.text;
    }
    if ((name === 'element' || name === 'Component' || name === 'component') && attr.initializer) {
      comp = componentFromAttrInitializer(attr.initializer, ctx);
    }
  }
  const line = lineOf(sf, attrs.parent);
  return {
    routePath,
    screenComponentId: comp?.id ?? null,
    lazy: comp?.lazy ?? false,
    source: 'react-router',
    line,
  };
}

function componentFromAttrInitializer(init: ts.JsxAttributeValue, ctx: AnalysisContext): { id: string | null; lazy: boolean } {
  // element={<Comp/>}
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isJsxSelfClosingElement(expr) || ts.isJsxElement(expr)) {
      return screenFromJsx(expr, ctx);
    }
    // Component={Comp}
    return ctx.resolveComponentRef(expr);
  }
  return { id: null, lazy: false };
}

/** Maps a route-factory's parameter symbols to the call-site argument expressions,
 *  so `route(path, Component)` returning `{ path, Component }` can be inlined. */
type Subst = Map<ts.Symbol, ts.Expression> | null;

/** Replace a parameter identifier with the matching call-site argument, per `subst`. */
function applySubst(expr: ts.Expression, subst: Subst, ctx: AnalysisContext): ts.Expression {
  if (!subst || !ts.isIdentifier(expr)) return expr;
  const sym = ctx.symbolAt(expr);
  return sym && subst.has(sym) ? subst.get(sym)! : expr;
}

/** Resolve a route element's screen component, descending through wrapper tags
 *  (`<Suspense fallback={...}><Page/></Suspense>`, fragments) whose own tag does
 *  not resolve to a project component. */
function screenFromJsx(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  ctx: AnalysisContext,
  subst: Subst = null,
): { id: string | null; lazy: boolean } {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  const direct = ctx.resolveComponentRef(applySubst(tag as ts.Expression, subst, ctx));
  if (direct.id) return direct;
  if (ts.isJsxElement(node)) {
    for (const child of node.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
        const inner = screenFromJsx(child, ctx, subst);
        if (inner.id) return inner;
      }
    }
  }
  return { id: null, lazy: false };
}

function collectObjectRoutes(
  arr: ts.ArrayLiteralExpression,
  sf: ts.SourceFile,
  ctx: AnalysisContext,
  out: IrRoute[],
  dataFns?: RouteDataFn[],
): void {
  for (const el of arr.elements) {
    if (ts.isObjectLiteralExpression(el)) {
      parseRouteObject(el, el, sf, ctx, out, dataFns, null);
    } else if (ts.isCallExpression(el)) {
      // route('/path', Component) factory element — inline its returned object literal.
      const factory = resolveRouteFactory(el, ctx);
      if (factory) parseRouteObject(factory.obj, el, factory.obj.getSourceFile(), ctx, out, dataFns, factory.subst);
    }
  }
}

/** A `route(path, Comp)` factory call → its returned object literal + a param→arg map. */
function resolveRouteFactory(call: ts.CallExpression, ctx: AnalysisContext): { obj: ts.ObjectLiteralExpression; subst: Subst } | null {
  const sym = ctx.symbolAt(call.expression);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
  else if (decl && ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
    fn = decl.initializer;
  }
  if (!fn || !fn.body) return null;

  // The returned object literal: concise arrow `=> ({...})` or a block's `return {...}`.
  let obj: ts.ObjectLiteralExpression | undefined;
  if (ts.isBlock(fn.body)) {
    for (const st of fn.body.statements) {
      if (ts.isReturnStatement(st) && st.expression) {
        let e: ts.Expression = st.expression;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        if (ts.isObjectLiteralExpression(e)) obj = e;
        break;
      }
    }
  } else {
    let e: ts.Expression = fn.body;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isObjectLiteralExpression(e)) obj = e;
  }
  if (!obj) return null;

  const subst: Map<ts.Symbol, ts.Expression> = new Map();
  fn.parameters.forEach((param, i) => {
    if (ts.isIdentifier(param.name) && call.arguments[i]) {
      const psym = ctx.symbolAt(param.name);
      if (psym) subst.set(psym, call.arguments[i]);
    }
  });
  return { obj, subst };
}

/** Parse one route object literal (possibly a factory's return, with `subst`).
 *  `lineNode` is where the route is reported from (the array element). */
function parseRouteObject(
  el: ts.ObjectLiteralExpression,
  lineNode: ts.Node,
  sf: ts.SourceFile,
  ctx: AnalysisContext,
  out: IrRoute[],
  dataFns: RouteDataFn[] | undefined,
  subst: Subst,
): void {
  let routePath: string | null = null;
  let comp: { id: string | null; lazy: boolean } | null = null;
  const routeFns: ts.FunctionLikeDeclaration[] = [];
  for (const p of el.properties) {
    // `{ path, Component }` shorthand resolves to the like-named param via subst.
    // A shorthand's value symbol is NOT getSymbolAtLocation(name) — use the checker's
    // dedicated lookup so it maps to the factory parameter, not the property itself.
    if (ts.isShorthandPropertyAssignment(p)) {
      const key = p.name.text;
      const valSym = subst ? ctx.checker.getShorthandAssignmentValueSymbol(p) : undefined;
      const val: ts.Expression = valSym && subst!.has(valSym) ? subst!.get(valSym)! : p.name;
      if (key === 'path' && ts.isStringLiteralLike(val)) routePath = val.text;
      if ((key === 'Component' || key === 'component') && ts.isIdentifier(val)) comp = ctx.resolveComponentRef(val);
      continue;
    }
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name.getText(sf);
    if (key === 'path') {
      const val = applySubst(p.initializer, subst, ctx);
      if (ts.isStringLiteralLike(val)) routePath = val.text;
    }
    if (key === 'element') {
      const e = p.initializer;
      if (ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)) comp = screenFromJsx(e, ctx, subst);
    }
    if ((key === 'Component' || key === 'component') && ts.isIdentifier(p.initializer)) {
      comp = ctx.resolveComponentRef(applySubst(p.initializer, subst, ctx));
    }
    if (key === 'lazy') {
      // lazy: () => import('./Page') → resolve the module's Component/default export.
      const lazyId = ctx.resolveRouteLazyModule(p.initializer);
      comp = { id: lazyId ?? comp?.id ?? null, lazy: true };
    }
    if ((key === 'loader' || key === 'action') && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
      routeFns.push(p.initializer);
    }
    if (key === 'children' && ts.isArrayLiteralExpression(p.initializer)) {
      collectObjectRoutes(p.initializer, sf, ctx, out, dataFns);
    }
  }
  if (dataFns) for (const fn of routeFns) dataFns.push({ screenComponentId: comp?.id ?? null, fn });
  if (routePath != null || comp?.id) {
    out.push({
      routePath,
      screenComponentId: comp?.id ?? null,
      lazy: comp?.lazy ?? false,
      source: 'react-router',
      line: lineOf(lineNode.getSourceFile(), lineNode),
    });
  }
}

/**
 * Next.js filesystem routes for a project. Derives the route path from the file
 * location and points at the file's default-exported component.
 */
export function findNextRoutes(sf: ts.SourceFile, ctx: AnalysisContext, projectRoot: string): IrRoute[] {
  const rel = path.relative(projectRoot, sf.fileName).split(path.sep).join('/');
  const info = nextRouteInfo(rel);
  if (!info) return [];
  const defName = ctx.defaultExportComponentName(sf);
  const id = defName ? `${ctx.repoRel(sf.fileName)}::${defName}` : null;
  return [{ routePath: info.routePath, screenComponentId: id, lazy: false, source: info.source, line: 1 }];
}

interface NextInfo {
  routePath: string;
  source: 'next-pages' | 'next-app';
}

/** Map a project-relative file path to a Next.js route, or null if not a screen. */
export function nextRouteInfo(rel: string): NextInfo | null {
  const parts = rel.split('/');
  const srcless = parts[0] === 'src' ? parts.slice(1) : parts;

  // app router: <app>/**/page.(tsx|jsx|ts|js)
  const appIdx = srcless.indexOf('app');
  if (appIdx === 0) {
    const file = srcless[srcless.length - 1];
    if (/^page\.(t|j)sx?$/.test(file)) {
      const segs = srcless.slice(1, -1).filter((s) => !/^\(.*\)$/.test(s)); // strip route groups
      return { routePath: toRoutePath(segs), source: 'next-app' };
    }
    return null;
  }

  // pages router: <pages>/**/*.(tsx|jsx|ts|js)
  const pagesIdx = srcless.indexOf('pages');
  if (pagesIdx === 0) {
    const rest = srcless.slice(1);
    if (rest[0] === 'api') return null; // API routes handled elsewhere
    const fileName = rest[rest.length - 1].replace(/\.(t|j)sx?$/, '');
    if (NEXT_NON_SCREEN.has(fileName)) return null;
    const segs = rest.slice(0, -1);
    if (fileName !== 'index') segs.push(fileName);
    return { routePath: toRoutePath(segs), source: 'next-pages' };
  }

  return null;
}

/** Export names a Next.js route handler / API route may define. */
export const NEXT_HANDLER_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * The served endpoint path for a Next.js route handler file, or null if the file
 * is not one. Handles App Router `app/**​/route.(ts|tsx|js|jsx)` and Pages Router
 * `pages/api/**`. Dynamic segments ([id], [...slug]) collapse to "{}".
 */
export function nextRouteHandlerPath(rel: string): string | null {
  const parts = rel.split('/');
  const srcless = parts[0] === 'src' ? parts.slice(1) : parts;

  // App Router: app/**/route.(t|j)sx?
  if (srcless[0] === 'app') {
    const file = srcless[srcless.length - 1];
    if (!/^route\.(t|j)sx?$/.test(file)) return null;
    const segs = srcless.slice(1, -1).filter((s) => !/^\(.*\)$/.test(s)); // strip route groups
    return toRoutePath(segs);
  }

  // Pages Router API routes: pages/api/**
  if (srcless[0] === 'pages' && srcless[1] === 'api') {
    const rest = srcless.slice(1); // includes 'api'
    const fileName = rest[rest.length - 1].replace(/\.(t|j)sx?$/, '');
    const segs = rest.slice(0, -1);
    if (fileName !== 'index') segs.push(fileName);
    return toRoutePath(segs);
  }

  return null;
}

/** Convert filesystem segments to a route path, normalizing dynamic segments to "{}". */
function toRoutePath(segs: string[]): string {
  const mapped = segs.map((s) => {
    if (/^\[\.\.\..+\]$/.test(s)) return '{}'; // [...slug] catch-all
    if (/^\[.+\]$/.test(s)) return '{}'; // [id] dynamic
    return s;
  });
  return '/' + mapped.join('/');
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
