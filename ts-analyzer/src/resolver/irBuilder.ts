/**
 * The Resolver implementation — orchestrates all passes over one Program per
 * project and emits IrFile[]. This is the only place `ts.*` is walked; the
 * output IR is pure (consumed by the GraphBuilder).
 *
 * Per project:
 *   A. discover component/hook declarations (project-wide symbol index)
 *   B. collect stores + usage bindings (project-wide)
 *   C. walk each component body → jsxUsages (render) + calls (api/internal/store)
 *   D. collect routes (react-router AST + Next.js filesystem)
 */

import * as path from 'path';
import * as ts from 'typescript';
import { REDUX_HOOKS, isComponentName, isHookName } from '../classify';
import type {
  ComponentKind,
  IrCall,
  IrComponent,
  IrFile,
  IrJsxUsage,
  IrRoute,
  IrStore,
  Resolver,
  ResolveOptions,
} from '../ir';
import { ApiCallResolver } from './apiCallResolver';
import { ConstantEvaluator } from './constantEvaluator';
import { AnalysisContext } from './context';
import { EnvResolver } from './envResolver';
import { buildProjectProgram, discoverProjects, isNextProject, provenance, repoRel } from './program';
import { findNextRoutes, findReactRouterRoutes } from './routeResolver';
import { StoreAccumulator, collectStores, emptyAccumulator } from './storeResolver';

interface CompMeta {
  comp: IrComponent;
  decl: ts.Node; // declaration node (for symbol identity)
  bodyOwner: ts.Node; // function/class node whose body we walk
  file: ts.SourceFile;
}

export class TsResolver implements Resolver {
  analyze(opts: ResolveOptions): IrFile[] {
    const repoRoot = path.resolve(opts.repoRoot);
    const projects = discoverProjects(repoRoot, opts.projectFilter);
    const out: IrFile[] = [];
    for (const projectRoot of projects) {
      out.push(...this.analyzeProject(projectRoot, repoRoot, opts));
    }
    return out;
  }

  /** Analyze a single explicit project root (used by the per-project worker). */
  analyzeRoot(projectRoot: string, repoRoot: string, opts: ResolveOptions): IrFile[] {
    return this.analyzeProject(path.resolve(projectRoot), path.resolve(repoRoot), opts);
  }

  private analyzeProject(projectRoot: string, repoRoot: string, opts: ResolveOptions): IrFile[] {
    const pp = buildProjectProgram(projectRoot, { repoRoot });
    const ctx = new AnalysisContext(pp.checker, repoRoot, pp.program.getCompilerOptions(), pp.sourceFiles);

    const env = new EnvResolver(opts.env);
    env.loadDotenv(projectRoot);
    const constEval = new ConstantEvaluator(pp.checker, env);
    const api = new ApiCallResolver(pp.checker, constEval, repoRoot, pp.sourceFiles);

    // A. discover components/hooks
    const metas: CompMeta[] = [];
    const compBySymbol = new Map<ts.Symbol, CompMeta>();
    for (const sf of pp.sourceFiles) {
      for (const m of this.discoverComponents(sf, ctx)) {
        metas.push(m);
        const sym = ctx.symbolAt(declNameNode(m.decl) ?? m.decl);
        if (sym) compBySymbol.set(sym, m);
      }
    }

    // B. collect stores + bindings (project-wide)
    const stores: StoreAccumulator = emptyAccumulator();
    for (const sf of pp.sourceFiles) collectStores(sf, ctx, stores);

    // B2. redux thunks become walkable "action" nodes (dispatch → thunk → API edges).
    for (const t of stores.thunks) {
      const meta: CompMeta = { comp: t.comp, decl: t.bodyOwner, bodyOwner: t.bodyOwner, file: t.file };
      metas.push(meta);
    }

    // C. walk component bodies
    const walker = new BodyWalker(ctx, api, compBySymbol, stores);
    for (const m of metas) walker.walk(m);

    // D. routes
    const routesByFile = new Map<string, IrRoute[]>();
    const addRoutes = (file: string, rs: IrRoute[]) => {
      if (!rs.length) return;
      routesByFile.set(file, [...(routesByFile.get(file) ?? []), ...rs]);
    };
    const nextProject = isNextProject(projectRoot);
    for (const sf of pp.sourceFiles) {
      addRoutes(sf.fileName, findReactRouterRoutes(sf, ctx));
      if (nextProject) addRoutes(sf.fileName, findNextRoutes(sf, ctx, projectRoot));
    }

    // assemble IrFile per source file
    return this.assembleFiles(pp.sourceFiles, repoRoot, metas, stores.stores, routesByFile, ctx);
  }

  private assembleFiles(
    sourceFiles: ts.SourceFile[],
    repoRoot: string,
    metas: CompMeta[],
    allStores: IrStore[],
    routesByFileAbs: Map<string, IrRoute[]>,
    ctx: AnalysisContext,
  ): IrFile[] {
    // group everything by repo-relative path
    const comps = new Map<string, IrComponent[]>();
    for (const m of metas) {
      const rel = repoRel(repoRoot, m.file.fileName);
      comps.set(rel, [...(comps.get(rel) ?? []), m.comp]);
    }
    const routes = new Map<string, IrRoute[]>();
    for (const [abs, rs] of routesByFileAbs) {
      const rel = repoRel(repoRoot, abs);
      routes.set(rel, [...(routes.get(rel) ?? []), ...rs]);
    }
    const stores = new Map<string, IrStore[]>();
    for (const s of allStores) {
      const rel = (s as IrStore & { __file?: string }).__file ?? '';
      stores.set(rel, [...(stores.get(rel) ?? []), s]);
    }

    const allPaths = new Set<string>([...comps.keys(), ...routes.keys(), ...stores.keys()]);
    const files: IrFile[] = [];
    for (const rel of allPaths) {
      if (!rel) continue;
      const { project, module } = provenance(rel);
      files.push({
        path: rel,
        project,
        module,
        language: languageOf(rel),
        components: comps.get(rel) ?? [],
        routes: routes.get(rel) ?? [],
        stores: stores.get(rel) ?? [],
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---- component discovery ----

  private discoverComponents(sf: ts.SourceFile, ctx: AnalysisContext): CompMeta[] {
    const out: CompMeta[] = [];
    for (const stmt of sf.statements) {
      const exported = hasExport(stmt);
      // function Foo() {}
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        const meta = this.makeComp(stmt.name.text, stmt, stmt, sf, ctx, exported, isAsyncFn(stmt));
        if (meta) out.push(meta);
        continue;
      }
      // export default function Foo() {} / function() {}
      if (ts.isFunctionDeclaration(stmt) && !stmt.name && stmt.body && hasDefault(stmt)) {
        const meta = this.makeComp('default', stmt, stmt, sf, ctx, true, isAsyncFn(stmt), 'component');
        if (meta) out.push(meta);
        continue;
      }
      // const Foo = () => {} | function() {}
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = decl.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const meta = this.makeComp(decl.name.text, decl, init, sf, ctx, exported, isAsyncFn(init));
            if (meta) out.push(meta);
          }
        }
        continue;
      }
      // class Foo extends React.Component {}
      if (ts.isClassDeclaration(stmt) && stmt.name && isComponentName(stmt.name.text)) {
        const meta = this.makeComp(stmt.name.text, stmt, stmt, sf, ctx, exported, false, 'component');
        if (meta) out.push(meta);
      }
    }
    return out;
  }

  private makeComp(
    name: string,
    decl: ts.Node,
    bodyOwner: ts.Node,
    sf: ts.SourceFile,
    ctx: AnalysisContext,
    exported: boolean,
    isAsync: boolean,
    forceKind?: ComponentKind,
  ): CompMeta | null {
    const kind: ComponentKind = forceKind ?? (isComponentName(name) ? 'component' : isHookName(name) ? 'hook' : 'function');
    if (kind === 'function') return null; // plain utilities aren't nodes (wrappers resolved via api tracing)
    const id = `${ctx.repoRel(sf.fileName)}::${name}`;
    const comp: IrComponent = {
      id,
      name,
      kind,
      exported,
      isAsync,
      line: lineOf(sf, decl),
      jsxUsages: [],
      calls: [],
    };
    return { comp, decl, bodyOwner, file: sf };
  }
}

/** Walks a single component/hook body collecting render usages and calls. */
class BodyWalker {
  constructor(
    private readonly ctx: AnalysisContext,
    private readonly api: ApiCallResolver,
    private readonly compBySymbol: Map<ts.Symbol, CompMeta>,
    private readonly stores: StoreAccumulator,
  ) {}

  walk(m: CompMeta): void {
    const dispatchers = this.findDispatchers(m.bodyOwner);
    let asyncDepth = m.comp.isAsync ? 1 : 0;
    const sf = m.file;

    const visit = (node: ts.Node) => {
      let entered = false;
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && isAsyncFn(node)) {
        asyncDepth++;
        entered = true;
      }

      // JSX render usage
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const usage = this.jsxUsage(node, sf);
        if (usage) m.comp.jsxUsages.push(usage);
      }

      // calls
      if (ts.isCallExpression(node)) {
        const call = this.resolveCall(node, asyncDepth > 0, dispatchers, sf);
        if (call) m.comp.calls.push(call);
      }

      ts.forEachChild(node, visit);
      if (entered) asyncDepth--;
    };
    // walk the body only (skip the signature)
    const body = bodyOf(m.bodyOwner);
    if (body) ts.forEachChild(body, visit);
  }

  private jsxUsage(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sf: ts.SourceFile): IrJsxUsage | null {
    const tag = node.tagName.getText(sf);
    const simple = tag.split('.')[0];
    if (!isComponentName(simple)) return null; // native html element
    const resolved = this.ctx.resolveComponentRef(node.tagName as ts.Expression);
    return { tagName: tag, targetComponentId: resolved.id, lazy: resolved.lazy, line: lineOf(sf, node) };
  }

  private resolveCall(node: ts.CallExpression, inAsyncCtx: boolean, dispatchers: Set<ts.Symbol>, sf: ts.SourceFile): IrCall | null {
    const line = lineOf(sf, node);

    // 1) store usages
    const store = this.resolveStoreUsage(node, dispatchers);
    if (store) return { line, inAsyncCtx, resolution: store };

    // 2) HTTP api calls (incl. wrapper tracing)
    const apiRes = this.api.resolve(node);
    if (apiRes) return { line, inAsyncCtx, resolution: apiRes };

    // 3) internal call to a tracked component/hook
    const internal = this.resolveInternal(node);
    if (internal) return { line, inAsyncCtx, resolution: internal };

    return null;
  }

  private resolveInternal(node: ts.CallExpression): IrCall['resolution'] | null {
    const sym = this.ctx.symbolAt(node.expression);
    if (!sym) return null;
    const target = this.compBySymbol.get(sym);
    if (!target) return null;
    return {
      kind: 'internal',
      calleeComponentId: target.comp.id,
      calleeName: target.comp.name,
      calleeIsAsync: target.comp.isAsync,
    };
  }

  private resolveStoreUsage(node: ts.CallExpression, dispatchers: Set<ts.Symbol>): IrCall['resolution'] | null {
    const callee = node.expression;
    // dispatch(actionCreator(...))
    if (ts.isIdentifier(callee)) {
      const sym = this.ctx.symbolAt(callee);
      if (sym && dispatchers.has(sym)) {
        const storeId = this.storeIdOfDispatchArg(node.arguments[0]);
        if (storeId) return { kind: 'storeDispatch', storeId, action: this.actionName(node.arguments[0]) };
        return null;
      }
      // zustand: useCartStore(selector)
      if (sym && this.stores.bindings.bySymbol.has(sym)) {
        return { kind: 'storeRead', storeId: this.stores.bindings.bySymbol.get(sym)!, selector: null };
      }
      // useSelector(state => state.key...)
      if (callee.text === 'useSelector') {
        const key = this.selectorKey(node.arguments[0]);
        const storeId = key ? this.stores.bindings.reduxByKey.get(key) : undefined;
        if (storeId) return { kind: 'storeRead', storeId, selector: key };
        return null;
      }
      // useContext(XContext)
      if (callee.text === 'useContext') {
        const arg = node.arguments[0];
        if (arg && ts.isIdentifier(arg)) {
          const csym = this.ctx.symbolAt(arg);
          const storeId = csym ? this.stores.bindings.bySymbol.get(csym) : undefined;
          if (storeId) return { kind: 'storeRead', storeId, selector: null };
        }
        return null;
      }
      // useDispatch() itself is not a usage edge
      if (REDUX_HOOKS.has(callee.text)) return null;
    }
    return null;
  }

  /** Variables assigned from useDispatch() in this body. */
  private findDispatchers(bodyOwner: ts.Node): Set<ts.Symbol> {
    const out = new Set<ts.Symbol>();
    const body = bodyOf(bodyOwner);
    if (!body) return out;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'useDispatch'
      ) {
        const sym = this.ctx.symbolAt(node.name);
        if (sym) out.add(sym);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return out;
  }

  private storeIdOfDispatchArg(arg: ts.Expression | undefined): string | null {
    if (!arg) return null;
    // dispatch(fetchUser(...)) or dispatch(slice.actions.foo(...))
    const inner = ts.isCallExpression(arg) ? arg.expression : arg;
    // thunk / plain action creator
    if (ts.isIdentifier(inner)) {
      const sym = this.ctx.symbolAt(inner);
      if (sym && this.stores.bindings.bySymbol.has(sym)) return this.stores.bindings.bySymbol.get(sym)!;
    }
    // slice.actions.foo
    if (ts.isPropertyAccessExpression(inner)) {
      let root: ts.Expression = inner;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root)) {
        const sym = this.ctx.symbolAt(root);
        if (sym && this.stores.bindings.sliceVarSymbol.has(sym)) return this.stores.bindings.sliceVarSymbol.get(sym)!;
      }
    }
    return null;
  }

  private actionName(arg: ts.Expression | undefined): string | null {
    if (!arg) return null;
    const inner = ts.isCallExpression(arg) ? arg.expression : arg;
    if (ts.isIdentifier(inner)) return inner.text;
    if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
    return null;
  }

  private selectorKey(arg: ts.Expression | undefined): string | null {
    if (!arg || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return null;
    let key: string | null = null;
    const visit = (node: ts.Node) => {
      if (key) return;
      // state.KEY...
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        key = node.name.text;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(arg.body);
    return key;
  }
}

// ---- standalone helpers ----

function declNameNode(decl: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return decl.name ?? null;
  if (ts.isVariableDeclaration(decl)) return decl.name;
  return null;
}

function bodyOf(owner: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) return owner.body;
  if (ts.isClassDeclaration(owner)) return owner;
  return undefined;
}

function isAsyncFn(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function hasExport(stmt: ts.Statement): boolean {
  return !!(ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefault(stmt: ts.Statement): boolean {
  return !!(ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function languageOf(fileName: string): IrFile['language'] {
  if (fileName.endsWith('.tsx')) return 'tsx';
  if (fileName.endsWith('.ts')) return 'ts';
  if (fileName.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
