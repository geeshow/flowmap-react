/**
 * External HTTP call resolution — the analog of the backend's ExternalResolver.kt.
 * For an axios / fetch / api-wrapper CallExpression it resolves (httpMethod, url)
 * and a confidence, tracing:
 *   - axios instance baseURL (`axios.create({ baseURL })`)
 *   - env / const folding of the path (via ConstantEvaluator)
 *   - cross-function wrappers (component → api fn → axios call), including
 *     binding the caller's argument when the wrapper's URL IS a parameter.
 *
 * Detection is by import source + call shape (no resolved library types needed),
 * so it works on a checkout without node_modules installed.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { AXIOS_MODULES, AXIOS_REQUEST_METHODS, AXIOS_VERB_METHODS, isComponentName, isHookName } from '../classify';
import type { ApiResolution } from '../ir';
import type { Confidence } from '../model';
import { normalize } from '../norm';
import { ConstantEvaluator, EvalString } from './constantEvaluator';
import { realFileName } from './program';

export interface InstanceInfo {
  name: string | null;
  baseUrl: EvalString | null;
  clientPackage: string | null;
}

export interface RawHttp {
  method: string | null;
  verbConfident: boolean;
  urlExpr: ts.Expression | undefined;
  service: string | null;
  instanceBaseUrl: EvalString | null;
  clientPackage: string | null;
}

export class ApiCallResolver {
  private readonly instanceCache = new Map<ts.Symbol, InstanceInfo | null>();
  private readonly projectFiles: Set<string>;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly constEval: ConstantEvaluator,
    private readonly repoRoot: string,
    sourceFiles: ts.SourceFile[],
  ) {
    this.projectFiles = new Set(sourceFiles.map((sf) => path.resolve(sf.fileName)));
  }

  /** Resolve a call to an ApiResolution, or null if it is not an HTTP call. */
  resolve(call: ts.CallExpression): ApiResolution | null {
    const raw = this.classifyHttpCall(call);
    if (raw) return this.buildFromRaw(raw, call, []);
    return this.traceWrapper(call, new Set());
  }

  // ---- direct client classification ----

  protected classifyHttpCall(call: ts.CallExpression): RawHttp | null {
    const callee = call.expression;

    // fetch(url, opts)
    if (ts.isIdentifier(callee) && callee.text === 'fetch' && this.isGlobalFetch(callee)) {
      const opts = call.arguments[1];
      const m = this.methodFromConfig(opts);
      return {
        method: m ?? 'GET',
        verbConfident: m != null,
        urlExpr: call.arguments[0],
        service: 'fetch',
        instanceBaseUrl: null,
        clientPackage: null,
      };
    }

    // axios(config)
    if (ts.isIdentifier(callee) && this.isAxiosImport(callee)) {
      return this.configForm(call, { name: 'axios', baseUrl: null, clientPackage: null });
    }

    // recv.method(...)
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const recv = callee.expression;
      const recvIsAxios = this.isAxiosImport(recv);
      const inst = recvIsAxios ? { name: 'axios', baseUrl: null, clientPackage: null } : this.axiosInstanceInfo(recv);
      if (!inst) return null;

      if (AXIOS_VERB_METHODS.has(method)) {
        return {
          method: method.toUpperCase(),
          verbConfident: true,
          urlExpr: call.arguments[0],
          service: inst.name ?? 'axios',
          instanceBaseUrl: inst.baseUrl,
          clientPackage: inst.clientPackage,
        };
      }
      if (AXIOS_REQUEST_METHODS.has(method)) {
        return this.configForm(call, inst);
      }
      return null;
    }

    // instance(config) — callable axios instance
    if (ts.isIdentifier(callee)) {
      const inst = this.axiosInstanceInfo(callee);
      if (inst) return this.configForm(call, inst);
    }

    return null;
  }

  /** axios({ method, url }) / instance.request({ method, url }) form. */
  protected configForm(call: ts.CallExpression, inst: InstanceInfo): RawHttp {
    const cfg = call.arguments[0];
    const m = this.methodFromConfig(cfg);
    let urlExpr: ts.Expression | undefined;
    if (cfg && ts.isObjectLiteralExpression(cfg)) {
      urlExpr = this.propExpr(cfg, 'url');
    }
    return {
      method: m ?? 'GET',
      verbConfident: m != null,
      urlExpr,
      service: inst.name ?? 'axios',
      instanceBaseUrl: inst.baseUrl,
      clientPackage: inst.clientPackage,
    };
  }

  private methodFromConfig(cfg: ts.Expression | undefined): string | null {
    if (!cfg || !ts.isObjectLiteralExpression(cfg)) return null;
    const m = this.propExpr(cfg, 'method');
    if (!m) return null;
    const ev = this.constEval.evalString(m);
    return ev.value ? ev.value.toUpperCase() : null;
  }

  private propExpr(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && this.propName(p.name) === key) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
    }
    return undefined;
  }

  private propName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    return null;
  }

  // ---- wrapper tracing ----

  private traceWrapper(call: ts.CallExpression, visited: Set<ts.Node>): ApiResolution | null {
    const callee = call.expression;
    const calleeName = this.calleeName(callee);
    // Only trace through plain utility functions. Components/hooks are their own graph
    // nodes and represent their HTTP edges directly — absorbing them into the caller would
    // turn a component→hook `call` edge into a spurious `http` edge.
    const simpleName = calleeName ? calleeName.split('.').pop()! : null;
    if (simpleName && (isComponentName(simpleName) || isHookName(simpleName))) return null;
    const decl = this.functionDeclOf(callee);
    if (!decl || visited.has(decl)) return null;
    if (!this.isProjectNode(decl)) return null;
    visited.add(decl);

    const body = (decl as ts.FunctionLikeDeclaration).body;
    if (!body) return null;

    // 1) A direct axios/fetch/instance call inside this wrapper.
    const inner = this.findInnerHttpCall(body);
    if (inner) {
      const raw = inner.raw;
      // Bind the wrapper's URL to the caller's argument when it derives from a parameter —
      // a positional one (`fn(url)`), a destructured one (`fn({ url })`), or a config-object
      // property (`fn(cfg)` → `cfg.url`). Otherwise keep the literal URL from the wrapper body.
      const bound = this.bindParamExpr(raw.urlExpr, decl, call);
      const boundRaw: RawHttp = { ...raw, urlExpr: bound ?? raw.urlExpr, service: calleeName ?? raw.service };
      const innerMethodName = this.calleeName(inner.call.expression) ?? raw.service ?? 'http';
      return this.buildFromRaw(boundRaw, call, [calleeName ?? '?', innerMethodName]);
    }

    // 2) No direct HTTP call — follow a nested custom wrapper one level deeper
    //    (component → fetchAccountOpenable → fetchData → fetch).
    const nested = this.findNestedWrapperResolution(body, visited);
    if (nested) return { ...nested, wrapperChain: [calleeName ?? '?', ...nested.wrapperChain] };
    return null;
  }

  /** First nested wrapper call whose own tracing yields an HTTP resolution (depth-first). */
  private findNestedWrapperResolution(body: ts.Node, visited: Set<ts.Node>): ApiResolution | null {
    let found: ApiResolution | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const res = this.traceWrapper(node, visited);
        if (res) {
          found = res;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return found;
  }

  /**
   * Substitute a parameter-derived URL expression with the matching call-site argument,
   * so a caller's URL flows into the wrapper's inner HTTP call. Returns null when the URL
   * is not parameter-derived (e.g. a literal in the wrapper body), leaving it untouched.
   */
  private bindParamExpr(
    expr: ts.Expression | undefined,
    decl: ts.FunctionLikeDeclaration,
    call: ts.CallExpression,
  ): ts.Expression | null {
    if (!expr) return null;

    // `fn(url)` or `fn({ url })` → the inner URL is a bare identifier.
    if (ts.isIdentifier(expr)) {
      const sym = this.checker.getSymbolAtLocation(expr);
      const target = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (!target) return null;
      const pIdx = decl.parameters.indexOf(target as ts.ParameterDeclaration);
      if (pIdx >= 0) return call.arguments[pIdx] ?? null; // positional param
      if (ts.isBindingElement(target)) return this.bindFromDestructured(target, decl, call);
      return null;
    }

    // `fn(cfg)` → inner URL is `cfg.url`; map to the `url` property of the caller's object arg.
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const recvSym = this.checker.getSymbolAtLocation(expr.expression);
      const recvDecl = recvSym?.valueDeclaration ?? recvSym?.declarations?.[0];
      const pIdx = recvDecl ? decl.parameters.indexOf(recvDecl as ts.ParameterDeclaration) : -1;
      if (pIdx >= 0) {
        const arg = call.arguments[pIdx];
        if (arg && ts.isObjectLiteralExpression(arg)) return this.propExpr(arg, expr.name.text) ?? null;
      }
    }
    return null;
  }

  /** A destructured-param binding (`fn({ url })` / `fn({ url: u })`) → caller's object property. */
  private bindFromDestructured(
    be: ts.BindingElement,
    decl: ts.FunctionLikeDeclaration,
    call: ts.CallExpression,
  ): ts.Expression | null {
    const key = be.propertyName ? this.propName(be.propertyName) : ts.isIdentifier(be.name) ? be.name.text : null;
    if (!key) return null;
    // Walk up to the owning parameter (skip if it's a local destructure, not a param).
    let node: ts.Node = be;
    while (node.parent && !ts.isParameter(node)) node = node.parent;
    if (!ts.isParameter(node)) return null;
    const pIdx = decl.parameters.indexOf(node);
    if (pIdx < 0) return null;
    const arg = call.arguments[pIdx];
    if (arg && ts.isObjectLiteralExpression(arg)) return this.propExpr(arg, key) ?? null;
    return null;
  }

  /** First HTTP call inside a function body (depth-first). */
  private findInnerHttpCall(body: ts.Node): { call: ts.CallExpression; raw: RawHttp } | null {
    let found: { call: ts.CallExpression; raw: RawHttp } | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const raw = this.classifyHttpCall(node);
        if (raw) {
          found = { call: node, raw };
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return found;
  }

  // ---- assembly ----

  private buildFromRaw(raw: RawHttp, call: ts.CallExpression, wrapperChain: string[]): ApiResolution {
    let urlEval = this.constEval.resolveUrlBuildingCall(raw.urlExpr);
    let urlValue = urlEval.value;
    let hasPlaceholder = urlEval.hasPlaceholder;

    // compose instance baseURL when the path is relative
    if (raw.instanceBaseUrl && urlValue != null && this.isRelative(urlValue)) {
      const composed = this.composeUrl(raw.instanceBaseUrl, urlValue);
      urlValue = composed.value;
      hasPlaceholder = composed.hasPlaceholder;
    } else if (raw.instanceBaseUrl && urlValue == null) {
      // no path at all — fall back to the base
      urlValue = raw.instanceBaseUrl.value;
      hasPlaceholder = raw.instanceBaseUrl.hasPlaceholder;
    }

    const endpoint = urlValue != null ? normalize(this.pathOf(urlValue)) : null;
    const confidence = this.confidence(urlValue, hasPlaceholder, raw.verbConfident);

    return {
      kind: 'api',
      httpMethod: raw.method,
      url: urlValue,
      endpoint: endpoint && endpoint.length ? endpoint : urlValue != null ? '/' : null,
      urlPlaceholder: hasPlaceholder ? urlValue : null,
      service: raw.service,
      clientPackage: raw.clientPackage,
      confidence,
      wrapperChain,
    };
  }

  private confidence(value: string | null, hasPlaceholder: boolean, verbConfident: boolean): Confidence {
    if (value == null) return 'unresolved';
    if (hasPlaceholder || !verbConfident) return 'partial';
    return 'resolved';
  }

  private isRelative(url: string): boolean {
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith('${');
  }

  /** Path component of a URL (strip scheme+host). Keeps relative paths as-is. */
  private pathOf(url: string): string {
    const schemeIdx = url.indexOf('://');
    if (schemeIdx >= 0) {
      const afterHost = url.slice(schemeIdx + 3);
      const slash = afterHost.indexOf('/');
      return slash >= 0 ? afterHost.slice(slash) : '/';
    }
    return url.startsWith('/') ? url : '/' + url;
  }

  private composeUrl(base: EvalString, path0: string): EvalString {
    const b = (base.value ?? '').replace(/\/+$/, '');
    let p = path0;
    if (p && !p.startsWith('/')) p = '/' + p;
    const value = (b + p) || null;
    return { value, hasPlaceholder: base.hasPlaceholder || p.includes('${') };
  }

  // ---- symbol helpers ----

  private isGlobalFetch(node: ts.Identifier): boolean {
    const sym = this.checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    // global fetch has no project declaration
    return !decl || !this.isProjectNode(decl);
  }

  private isAxiosImport(node: ts.Expression): boolean {
    if (!ts.isIdentifier(node)) return false;
    const sym = this.checker.getSymbolAtLocation(node);
    const mod = this.importModuleOf(sym);
    return mod != null && AXIOS_MODULES.has(mod);
  }

  private importModuleOf(sym: ts.Symbol | undefined): string | null {
    const decl = sym?.declarations?.[0];
    if (!decl) return null;
    let candidate: ts.Node | undefined;
    if (ts.isImportClause(decl)) candidate = decl.parent;
    else if (ts.isImportSpecifier(decl)) candidate = decl.parent.parent.parent;
    else if (ts.isNamespaceImport(decl)) candidate = decl.parent.parent;
    if (!candidate || !ts.isImportDeclaration(candidate)) return null;
    const spec = candidate.moduleSpecifier;
    return ts.isStringLiteral(spec) ? spec.text : null;
  }

  private axiosInstanceInfo(node: ts.Expression): InstanceInfo | null {
    if (!ts.isIdentifier(node)) return null;
    let sym = this.checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        /* not an alias */
      }
    }
    if (!sym) return null;
    if (this.instanceCache.has(sym)) return this.instanceCache.get(sym)!;

    let info: InstanceInfo | null = null;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    // `const x = axios.create({...})` or `export default axios.create({...})`.
    const init = this.axiosCreateInitOf(decl);
    if (decl && init) {
      const cfg = init.arguments[0];
      let baseUrl: EvalString | null = null;
      if (cfg && ts.isObjectLiteralExpression(cfg)) {
        const baseExpr = this.propExpr(cfg, 'baseURL');
        if (baseExpr) baseUrl = this.constEval.evalString(baseExpr);
      }
      info = {
        name: ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : null,
        baseUrl,
        clientPackage: this.relOf(decl),
      };
    }
    this.instanceCache.set(sym, info);
    return info;
  }

  /** The `axios.create(...)` call backing a declaration, whether a `const` or `export default`. */
  private axiosCreateInitOf(decl: ts.Node | undefined): ts.CallExpression | null {
    if (!decl) return null;
    let expr: ts.Expression | undefined;
    if (ts.isVariableDeclaration(decl)) expr = decl.initializer;
    else if (ts.isExportAssignment(decl)) expr = decl.expression;
    if (!expr || !ts.isCallExpression(expr)) return null;
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === 'create' &&
      this.isAxiosImport(expr.expression.expression)
    ) {
      return expr;
    }
    return null;
  }

  private functionDeclOf(callee: ts.Expression): ts.FunctionLikeDeclaration | null {
    let sym = this.checker.getSymbolAtLocation(callee);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        /* ignore */
      }
    }
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl) return null;
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
    return null;
  }

  private calleeName(callee: ts.Expression): string | null {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) {
      const recv = ts.isIdentifier(callee.expression) ? callee.expression.text + '.' : '';
      return recv + callee.name.text;
    }
    return null;
  }

  private isProjectNode(node: ts.Node): boolean {
    return this.projectFiles.has(path.resolve(node.getSourceFile().fileName));
  }

  private relOf(node: ts.Node): string {
    return path.relative(this.repoRoot, realFileName(node.getSourceFile().fileName)).split(path.sep).join('/');
  }
}
