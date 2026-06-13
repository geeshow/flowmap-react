/**
 * Walks a function body (component method / lifecycle / asyncData / Vuex action)
 * collecting IrCall resolutions: HTTP calls (via VueApiCallResolver, incl. wrapper
 * tracing into apis/*.js) and `dispatch('ns/action')` store dispatches. Vuex
 * getters/state reads are captured from `mapGetters/mapState` at the declaration
 * site (see optionsApi/vuexResolver), not here.
 */

import * as ts from 'typescript';
import type { IrCall } from '../../ir';
import { ConstantEvaluator } from '../constantEvaluator';
import { VueApiCallResolver } from './vueApiCallResolver';

/** `store:vuex:<ns>#<action>` (ns '' → 'root'). */
export function vuexActionId(ns: string, action: string): string {
  return `store:vuex:${ns || 'root'}#${action}`;
}

/** `store:vuex:<ns>` module id. */
export function vuexModuleId(ns: string): string {
  return `store:vuex:${ns || 'root'}`;
}

/** Resolve a dispatch string ('mortgage/code/foo' or 'foo') to an action node id. */
export function parseDispatchTarget(spec: string, currentNs: string): string {
  const slash = spec.lastIndexOf('/');
  if (slash >= 0) return vuexActionId(spec.slice(0, slash), spec.slice(slash + 1));
  return vuexActionId(currentNs, spec);
}

export class VueBodyWalker {
  constructor(
    private readonly api: VueApiCallResolver,
    private readonly constEval: ConstantEvaluator,
  ) {}

  /** Collect calls from a function-like body. `currentNs` scopes bare dispatches. */
  collect(bodyOwner: ts.Node, currentNs: string, baseAsync: boolean): IrCall[] {
    const calls: IrCall[] = [];
    const sf = bodyOwner.getSourceFile();
    let asyncDepth = baseAsync ? 1 : 0;

    const visit = (node: ts.Node) => {
      let entered = false;
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && isAsync(node)) {
        asyncDepth++;
        entered = true;
      }
      if (ts.isCallExpression(node)) {
        const c = this.resolveCall(node, currentNs, asyncDepth > 0, sf);
        if (c) calls.push(c);
      }
      ts.forEachChild(node, visit);
      if (entered) asyncDepth--;
    };
    const body = bodyOf(bodyOwner);
    if (body) ts.forEachChild(body, visit);
    return calls;
  }

  private resolveCall(node: ts.CallExpression, currentNs: string, inAsyncCtx: boolean, sf: ts.SourceFile): IrCall | null {
    const line = lineOf(sf, node);

    // 1) HTTP (this.$axios / $nuxt.$axios / axios / wrapper fns)
    const apiRes = this.api.resolve(node);
    if (apiRes) return { line, inAsyncCtx, resolution: apiRes };

    // 2) dispatch('ns/action', ...) — `store.dispatch(...)`/`this.$store.dispatch(...)`
    //    or destructured `dispatch(...)` inside a Vuex action.
    const callee = node.expression;
    const isDispatch =
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatch') ||
      (ts.isIdentifier(callee) && callee.text === 'dispatch');
    if (isDispatch) {
      const arg = node.arguments[0];
      const spec = arg ? this.constEval.evalString(arg).value : null;
      if (spec && !spec.includes('${')) {
        return {
          line,
          inAsyncCtx,
          resolution: { kind: 'storeDispatch', storeId: parseDispatchTarget(spec, currentNs), action: spec.split('/').pop() ?? spec },
        };
      }
    }
    return null;
  }
}

function bodyOf(owner: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner) || ts.isMethodDeclaration(owner)) {
    return owner.body;
  }
  return owner; // already a body/block
}

function isAsync(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
