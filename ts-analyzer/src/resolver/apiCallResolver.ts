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
import {
  APOLLO_HOOKS,
  APOLLO_MODULES,
  AXIOS_MODULES,
  AXIOS_REQUEST_METHODS,
  AXIOS_VERB_METHODS,
  GRAPHQL_REQUEST_MODULES,
  HTTP_CLIENT_MODULES,
  REALTIME_CLIENT_MODULES,
  SWR_MUTATION_MODULES,
  SWR_QUERY_MODULES,
  URQL_HOOKS,
  URQL_MODULES,
  isComponentName,
  isHookName,
} from '../classify';
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
  /** The `method` config expression (for binding a wrapper's `cfg.method` to the caller). */
  methodExpr?: ts.Expression | undefined;
  service: string | null;
  instanceBaseUrl: EvalString | null;
  clientPackage: string | null;
}

export class ApiCallResolver {
  private readonly instanceCache = new Map<ts.Symbol, InstanceInfo | null>();
  private readonly projectFiles: Set<string>;
  /** RTK Query generated-hook name → resolved endpoint (built once from createApi). */
  private readonly rtkHooks: Map<string, ApiResolution>;
  private readonly sourceFiles: ts.SourceFile[];
  /** callee symbol → its call sites across the project (lazily built). */
  private callSiteIndex: Map<ts.Symbol, ts.CallExpression[]> | null = null;
  /** Project-wide GraphQL endpoint bases: the uri/url on the (singleton) client. */
  private readonly graphqlBases: { apollo: EvalString | null; urql: EvalString | null };

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly constEval: ConstantEvaluator,
    private readonly repoRoot: string,
    sourceFiles: ts.SourceFile[],
  ) {
    this.projectFiles = new Set(sourceFiles.map((sf) => path.resolve(sf.fileName)));
    this.sourceFiles = sourceFiles;
    this.rtkHooks = this.buildRtkRegistry(sourceFiles);
    this.graphqlBases = this.buildGraphqlBases(sourceFiles);
  }

  /** Resolve a call to an ApiResolution, or null if it is not an HTTP call. */
  resolve(call: ts.CallExpression): ApiResolution | null {
    // RTK Query generated hook: useGetWidgetQuery() → its endpoint.
    if (this.rtkHooks.size && ts.isIdentifier(call.expression)) {
      const hit = this.rtkHooks.get(call.expression.text);
      if (hit) return hit;
    }
    const raw = this.classifyHttpCall(call);
    if (raw) {
      // A url that is an unbound parameter of the ENCLOSING function (a custom data
      // hook like `useApi(url) → useQuery(() => axios.get(url))`) can't resolve from
      // the definition alone. Bind it from the hook's call sites when they agree.
      const bound = this.bindUrlFromCallSites(raw.urlExpr);
      if (bound) return this.buildFromRaw({ ...raw, urlExpr: bound }, call, []);
      return this.buildFromRaw(raw, call, []);
    }
    return this.traceWrapper(call, new Set());
  }

  /** `new WebSocket(url)` / `new EventSource(url)` — realtime external endpoints
   *  (browser globals, detected by constructor name). */
  resolveNew(node: ts.NewExpression): ApiResolution | null {
    if (!ts.isIdentifier(node.expression)) return null;
    const name = node.expression.text;
    if (name !== 'WebSocket' && name !== 'EventSource') return null;
    const raw: RawHttp = {
      method: name === 'EventSource' ? 'GET' : null, // SSE is an HTTP GET; ws has no verb
      verbConfident: name === 'EventSource',
      urlExpr: node.arguments?.[0],
      service: name === 'EventSource' ? 'sse' : 'websocket',
      instanceBaseUrl: null,
      clientPackage: null,
    };
    return this.buildFromRaw(raw, node as unknown as ts.CallExpression, []);
  }

  // ---- direct client classification ----

  protected classifyHttpCall(call: ts.CallExpression): RawHttp | null {
    const callee = call.expression;

    // fetch(url, opts) — also fetch(new Request(url, { method }))
    if (ts.isIdentifier(callee) && callee.text === 'fetch' && this.isGlobalFetch(callee)) {
      let urlExpr = call.arguments[0];
      let m = this.methodFromConfig(call.arguments[1]);
      if (urlExpr && ts.isNewExpression(urlExpr) && ts.isIdentifier(urlExpr.expression) && urlExpr.expression.text === 'Request') {
        if (m == null) m = this.methodFromConfig(urlExpr.arguments?.[1]); // verb lives inside the Request init
        if (urlExpr.arguments?.[0]) urlExpr = urlExpr.arguments[0];
      }
      return {
        method: m ?? 'GET',
        verbConfident: m != null,
        urlExpr,
        service: 'fetch',
        instanceBaseUrl: null,
        clientPackage: null,
      };
    }

    // axios(config)
    if (ts.isIdentifier(callee) && this.isAxiosImport(callee)) {
      return this.configForm(call, { name: 'axios', baseUrl: null, clientPackage: null });
    }

    // ky(url, {method}) / got(url, {method}) — callable HTTP clients
    if (ts.isIdentifier(callee)) {
      const client = this.httpClientName(callee);
      if (client) {
        const m = this.methodFromConfig(call.arguments[1]);
        return { method: m ?? 'GET', verbConfident: m != null, urlExpr: call.arguments[0], service: client, instanceBaseUrl: null, clientPackage: null };
      }
    }

    // useSWR(key, fetcher) — the key is the request URL (GET). Default-imported,
    // so detect by module ('swr' / 'swr/immutable' / 'swr/infinite'), not name.
    if (ts.isIdentifier(callee)) {
      const mod = this.importModuleOf(this.checker.getSymbolAtLocation(callee));
      if (mod && SWR_QUERY_MODULES.has(mod)) {
        return {
          method: 'GET',
          verbConfident: true,
          urlExpr: this.swrKeyExpr(call.arguments[0]),
          service: 'swr',
          instanceBaseUrl: null,
          clientPackage: null,
        };
      }
      // useSWRMutation(key, fetcher) — key is the URL, a write. The verb defaults to
      // POST (SWR mutations are writes) unless the fetcher's inner call says otherwise.
      if (mod && SWR_MUTATION_MODULES.has(mod)) {
        const fetcherVerb = this.fetcherVerb(call.arguments[1]);
        return {
          method: fetcherVerb ?? 'POST',
          verbConfident: fetcherVerb != null,
          urlExpr: this.swrKeyExpr(call.arguments[0]),
          service: 'swr-mutation',
          instanceBaseUrl: null,
          clientPackage: null,
        };
      }
      // graphql-request: request(url, query) — a POST to the GraphQL endpoint.
      if (callee.text === 'request' && mod && GRAPHQL_REQUEST_MODULES.has(mod)) {
        return { method: 'POST', verbConfident: true, urlExpr: call.arguments[0], service: 'graphql-request', instanceBaseUrl: null, clientPackage: null };
      }
      // Apollo / urql hooks — the GraphQL endpoint lives on the project-singleton client
      // (`new ApolloClient({uri})` / `createClient({url})`), not at the call site.
      if (mod && APOLLO_MODULES.has(mod) && APOLLO_HOOKS.has(callee.text) && this.graphqlBases.apollo) {
        return this.graphqlBaseRaw(this.graphqlBases.apollo, 'apollo');
      }
      if (mod && URQL_MODULES.has(mod) && URQL_HOOKS.has(callee.text) && this.graphqlBases.urql) {
        return this.graphqlBaseRaw(this.graphqlBases.urql, 'urql');
      }
      // socket.io-client: io(url) / connect(url) — a realtime (ws) external endpoint.
      if ((callee.text === 'io' || callee.text === 'connect') && mod && REALTIME_CLIENT_MODULES.has(mod)) {
        return { method: null, verbConfident: false, urlExpr: call.arguments[0], service: 'socket.io', instanceBaseUrl: null, clientPackage: mod };
      }
    }

    // recv.method(...)
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const recv = callee.expression;
      // graphql-request: const c = new GraphQLClient(url); c.request(query) — POST to the endpoint.
      if (method === 'request') {
        const gqlBase = this.graphqlClientBaseUrl(recv);
        if (gqlBase) {
          return { method: 'POST', verbConfident: true, urlExpr: undefined, service: 'graphql-request', instanceBaseUrl: gqlBase, clientPackage: null };
        }
      }
      // Apollo imperative: const c = new ApolloClient({uri}); c.query/.mutate/.subscribe(...) — POST.
      if (method === 'query' || method === 'mutate' || method === 'subscribe') {
        const apolloBase = this.apolloClientBaseUrl(recv);
        if (apolloBase) return { method: 'POST', verbConfident: true, urlExpr: undefined, service: 'apollo', instanceBaseUrl: apolloBase, clientPackage: null };
      }
      // ky/got/superagent: client.get/post(url) (verb chains like .send() wrap this inner call)
      const client = this.httpClientName(recv);
      if (client && AXIOS_VERB_METHODS.has(method)) {
        return { method: method.toUpperCase(), verbConfident: true, urlExpr: call.arguments[0], service: client, instanceBaseUrl: null, clientPackage: null };
      }
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

    // axios[method](url) / instance[method](url) — dynamic verb. The verb is computed,
    // so resolve it if it's a constant; otherwise emit the endpoint with an unknown verb.
    if (ts.isElementAccessExpression(callee)) {
      const recv = callee.expression;
      const recvIsAxios = this.isAxiosImport(recv);
      const inst = recvIsAxios ? { name: 'axios', baseUrl: null, clientPackage: null } : this.axiosInstanceInfo(recv);
      if (inst && callee.argumentExpression) {
        const mv = this.constEval.evalString(callee.argumentExpression);
        const verb = mv.value && AXIOS_VERB_METHODS.has(mv.value.toLowerCase()) ? mv.value.toUpperCase() : null;
        return {
          method: verb,
          verbConfident: verb != null,
          urlExpr: call.arguments[0],
          service: inst.name ?? 'axios',
          instanceBaseUrl: inst.baseUrl,
          clientPackage: inst.clientPackage,
        };
      }
    }

    // instance(config) — callable axios instance
    if (ts.isIdentifier(callee)) {
      const inst = this.axiosInstanceInfo(callee);
      if (inst) return this.configForm(call, inst);
    }

    return null;
  }

  /** Verb of an SWR-mutation fetcher: the method of the first HTTP call in its body. */
  private fetcherVerb(fetcher: ts.Expression | undefined): string | null {
    if (!fetcher) return null;
    let body: ts.Node | undefined;
    if (ts.isArrowFunction(fetcher) || ts.isFunctionExpression(fetcher)) body = fetcher.body;
    else {
      const decl = this.functionDeclOf(fetcher); // named fetcher (createUser)
      body = decl?.body;
    }
    if (!body) return null;
    const inner = this.findInnerHttpCall(body);
    return inner && inner.raw.verbConfident ? inner.raw.method : null;
  }

  /** A GraphQL hook (apollo/urql) call → POST to the project client's endpoint. */
  private graphqlBaseRaw(base: EvalString, service: string): RawHttp {
    return { method: 'POST', verbConfident: true, urlExpr: undefined, service, instanceBaseUrl: base, clientPackage: null };
  }

  /** Scan the project once for the GraphQL endpoint base: `new ApolloClient({uri})` /
   *  `new HttpLink({uri})` / `createHttpLink({uri})` (apollo) and `createClient({url})` (urql). */
  private buildGraphqlBases(sourceFiles: ts.SourceFile[]): { apollo: EvalString | null; urql: EvalString | null } {
    let apollo: EvalString | null = null;
    let urql: EvalString | null = null;
    const uriOf = (argsHost: ts.NewExpression | ts.CallExpression, key: string): EvalString | null => {
      const arg = argsHost.arguments?.[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
      const e = this.propExpr(arg, key);
      return e ? this.constEval.evalString(e) : null;
    };
    for (const sf of sourceFiles) {
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          const mod = this.importModuleOf(this.checker.getSymbolAtLocation(node.expression));
          if (!apollo && (name === 'ApolloClient' || name === 'HttpLink') && mod && APOLLO_MODULES.has(mod)) {
            apollo = uriOf(node, 'uri') ?? apollo;
          }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          const mod = this.importModuleOf(this.checker.getSymbolAtLocation(node.expression));
          if (!apollo && name === 'createHttpLink' && mod && APOLLO_MODULES.has(mod)) apollo = uriOf(node, 'uri') ?? apollo;
          if (!urql && name === 'createClient' && mod && URQL_MODULES.has(mod)) urql = uriOf(node, 'url') ?? urql;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return { apollo, urql };
  }

  /** baseUrl of `const c = new ApolloClient({ uri })` (@apollo/client), or null. */
  private apolloClientBaseUrl(node: ts.Expression): EvalString | null {
    if (!ts.isIdentifier(node)) return null;
    const sym = this.checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isNewExpression(decl.initializer)) return null;
    const ne = decl.initializer;
    if (!ts.isIdentifier(ne.expression) || ne.expression.text !== 'ApolloClient') return null;
    const mod = this.importModuleOf(this.checker.getSymbolAtLocation(ne.expression));
    if (!mod || !APOLLO_MODULES.has(mod)) return null;
    const arg = ne.arguments?.[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
    const uri = this.propExpr(arg, 'uri');
    return uri ? this.constEval.evalString(uri) : null;
  }

  /** baseUrl of `const c = new GraphQLClient(url)` (graphql-request), or null. */
  private graphqlClientBaseUrl(node: ts.Expression): EvalString | null {
    if (!ts.isIdentifier(node)) return null;
    const sym = this.checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isNewExpression(decl.initializer)) return null;
    const ne = decl.initializer;
    if (!ts.isIdentifier(ne.expression) || ne.expression.text !== 'GraphQLClient') return null;
    const mod = this.importModuleOf(this.checker.getSymbolAtLocation(ne.expression));
    if (!mod || !GRAPHQL_REQUEST_MODULES.has(mod)) return null;
    const urlArg = ne.arguments?.[0];
    return urlArg ? this.constEval.evalString(urlArg) : null;
  }

  /** axios({ method, url }) / instance.request({ method, url }) form. */
  protected configForm(call: ts.CallExpression, inst: InstanceInfo): RawHttp {
    const cfg = call.arguments[0];
    const m = this.methodFromConfig(cfg);
    let urlExpr: ts.Expression | undefined;
    let methodExpr: ts.Expression | undefined;
    if (cfg && ts.isObjectLiteralExpression(cfg)) {
      urlExpr = this.propExpr(cfg, 'url');
      methodExpr = this.propExpr(cfg, 'method');
    }
    return {
      method: m ?? 'GET',
      verbConfident: m != null,
      urlExpr,
      methodExpr,
      service: inst.name ?? 'axios',
      instanceBaseUrl: inst.baseUrl,
      clientPackage: inst.clientPackage,
    };
  }

  /** SWR key → URL expression: a string/template directly, an array's first
   *  element (`[url, params]`), or a key thunk's body (`() => url`). */
  private swrKeyExpr(key: ts.Expression | undefined): ts.Expression | undefined {
    if (!key) return undefined;
    if (ts.isArrayLiteralExpression(key)) return key.elements[0];
    if ((ts.isArrowFunction(key) || ts.isFunctionExpression(key)) && key.body) {
      if (ts.isBlock(key.body)) {
        for (const st of key.body.statements) if (ts.isReturnStatement(st) && st.expression) return st.expression;
        return undefined;
      }
      return key.body;
    }
    return key;
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
      // Bind the wrapper's `cfg.method` to the caller's `method` property too, so a generic
      // `request({ url, method })` wrapper carries the verb from its call site.
      let method = raw.method;
      let verbConfident = raw.verbConfident;
      const boundMethod = this.bindParamExpr(raw.methodExpr, decl, call);
      if (boundMethod) {
        const mv = this.constEval.evalString(boundMethod);
        if (mv.value && !mv.hasPlaceholder) {
          method = mv.value.toUpperCase();
          verbConfident = true;
        }
      }
      const boundRaw: RawHttp = {
        ...raw,
        urlExpr: bound ?? raw.urlExpr,
        method,
        verbConfident,
        service: calleeName ?? raw.service,
      };
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
    // Visit `body` ITSELF — a concise arrow body (`(id) => client.get(url)`) IS
    // the call expression, so visiting only its children would miss it.
    visit(body);
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

  /**
   * When `urlExpr` is a bare parameter of its enclosing function, infer the URL from
   * that function's call sites: if every call passes the same resolved literal at the
   * param position, bind it. Returns null when the param has zero or conflicting args.
   */
  private bindUrlFromCallSites(urlExpr: ts.Expression | undefined): ts.Expression | null {
    if (!urlExpr || !ts.isIdentifier(urlExpr)) return null;
    const sym = this.checker.getSymbolAtLocation(urlExpr);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl || !ts.isParameter(decl)) return null;
    const fn = decl.parent;
    if (!this.isFunctionLike(fn)) return null;
    const pIdx = fn.parameters.indexOf(decl);
    if (pIdx < 0) return null;
    const fnSym = this.declaredFnSymbol(fn);
    if (!fnSym) return null;

    const distinct = new Map<string, ts.Expression>();
    for (const site of this.callSitesOf(fnSym)) {
      const arg = site.arguments[pIdx];
      if (!arg) continue;
      const ev = this.constEval.evalString(arg);
      if (ev.value != null && !ev.hasPlaceholder) distinct.set(ev.value, arg);
    }
    return distinct.size === 1 ? [...distinct.values()][0] : null;
  }

  private isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    );
  }

  /** The symbol naming a function declaration / `const f = () => …`, for call-site lookup. */
  private declaredFnSymbol(fn: ts.FunctionLikeDeclaration): ts.Symbol | undefined {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return this.checker.getSymbolAtLocation(fn.name);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
      return this.checker.getSymbolAtLocation(fn.parent.name);
    }
    return undefined;
  }

  /** Call sites of a function symbol across the project (index built once). */
  private callSitesOf(fnSym: ts.Symbol): ts.CallExpression[] {
    if (!this.callSiteIndex) {
      this.callSiteIndex = new Map();
      for (const sf of this.sourceFiles) {
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
            const target = ts.isIdentifier(node.expression) ? node.expression : node.expression.name;
            let s = this.checker.getSymbolAtLocation(target);
            if (s && s.flags & ts.SymbolFlags.Alias) {
              try {
                s = this.checker.getAliasedSymbol(s);
              } catch {
                /* not an alias */
              }
            }
            if (s) {
              const arr = this.callSiteIndex!.get(s);
              if (arr) arr.push(node);
              else this.callSiteIndex!.set(s, [node]);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
    return this.callSiteIndex.get(fnSym) ?? [];
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
    // Visit `body` ITSELF — a concise arrow body (`(id) => client.get(url)`) IS
    // the call expression, so visiting only its children would miss it.
    visit(body);
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

  // ---- RTK Query (createApi) ----

  /** Scan every source file for `createApi({...})` and map each endpoint's
   *  generated hook name (useXQuery / useLazyXQuery / useXMutation) to its
   *  resolved endpoint, so a component calling that hook resolves to the API. */
  private buildRtkRegistry(sourceFiles: ts.SourceFile[]): Map<string, ApiResolution> {
    const out = new Map<string, ApiResolution>();
    for (const sf of sourceFiles) {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const c = node.expression;
          // createApi({...}) (with the RTK import) or <api>.injectEndpoints/enhanceEndpoints({...})
          const isCreate = ts.isIdentifier(c) && c.text === 'createApi' && this.isReduxToolkitImport(c);
          const isInject = ts.isPropertyAccessExpression(c) && (c.name.text === 'injectEndpoints' || c.name.text === 'enhanceEndpoints');
          if (isCreate || isInject) this.parseCreateApi(node, out);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return out;
  }

  private parseCreateApi(call: ts.CallExpression, out: Map<string, ApiResolution>): void {
    const cfg = call.arguments[0];
    if (!cfg || !ts.isObjectLiteralExpression(cfg)) return;

    // baseUrl from `baseQuery: fetchBaseQuery({ baseUrl })`
    let baseUrl: EvalString | null = null;
    const bq = this.propExpr(cfg, 'baseQuery');
    if (bq && ts.isCallExpression(bq) && bq.arguments[0] && ts.isObjectLiteralExpression(bq.arguments[0])) {
      const bu = this.propExpr(bq.arguments[0], 'baseUrl');
      if (bu) baseUrl = this.constEval.evalString(bu);
    }

    // endpoints: (builder) => ({ name: builder.query/mutation({ query }) })
    const epFn = this.propExpr(cfg, 'endpoints');
    const epObj = epFn && this.fnReturnExpr(epFn);
    if (!epObj || !ts.isObjectLiteralExpression(epObj)) return;

    for (const p of epObj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = this.propName(p.name);
      if (!name || !ts.isCallExpression(p.initializer)) continue;
      const callee = p.initializer.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      const kind = callee.name.text; // query | mutation | infiniteQuery
      if (kind !== 'query' && kind !== 'mutation' && kind !== 'infiniteQuery') continue;
      const epCfg = p.initializer.arguments[0];
      if (!epCfg || !ts.isObjectLiteralExpression(epCfg)) continue;
      const queryFn = this.propExpr(epCfg, 'query');
      if (!queryFn) continue; // custom queryFn (no static url) — skip
      const ret = this.fnReturnExpr(queryFn);
      if (!ret) continue;

      let urlExpr: ts.Expression | undefined = ret;
      // .query is a GET (definite); .mutation defaults to POST (an assumption
      // unless the config states the method explicitly).
      let method = kind === 'mutation' ? 'POST' : 'GET';
      let verbConfident = kind !== 'mutation';
      if (ts.isObjectLiteralExpression(ret)) {
        // query: (a) => ({ url, method, body })
        urlExpr = this.propExpr(ret, 'url');
        const m = this.methodFromConfig(ret);
        if (m) { method = m; verbConfident = true; }
      }
      const raw: RawHttp = {
        method,
        verbConfident,
        urlExpr,
        service: 'rtk-query',
        instanceBaseUrl: baseUrl,
        clientPackage: null,
      };
      const resolution = this.buildFromRaw(raw, call, ['createApi', name]);
      const Pascal = name.charAt(0).toUpperCase() + name.slice(1);
      if (kind === 'mutation') {
        out.set(`use${Pascal}Mutation`, resolution);
      } else {
        out.set(`use${Pascal}Query`, resolution);
        out.set(`useLazy${Pascal}Query`, resolution);
      }
    }
  }

  /** The expression a function returns: a concise arrow body, or the first
   *  `return` in a block. Unwraps a parenthesized object literal. */
  private fnReturnExpr(fn: ts.Expression): ts.Expression | undefined {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
    let body: ts.Expression | undefined;
    if (ts.isBlock(fn.body)) {
      for (const st of fn.body.statements) {
        if (ts.isReturnStatement(st) && st.expression) { body = st.expression; break; }
      }
    } else {
      body = fn.body; // concise body expression
    }
    while (body && ts.isParenthesizedExpression(body)) body = body.expression;
    return body;
  }

  private isReduxToolkitImport(node: ts.Identifier): boolean {
    const mod = this.importModuleOf(this.checker.getSymbolAtLocation(node));
    return mod != null && mod.startsWith('@reduxjs/toolkit');
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
    if (mod != null && AXIOS_MODULES.has(mod)) return true;
    // dynamic: const axios = (await import('axios')).default
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return this.isDynamicAxiosExpr(decl.initializer);
    return false;
  }

  /** `(await import('axios')).default` / `await import('axios')` → an axios binding. */
  private isDynamicAxiosExpr(e: ts.Expression): boolean {
    let expr = e;
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'default') expr = expr.expression;
    while (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) {
      expr = ts.isParenthesizedExpression(expr) ? expr.expression : expr.expression;
    }
    return (
      ts.isCallExpression(expr) &&
      expr.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !!expr.arguments[0] &&
      ts.isStringLiteralLike(expr.arguments[0]) &&
      AXIOS_MODULES.has(expr.arguments[0].text)
    );
  }

  /** If `node` is a default import of ky/got/superagent, its module name; else null. */
  private httpClientName(node: ts.Expression): string | null {
    if (!ts.isIdentifier(node)) return null;
    const mod = this.importModuleOf(this.checker.getSymbolAtLocation(node));
    return mod != null && HTTP_CLIENT_MODULES.has(mod) ? mod : null;
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
    // an identifier (`const http = axios.create()`) or a member (`this.http`).
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return null;
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
        name:
          (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && ts.isIdentifier(decl.name)
            ? decl.name.text
            : null,
        baseUrl,
        clientPackage: this.relOf(decl),
      };
    }
    this.instanceCache.set(sym, info);
    return info;
  }

  /** The `axios.create(...)` call backing a declaration: a direct initializer
   *  (`const x = axios.create()` / `export default axios.create()`), a factory call
   *  whose body returns one (`const homeAxios = createInstance()`), an identifier
   *  aliasing another instance (`export const homeAxios = baseInstance`), or an
   *  env-gated ternary/logical selection (`isServer ? serverAxios : secAxios`). */
  private axiosCreateInitOf(decl: ts.Node | undefined, depth = 0): ts.CallExpression | null {
    if (!decl || depth > 6) return null;
    let expr: ts.Expression | undefined;
    if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) expr = decl.initializer;
    else if (ts.isExportAssignment(decl)) expr = decl.expression;
    return expr ? this.axiosCreateFromExpr(expr, depth) : null;
  }

  private axiosCreateFromExpr(expr: ts.Expression, depth: number): ts.CallExpression | null {
    if (depth > 6) return null;
    if (ts.isParenthesizedExpression(expr)) return this.axiosCreateFromExpr(expr.expression, depth + 1);
    // Env-gated client selection: `isServer ? serverAxios : secAxios`, `a || b`, `a ?? b`
    // — pick whichever branch resolves to an axios instance.
    if (ts.isConditionalExpression(expr)) {
      return this.axiosCreateFromExpr(expr.whenTrue, depth + 1) ?? this.axiosCreateFromExpr(expr.whenFalse, depth + 1);
    }
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return this.axiosCreateFromExpr(expr.left, depth + 1) ?? this.axiosCreateFromExpr(expr.right, depth + 1);
    }
    if (ts.isCallExpression(expr)) {
      if (this.isAxiosCreateCall(expr)) return expr;
      // Factory: `const homeAxios = createInstance()` — a project-local function that
      // configures and returns `axios.create(...)`. Trace into its body for the call.
      const fn = this.functionDeclOf(expr.expression);
      const body = fn && this.isProjectNode(fn) ? (fn as ts.FunctionLikeDeclaration).body : undefined;
      return body ? this.findAxiosCreate(body) : null;
    }
    // Alias: `export const homeAxios = baseInstance` (incl. a cross-module default import,
    // whose own default export may be another ternary) → follow to the backing decl.
    if (ts.isIdentifier(expr)) {
      let sym = this.checker.getSymbolAtLocation(expr);
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = this.checker.getAliasedSymbol(sym);
        } catch {
          /* not an alias */
        }
      }
      const target = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (target) return this.axiosCreateInitOf(target, depth + 1);
    }
    return null;
  }

  private isAxiosCreateCall(call: ts.CallExpression): boolean {
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'create' &&
      this.isAxiosImport(call.expression.expression)
    );
  }

  /** First `axios.create(...)` call inside a function body (depth-first). */
  private findAxiosCreate(body: ts.Node): ts.CallExpression | null {
    let found: ts.CallExpression | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node) && this.isAxiosCreateCall(node)) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
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
