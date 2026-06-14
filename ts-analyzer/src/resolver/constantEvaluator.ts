/**
 * Compile-time string resolution via the TypeScript TypeChecker — the analog of
 * the backend's ConstantEvaluator.kt (which uses K1's BindingContext).
 *
 * The semantic win over regex: it follows `const` references (across files),
 * folds string concatenation and template literals, and resolves
 * `import.meta.env.X` / `process.env.X` to their literal value (or keeps the
 * `${X}` placeholder when unknown). Path-param spans (`/users/${id}`) collapse
 * to `{}` so the result matches a backend controller endpoint.
 */

import * as ts from 'typescript';
import { EnvResolver } from './envResolver';

export interface EvalString {
  /** Assembled string. May contain "{}" (path params) and "${X}" (unknown env). null = unresolved. */
  value: string | null;
  /** True if an unresolved "${...}" placeholder remains in `value`. */
  hasPlaceholder: boolean;
}

const NONE: EvalString = { value: null, hasPlaceholder: false };

export class ConstantEvaluator {
  constructor(private readonly checker: ts.TypeChecker, private readonly env: EnvResolver) {}

  /** Resolve an expression to a (possibly partial) string. */
  evalString(node: ts.Expression | undefined, depth = 0): EvalString {
    if (!node || depth > 16) return NONE;

    // 1) checker literal type — folds plain literals & const references (incl. cross-file).
    const lit = this.literalFromType(node);
    if (lit != null) return this.classify(lit);

    // 2) structural folding
    if (ts.isStringLiteralLike(node)) return this.classify(node.text);

    if (ts.isParenthesizedExpression(node)) return this.evalString(node.expression, depth + 1);

    if (ts.isTemplateExpression(node)) return this.evalTemplate(node, depth);

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.evalString(node.left, depth + 1);
      const r = this.evalString(node.right, depth + 1);
      if (l.value == null && r.value == null) return NONE;
      return {
        value: (l.value ?? '') + (r.value ?? ''),
        hasPlaceholder: l.hasPlaceholder || r.hasPlaceholder,
      };
    }

    // `a || b` / `a ?? b` — env fallback chains, e.g.
    //   const API_GW = import.meta.env.VITE_APP_API_GW || process.env.NEXT_PUBLIC_API_GW || 'https://localhost'
    // Take the left when it resolves (for `||`, also require non-empty), else the right.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const nullish = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
      const l = this.evalString(node.left, depth + 1);
      if (l.value != null && (nullish || l.value !== '')) return l;
      return this.evalString(node.right, depth + 1);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return this.evalAccess(node, depth);
    }

    if (ts.isIdentifier(node)) return this.evalIdentifier(node, depth);

    // Call to a const/path-builder function, e.g. `ORDER_PATHS.DETAIL(id)` or `gwOrderDetail(id)`
    // where the callee is `(id) => `/v1/orders/${id}``. Evaluate the function's returned string;
    // its parameters are runtime values → fold to "{}" (matches a backend path param).
    if (ts.isCallExpression(node)) return this.evalCall(node, depth);

    return NONE;
  }

  /** Evaluate a call to a project-local string-returning function (path-builder const). */
  private evalCall(node: ts.CallExpression, depth: number): EvalString {
    const ret = this.returnExprOf(node.expression);
    if (!ret) return NONE;
    return this.evalString(ret, depth + 1);
  }

  /** The single returned expression of the function backing a callee, or null. */
  private returnExprOf(callee: ts.Expression): ts.Expression | null {
    const fn = this.functionOfExpr(callee);
    if (!fn) return null;
    const body = fn.body;
    if (!body) return null;
    // arrow with an expression body: `(id) => `...``
    if (!ts.isBlock(body)) return body as ts.Expression;
    // block body: first `return <expr>;`
    let found: ts.Expression | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isReturnStatement(n) && n.expression) {
        found = n.expression;
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    return found;
  }

  /** Resolve a callee expression to its arrow/function declaration (following consts/members). */
  private functionOfExpr(callee: ts.Expression): ts.FunctionLikeDeclaration | null {
    const sym = this.symbolAt(callee);
    let init = this.initializerOfSymbol(sym);
    if (init && ts.isIdentifier(init)) init = this.initializerOf(init) ?? init;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl))) return decl;
    return null;
  }

  /** For URL-building wrappers: try the expr, else descend into children (mirror resolveUrlBuildingCall). */
  resolveUrlBuildingCall(node: ts.Expression | undefined, depth = 0): EvalString {
    if (!node || depth > 16) return NONE;
    const direct = this.evalString(node, depth);
    if (direct.value != null) return direct;

    // `const url = stringifyUrl({...})` / `const url = build(...)` → follow the local
    // const to its initializer and dig the URL out of the builder call.
    if (ts.isIdentifier(node)) {
      const init = this.initializerOf(node);
      return init ? this.resolveUrlBuildingCall(init, depth + 1) : NONE;
    }

    // stringifyUrl({ url, query }) / fetch-config { url } → prefer a url-like property
    // (object-literal properties are not Expressions, so forEachChild would skip them).
    if (ts.isObjectLiteralExpression(node)) {
      for (const key of ['url', 'path', 'endpoint', 'uri']) {
        const e = this.propInit(node, key);
        if (e) {
          const r = this.resolveUrlBuildingCall(e, depth + 1);
          if (r.value != null) return r;
        }
      }
    }

    let result: EvalString = NONE;
    node.forEachChild((child) => {
      if (result.value != null) return;
      if (ts.isExpression(child as ts.Expression)) {
        const r = this.resolveUrlBuildingCall(child as ts.Expression, depth + 1);
        if (r.value != null) result = r;
      }
    });
    return result;
  }

  // ---- internals ----

  private classify(s: string): EvalString {
    return { value: s, hasPlaceholder: s.includes('${') };
  }

  private literalFromType(node: ts.Expression): string | null {
    try {
      const t = this.checker.getTypeAtLocation(node);
      if (t.isStringLiteral()) return t.value;
    } catch {
      /* checker can throw on synthetic nodes */
    }
    return null;
  }

  private evalTemplate(node: ts.TemplateExpression, depth: number): EvalString {
    let out = node.head.text;
    let hasPlaceholder = false;
    for (const span of node.templateSpans) {
      const r = this.evalString(span.expression, depth + 1);
      if (r.value != null) {
        out += r.value;
        hasPlaceholder = hasPlaceholder || r.hasPlaceholder;
      } else {
        // unresolved span = runtime path parameter → "{}"
        out += '{}';
      }
      out += span.literal.text;
    }
    return { value: out, hasPlaceholder };
  }

  private evalAccess(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): EvalString {
    // import.meta.env.X  /  process.env.X
    const envName = this.envVarName(node);
    if (envName != null) {
      const v = this.env.lookup(envName);
      if (v != null) return this.classify(v);
      return { value: '${' + envName + '}', hasPlaceholder: true };
    }
    // config.member → resolve the property's initializer
    if (ts.isPropertyAccessExpression(node)) {
      const sym = this.symbolAt(node);
      const init = this.initializerOfSymbol(sym);
      if (init) return this.evalString(init, depth + 1);
    }
    return NONE;
  }

  private evalIdentifier(node: ts.Identifier, depth: number): EvalString {
    const sym = this.symbolAt(node);
    if (!sym) return NONE;
    // a function parameter is a runtime value, not a constant
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (decl && ts.isParameter(decl)) return NONE;
    // destructured local: `const { url } = source` → resolve `source.url`.
    if (decl && ts.isBindingElement(decl)) {
      const r = this.resolveBindingElement(decl, depth);
      if (r.value != null) return r;
    }
    const init = this.initializerOfSymbol(sym);
    if (init) return this.evalString(init, depth + 1);
    return NONE;
  }

  /** `const { url } = source` / `const { url: u } = source` → evaluate the source's property. */
  private resolveBindingElement(be: ts.BindingElement, depth: number): EvalString {
    const key = be.propertyName ? this.propName(be.propertyName) : ts.isIdentifier(be.name) ? be.name.text : null;
    if (!key) return NONE;
    const pattern = be.parent;
    if (!ts.isObjectBindingPattern(pattern)) return NONE;
    // Only local destructures are constant; a destructured parameter is a runtime value.
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner) && owner.initializer) {
      return this.evalPropertyOf(owner.initializer, key, depth);
    }
    return NONE;
  }

  /** Resolve `<obj>.<key>` where obj is an object literal (following a const identifier first). */
  private evalPropertyOf(objExpr: ts.Expression, key: string, depth: number): EvalString {
    let obj: ts.Expression | undefined = objExpr;
    if (ts.isIdentifier(obj)) obj = this.initializerOf(obj) ?? obj;
    if (obj && ts.isObjectLiteralExpression(obj)) {
      const e = this.propInit(obj, key);
      if (e) return this.evalString(e, depth + 1);
    }
    return NONE;
  }

  private initializerOf(node: ts.Expression): ts.Expression | undefined {
    return this.initializerOfSymbol(this.symbolAt(node));
  }

  private propName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  }

  private propInit(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && this.propName(p.name) === key) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
    }
    return undefined;
  }

  /** Returns the env var name for import.meta.env.X / process.env.X, else null. */
  private envVarName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    if (!name) return null;
    const owner = node.expression;
    // owner must be `import.meta.env` or `process.env`
    if (ts.isPropertyAccessExpression(owner)) {
      if (owner.name.text === 'env') {
        const base = owner.expression;
        // import.meta.env
        if (ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword) return name;
        // process.env
        if (ts.isIdentifier(base) && base.text === 'process') return name;
      }
    }
    return null;
  }

  private symbolAt(node: ts.Node): ts.Symbol | undefined {
    // `{ url }` shorthand: getSymbolAtLocation yields the property symbol, not the local
    // value it references. Resolve to the value symbol so `const url = ...; f({ url })` folds.
    if (ts.isIdentifier(node) && node.parent && ts.isShorthandPropertyAssignment(node.parent)) {
      const valSym = this.checker.getShorthandAssignmentValueSymbol(node.parent);
      if (valSym) return valSym;
    }
    let sym = this.checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        /* not an alias after all */
      }
    }
    return sym;
  }

  private initializerOfSymbol(sym: ts.Symbol | undefined): ts.Expression | undefined {
    if (!sym) return undefined;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
    if (decl && ts.isPropertyAssignment(decl)) return decl.initializer;
    if (decl && ts.isBindingElement(decl) && decl.initializer) return decl.initializer;
    return undefined;
  }
}
