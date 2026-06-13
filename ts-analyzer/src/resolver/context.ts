/**
 * Shared symbol/id/module-resolution helpers used by the render, route, and
 * store passes. Centralizes the "<file>::<Name>" component-id convention and the
 * module resolution that lazy routes / dynamic imports rely on, so every pass
 * produces consistent, joinable ids.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { isComponentName } from '../classify';
import { realFileName } from './program';

export interface ResolvedComponent {
  id: string | null;
  lazy: boolean;
}

export class AnalysisContext {
  readonly projectFiles: Set<string>;
  private readonly sfByResolved = new Map<string, ts.SourceFile>();

  constructor(
    readonly checker: ts.TypeChecker,
    readonly repoRoot: string,
    readonly options: ts.CompilerOptions,
    sourceFiles: ts.SourceFile[],
  ) {
    this.projectFiles = new Set(sourceFiles.map((sf) => path.resolve(sf.fileName)));
    for (const sf of sourceFiles) this.sfByResolved.set(path.resolve(sf.fileName), sf);
  }

  repoRel(file: string): string {
    return path.relative(this.repoRoot, realFileName(file)).split(path.sep).join('/');
  }

  isProjectNode(node: ts.Node): boolean {
    return this.projectFiles.has(path.resolve(node.getSourceFile().fileName));
  }

  /** "<repo-relative-file>::<Name>" for a declaration, or null. */
  idOfDecl(decl: ts.Node, fallbackName?: string): string | null {
    const name = this.nameOfDecl(decl) ?? fallbackName;
    if (!name) return null;
    return `${this.repoRel(decl.getSourceFile().fileName)}::${name}`;
  }

  nameOfDecl(decl: ts.Node): string | null {
    if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return decl.name?.text ?? null;
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
    if (ts.isMethodDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
    // export default function/class without name → "default"
    return null;
  }

  /** Module specifier an identifier was imported from (e.g. 'zustand'), or null. */
  importModuleOf(node: ts.Node): string | null {
    const sym = this.checker.getSymbolAtLocation(node);
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

  symbolAt(node: ts.Node): ts.Symbol | undefined {
    let sym = this.checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        /* not actually an alias */
      }
    }
    return sym;
  }

  /** Resolve a reference (JSX tag, element prop) to a component id, following lazy(import()). */
  resolveComponentRef(ref: ts.Expression): ResolvedComponent {
    const sym = this.symbolAt(ref);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl) return { id: null, lazy: false };

    // const X = lazy(() => import('./X'))  /  React.lazy(...)
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const lazyId = this.resolveLazyInitializer(decl.initializer, decl);
      if (lazyId) return { id: lazyId, lazy: true };
    }
    const id = this.idOfDecl(decl);
    return { id, lazy: false };
  }

  private resolveLazyInitializer(init: ts.Expression, decl: ts.VariableDeclaration): string | null {
    if (!ts.isCallExpression(init)) return null;
    const callee = init.expression;
    const isLazy =
      (ts.isIdentifier(callee) && callee.text === 'lazy') ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'lazy');
    if (!isLazy) return null;
    const arg = init.arguments[0];
    if (!arg || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return null;
    const spec = this.dynamicImportSpec(arg);
    if (!spec) return null;
    const target = this.resolveModuleFile(spec, decl.getSourceFile().fileName);
    if (!target) return null;
    const defName = this.defaultExportComponentName(target);
    if (!defName) return null;
    return `${this.repoRel(target.fileName)}::${defName}`;
  }

  /** Extract the string spec from `() => import('spec')` (arrow body or block return). */
  private dynamicImportSpec(fn: ts.ArrowFunction | ts.FunctionExpression): string | null {
    let result: string | null = null;
    const visit = (node: ts.Node) => {
      if (result) return;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        result = (node.arguments[0] as ts.StringLiteralLike).text;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    return result;
  }

  resolveModuleFile(spec: string, fromFile: string): ts.SourceFile | undefined {
    const res = ts.resolveModuleName(spec, fromFile, this.options, ts.sys);
    const resolved = res.resolvedModule?.resolvedFileName;
    if (!resolved) return undefined;
    return this.sfByResolved.get(path.resolve(resolved));
  }

  /** Name of the default-exported component in a module (best effort). */
  defaultExportComponentName(sf: ts.SourceFile): string | null {
    let name: string | null = null;
    for (const stmt of sf.statements) {
      // export default function Foo() {}
      if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        return stmt.name?.text ?? 'default';
      }
      // export default Foo
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (ts.isIdentifier(stmt.expression)) {
          const sym = this.symbolAt(stmt.expression);
          const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
          if (d) return this.nameOfDecl(d) ?? stmt.expression.text;
          return stmt.expression.text;
        }
        return 'default';
      }
    }
    // fallback: first exported PascalCase declaration
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && isComponentName(stmt.name.text)) {
        name = stmt.name.text;
        break;
      }
    }
    return name;
  }
}
