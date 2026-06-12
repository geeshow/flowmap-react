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

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return this.evalAccess(node, depth);
    }

    if (ts.isIdentifier(node)) return this.evalIdentifier(node, depth);

    return NONE;
  }

  /** For URL-building wrappers: try the expr, else descend into children (mirror resolveUrlBuildingCall). */
  resolveUrlBuildingCall(node: ts.Expression | undefined, depth = 0): EvalString {
    if (!node || depth > 16) return NONE;
    const direct = this.evalString(node, depth);
    if (direct.value != null) return direct;
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
    const init = this.initializerOfSymbol(sym);
    if (init) return this.evalString(init, depth + 1);
    return NONE;
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
