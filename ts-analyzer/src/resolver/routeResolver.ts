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

/** Resolve a route element's screen component, descending through wrapper tags
 *  (`<Suspense fallback={...}><Page/></Suspense>`, fragments) whose own tag does
 *  not resolve to a project component. */
function screenFromJsx(node: ts.JsxElement | ts.JsxSelfClosingElement, ctx: AnalysisContext): { id: string | null; lazy: boolean } {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  const direct = ctx.resolveComponentRef(tag as ts.Expression);
  if (direct.id) return direct;
  if (ts.isJsxElement(node)) {
    for (const child of node.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
        const inner = screenFromJsx(child, ctx);
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
    if (!ts.isObjectLiteralExpression(el)) continue;
    let routePath: string | null = null;
    let comp: { id: string | null; lazy: boolean } | null = null;
    const routeFns: ts.FunctionLikeDeclaration[] = [];
    for (const p of el.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = p.name.getText(sf);
      if (key === 'path' && ts.isStringLiteralLike(p.initializer)) routePath = p.initializer.text;
      if (key === 'element') {
        const e = p.initializer;
        if (ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)) {
          comp = screenFromJsx(e, ctx);
        }
      }
      if ((key === 'Component' || key === 'component') && ts.isIdentifier(p.initializer)) {
        comp = ctx.resolveComponentRef(p.initializer);
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
        line: lineOf(sf, el),
      });
    }
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
