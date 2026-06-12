/**
 * JSX → LayoutNode tree extraction. Produces a STRUCTURAL wireframe of a screen:
 * the nesting of host elements (div/button/…) and child components, with static
 * text and a whitelist of layout-relevant props. Dynamic rendering is represented
 * symbolically: `{cond ? a : b}` → conditional, `list.map(...)` → list (with the
 * item template), other `{expr}` → expression placeholder.
 *
 * This is a static approximation — precise pixel layout needs CSS + runtime and
 * is intentionally out of scope. Child components are linked by `componentId` so
 * a viewer can drill down into their own trees instead of inlining (avoids cycles
 * and duplication).
 */

import * as ts from 'typescript';
import { isComponentName } from '../classify';
import { AnalysisContext } from './context';

export type LayoutKind = 'host' | 'component' | 'text' | 'fragment' | 'list' | 'conditional' | 'expression';

export interface LayoutNode {
  tag: string; // "div" | "UserCard" | "#text" | "#fragment" | "#list" | "#cond" | "#expr"
  kind: LayoutKind;
  componentId?: string | null; // for components — look up in the screens doc
  lazy?: boolean;
  text?: string; // static text / expression label
  props?: Record<string, string>; // whitelisted, string-literal props only
  children?: LayoutNode[];
  line?: number;
}

const PROP_WHITELIST = new Set([
  'classname', 'id', 'type', 'name', 'placeholder', 'href', 'src', 'role', 'alt', 'label', 'title', 'htmlfor', 'aria-label',
]);

/** Find the JSX a component returns (arrow expression body, or return statements). */
export function findRootJsx(bodyOwner: ts.Node): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | null {
  // arrow with a JSX expression body: () => <X/> or () => (<X/>)
  if (ts.isArrowFunction(bodyOwner)) {
    const b = ts.isParenthesizedExpression(bodyOwner.body) ? bodyOwner.body.expression : bodyOwner.body;
    if (isJsx(b)) return b;
  }
  // block body / function / class: collect JSX-returning return statements
  const roots: (ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment)[] = [];
  const visit = (node: ts.Node) => {
    // don't descend into nested function/component bodies — their JSX isn't this screen's root
    if (node !== bodyOwner && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const e = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
      if (isJsx(e)) roots.push(e);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(bodyOwner, visit);
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) return null;
  // multiple returns (conditional rendering) — synthesize nothing here; caller gets the first,
  // but we wrap them as a conditional fragment for fidelity.
  return roots[0];
}

export function buildLayout(node: ts.Node, ctx: AnalysisContext, sf: ts.SourceFile, depth = 0): LayoutNode | null {
  if (depth > 40) return null;

  if (ts.isJsxElement(node)) {
    return elementNode(node.openingElement, node.children, ctx, sf, depth);
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return elementNode(node, undefined, ctx, sf, depth);
  }
  if (ts.isJsxFragment(node)) {
    return { tag: '#fragment', kind: 'fragment', children: childList(node.children, ctx, sf, depth), line: lineOf(sf, node) };
  }
  if (ts.isJsxText(node)) {
    const t = node.text.trim();
    return t ? { tag: '#text', kind: 'text', text: collapse(t), line: lineOf(sf, node) } : null;
  }
  if (ts.isJsxExpression(node)) {
    return node.expression ? expressionNode(node.expression, ctx, sf, depth) : null;
  }
  return null;
}

// ---- element / children ----

function elementNode(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  children: ts.NodeArray<ts.JsxChild> | undefined,
  ctx: AnalysisContext,
  sf: ts.SourceFile,
  depth: number,
): LayoutNode {
  const tag = opening.tagName.getText(sf);
  const simple = tag.split('.')[0];
  const isComp = isComponentName(simple);
  const node: LayoutNode = {
    tag,
    kind: isComp ? 'component' : 'host',
    line: lineOf(sf, opening),
  };
  const props = extractProps(opening.attributes, sf);
  if (Object.keys(props).length) node.props = props;
  if (isComp) {
    const resolved = ctx.resolveComponentRef(opening.tagName as ts.Expression);
    node.componentId = resolved.id;
    if (resolved.lazy) node.lazy = true;
  }
  if (children) {
    const kids = childList(children, ctx, sf, depth);
    if (kids.length) node.children = kids;
  }
  return node;
}

function childList(children: ts.NodeArray<ts.JsxChild>, ctx: AnalysisContext, sf: ts.SourceFile, depth: number): LayoutNode[] {
  const out: LayoutNode[] = [];
  for (const c of children) {
    const n = buildLayout(c, ctx, sf, depth + 1);
    if (n) out.push(n);
  }
  return out;
}

// ---- {expression} children ----

function expressionNode(expr: ts.Expression, ctx: AnalysisContext, sf: ts.SourceFile, depth: number): LayoutNode | null {
  // {cond ? <A/> : <B/>}
  if (ts.isConditionalExpression(expr)) {
    const branches = [expr.whenTrue, expr.whenFalse]
      .map((b) => jsxBranch(b, ctx, sf, depth))
      .filter((b): b is LayoutNode => b != null);
    return { tag: '#cond', kind: 'conditional', text: snippet(expr.condition, sf), children: branches, line: lineOf(sf, expr) };
  }
  // {cond && <A/>}
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const branch = jsxBranch(expr.right, ctx, sf, depth);
    return { tag: '#cond', kind: 'conditional', text: snippet(expr.left, sf), children: branch ? [branch] : [], line: lineOf(sf, expr) };
  }
  // {items.map(item => <Row/>)}
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'map') {
    const cb = expr.arguments[expr.arguments.length - 1];
    let template: LayoutNode | null = null;
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
      const body = ts.isParenthesizedExpression(cb.body as ts.Node)
        ? (cb.body as ts.ParenthesizedExpression).expression
        : (cb.body as ts.Node);
      template = isJsx(body) ? buildLayout(body, ctx, sf, depth + 1) : (findRootJsx(cb) ? buildLayout(findRootJsx(cb)!, ctx, sf, depth + 1) : null);
    }
    return {
      tag: '#list',
      kind: 'list',
      text: snippet(expr.expression.expression, sf) + '.map',
      children: template ? [template] : [],
      line: lineOf(sf, expr),
    };
  }
  // direct JSX inside braces
  if (isJsx(expr)) return buildLayout(expr, ctx, sf, depth);
  // string / number literal → text
  if (ts.isStringLiteralLike(expr)) {
    const t = expr.text.trim();
    return t ? { tag: '#text', kind: 'text', text: collapse(t), line: lineOf(sf, expr) } : null;
  }
  if (ts.isNumericLiteral(expr)) return { tag: '#text', kind: 'text', text: expr.text, line: lineOf(sf, expr) };
  // other dynamic value → expression placeholder
  return { tag: '#expr', kind: 'expression', text: snippet(expr, sf), line: lineOf(sf, expr) };
}

function jsxBranch(expr: ts.Expression, ctx: AnalysisContext, sf: ts.SourceFile, depth: number): LayoutNode | null {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (isJsx(e)) return buildLayout(e, ctx, sf, depth + 1);
  return null; // `null` / falsy branch → omit
}

// ---- props ----

function extractProps(attrs: ts.JsxAttributes, sf: ts.SourceFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = a.name.getText(sf);
    if (!PROP_WHITELIST.has(name.toLowerCase())) continue;
    if (a.initializer && ts.isStringLiteral(a.initializer)) {
      out[name] = a.initializer.text;
    } else if (a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression) {
      out[name] = '{' + snippet(a.initializer.expression, sf) + '}';
    }
  }
  return out;
}

// ---- utils ----

function isJsx(node: ts.Node | undefined): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
  return !!node && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node));
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function snippet(node: ts.Node, sf: ts.SourceFile): string {
  return collapse(node.getText(sf)).slice(0, 60);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
