/**
 * Vue/Nuxt HTTP call resolution. Extends the React ApiCallResolver, reusing all
 * of its URL folding, baseURL composition and cross-function WRAPPER TRACING; it
 * only adds recognition of Nuxt's injected `$axios` client, which has no import
 * to key on (it is provided by @nuxtjs/axios at runtime).
 *
 * Recognized receivers (structural — chain ending in `$axios`):
 *   this.$axios.get(path)        window.$nuxt.$axios.post(path, body)
 *   app.$axios.$get(path)        const { $axios } = ctx; $axios.get(path)
 *   this.$axios(path)            (callable instance → GET)
 * Shortcut methods ($get/$post/...) are normalized by stripping the leading `$`.
 *
 * baseURL comes from nuxt.config (`['@nuxtjs/axios',{baseURL}]`) and is injected;
 * since the join key is the PATH, endpoints resolve even if the base stays a
 * placeholder. Imported `axios` and `fetch` still resolve via the base class.
 */

import * as ts from 'typescript';
import { AXIOS_REQUEST_METHODS, AXIOS_VERB_METHODS } from '../../classify';
import { ApiCallResolver, InstanceInfo, RawHttp } from '../apiCallResolver';
import { ConstantEvaluator, EvalString } from '../constantEvaluator';

export class VueApiCallResolver extends ApiCallResolver {
  constructor(
    checker: ts.TypeChecker,
    constEval: ConstantEvaluator,
    repoRoot: string,
    sourceFiles: ts.SourceFile[],
    private readonly baseUrl: EvalString | null,
  ) {
    super(checker, constEval, repoRoot, sourceFiles);
  }

  protected classifyHttpCall(call: ts.CallExpression): RawHttp | null {
    // imported axios / fetch handled by the base class
    const base = super.classifyHttpCall(call);
    if (base) return base;

    const callee = call.expression;

    // recv.$axios.method(...)  /  recv.$axios.$method(...)
    if (ts.isPropertyAccessExpression(callee) && this.isAxiosReceiver(callee.expression)) {
      return this.rawFromMethod(call, callee.name.text);
    }

    // callable instance: this.$axios(path | config)
    if (this.isAxiosReceiver(callee)) {
      return this.rawCallable(call);
    }

    return null;
  }

  /** A receiver expression that denotes the injected $axios client. */
  private isAxiosReceiver(node: ts.Expression): boolean {
    if (ts.isIdentifier(node)) return node.text === '$axios';
    if (ts.isPropertyAccessExpression(node)) return node.name.text === '$axios';
    return false;
  }

  private rawFromMethod(call: ts.CallExpression, method: string): RawHttp | null {
    const verb = method.startsWith('$') ? method.slice(1) : method; // $get → get
    if (AXIOS_VERB_METHODS.has(verb)) {
      return {
        method: verb.toUpperCase(),
        verbConfident: true,
        urlExpr: call.arguments[0],
        service: '$axios',
        instanceBaseUrl: this.baseUrl,
        clientPackage: null,
      };
    }
    if (AXIOS_REQUEST_METHODS.has(verb)) {
      return this.configForm(call, this.vueInstance());
    }
    return null;
  }

  private rawCallable(call: ts.CallExpression): RawHttp {
    const arg = call.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      return this.configForm(call, this.vueInstance());
    }
    // this.$axios(path) defaults to GET
    return {
      method: 'GET',
      verbConfident: true,
      urlExpr: arg,
      service: '$axios',
      instanceBaseUrl: this.baseUrl,
      clientPackage: null,
    };
  }

  private vueInstance(): InstanceInfo {
    return { name: '$axios', baseUrl: this.baseUrl, clientPackage: null };
  }
}
