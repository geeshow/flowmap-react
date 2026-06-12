/**
 * Screen-layout extraction: a data JSON for drawing a simple STRUCTURAL wireframe
 * of each screen in an impact-analysis web UI. Per component we emit its JSX
 * layout tree (host elements + child components + static text); screens reference
 * their component by id and carry the route path. Child components are linked by
 * id so a viewer can drill down (expand a box into its own tree).
 *
 * Reuses the same Program/TypeChecker, route discovery and component-id rules as
 * the graph analyzer, so ids line up with the graph/join output.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { isComponentName, isHookName } from './classify';
import { AnalysisContext } from './resolver/context';
import { buildProjectProgram, discoverProjects, isNextProject, provenance, repoRel } from './resolver/program';
import { buildLayout, findRootJsx, LayoutNode } from './resolver/layoutTree';
import { findNextRoutes, findReactRouterRoutes } from './resolver/routeResolver';
import { normalize } from './norm';

export interface ScreenComponent {
  id: string;
  name: string;
  kind: 'component' | 'screen';
  file: string;
  line: number | null;
  project: string | null;
  root: LayoutNode | null; // the JSX layout tree
}

export interface ScreenEntry {
  id: string; // === componentId
  name: string;
  route: string | null; // normalized route path
  file: string;
}

export interface ScreensDoc {
  meta: {
    command: 'screens';
    repo: string;
    project: string | null;
    screens: number;
    components: number;
  };
  screens: ScreenEntry[];
  components: Record<string, ScreenComponent>;
}

interface Found {
  id: string;
  name: string;
  bodyOwner: ts.Node;
  decl: ts.Node;
  sf: ts.SourceFile;
  line: number;
  project: string | null;
}

export function buildScreens(opts: { repoRoot: string; projectFilter?: string | null }): ScreensDoc {
  const repoRoot = path.resolve(opts.repoRoot);
  const projects = discoverProjects(repoRoot, opts.projectFilter);

  const components: Record<string, ScreenComponent> = {};
  const screenRoute = new Map<string, string | null>(); // componentId -> route path

  for (const projectRoot of projects) {
    const pp = buildProjectProgram(projectRoot, { repoRoot });
    const ctx = new AnalysisContext(pp.checker, repoRoot, pp.program.getCompilerOptions(), pp.sourceFiles);

    // routes → which component ids are screens, and their path
    const nextProject = isNextProject(projectRoot);
    for (const sf of pp.sourceFiles) {
      const routes = [...findReactRouterRoutes(sf, ctx), ...(nextProject ? findNextRoutes(sf, ctx, projectRoot) : [])];
      for (const r of routes) {
        if (!r.screenComponentId) continue;
        const p = r.routePath != null ? normalize(r.routePath.replace(/:[^/]+/g, '{}')) : '/';
        if (!screenRoute.has(r.screenComponentId)) screenRoute.set(r.screenComponentId, p);
      }
    }

    // components → layout trees
    for (const sf of pp.sourceFiles) {
      for (const f of findComponents(sf, ctx, repoRoot)) {
        const root = findRootJsx(f.bodyOwner);
        components[f.id] = {
          id: f.id,
          name: f.name,
          kind: 'component', // upgraded to 'screen' below if routed
          file: repoRel(repoRoot, f.sf.fileName),
          line: f.line,
          project: f.project,
          root: root ? buildLayout(root, ctx, sf) : null,
        };
      }
    }
  }

  // mark screens
  const screens: ScreenEntry[] = [];
  for (const [id, route] of screenRoute) {
    const c = components[id];
    if (!c) continue;
    c.kind = 'screen';
    screens.push({ id, name: c.name, route, file: c.file });
  }
  screens.sort((a, b) => (a.route ?? '').localeCompare(b.route ?? ''));

  return {
    meta: {
      command: 'screens',
      repo: opts.repoRoot,
      project: opts.projectFilter ?? null,
      screens: screens.length,
      components: Object.keys(components).length,
    },
    screens,
    components,
  };
}

/** Lightweight component/hook discovery (PascalCase / default export / arrow / class). */
function findComponents(sf: ts.SourceFile, ctx: AnalysisContext, repoRoot: string): Found[] {
  const out: Found[] = [];
  const { project } = provenance(repoRel(repoRoot, sf.fileName));
  const push = (name: string, decl: ts.Node, bodyOwner: ts.Node) => {
    if (!isComponentName(name) && !isHookName(name)) return; // only components/hooks render
    out.push({ id: `${ctx.repoRel(sf.fileName)}::${name}`, name, decl, bodyOwner, sf, line: lineOf(sf, decl), project });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      if (stmt.name) push(stmt.name.text, stmt, stmt);
      else if (hasMod(stmt, ts.SyntaxKind.DefaultKeyword)) push('default', stmt, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          push(d.name.text, d, d.initializer);
        }
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      push(stmt.name.text, stmt, stmt);
    }
  }
  return out;
}

function hasMod(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
