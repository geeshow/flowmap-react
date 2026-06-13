/**
 * VueResolver — the Vue/Nuxt implementation of the Resolver interface. Emits the
 * same IrFile[] the pure GraphBuilder consumes, so React and Vue share all
 * downstream tooling. Phase 1 scope: screens (Nuxt routes), external API calls
 * (this.$axios / $nuxt.$axios / axios / wrapper fns), and Vuex (modules + actions
 * as nodes) — i.e. the impact chain page → dispatch → action → http → API.
 * Component render graph + Pug layout are Phase 2 (jsxUsages left empty here).
 */

import * as path from 'path';
import * as ts from 'typescript';
import type { IrCall, IrComponent, IrFile, IrRoute, IrStore, Resolver, ResolveOptions } from '../../ir';
import { ConstantEvaluator } from '../constantEvaluator';
import { AnalysisContext } from '../context';
import { discoverVueProjects, provenance } from '../program';
import { loadNuxtEnv, readAxiosBaseUrl } from './nuxtEnvResolver';
import { VueApiCallResolver } from './vueApiCallResolver';
import { VueBodyWalker, vuexModuleId } from './vueBodyWalker';
import { buildVueProgram } from './vueProgram';
import { isUnderPages, nuxtRoutePath, pagesDirOf } from './vueRouteResolver';
import { resolveVuexFile } from './vuexResolver';

const LIFECYCLE = new Set([
  'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
  'beforeDestroy', 'destroyed', 'activated', 'deactivated', 'asyncData', 'fetch',
]);
const METHOD_CONTAINERS = new Set(['methods', 'computed', 'watch']);
const MAP_HELPERS = new Set(['mapActions', 'mapGetters', 'mapState', 'mapMutations']);

export class VueResolver implements Resolver {
  analyze(opts: ResolveOptions): IrFile[] {
    const repoRoot = path.resolve(opts.repoRoot);
    const projects = discoverVueProjects(repoRoot, opts.projectFilter);
    const out: IrFile[] = [];
    for (const projectRoot of projects) out.push(...this.analyzeProject(projectRoot, repoRoot, opts));
    return out;
  }

  /** Analyze a single explicit project root (used by the per-project worker). */
  analyzeRoot(projectRoot: string, repoRoot: string, opts: ResolveOptions): IrFile[] {
    return this.analyzeProject(path.resolve(projectRoot), path.resolve(repoRoot), opts);
  }

  private analyzeProject(projectRoot: string, repoRoot: string, opts: ResolveOptions): IrFile[] {
    const pp = buildVueProgram(projectRoot, { repoRoot });
    const ctx = new AnalysisContext(pp.checker, repoRoot, pp.program.getCompilerOptions(), pp.sourceFiles);
    const mode = (opts as { mode?: string }).mode ?? 'development';
    const env = loadNuxtEnv(projectRoot, mode, opts.env);
    const baseUrl = readAxiosBaseUrl(projectRoot, env);
    const constEval = new ConstantEvaluator(pp.checker, env);
    const api = new VueApiCallResolver(pp.checker, constEval, repoRoot, pp.sourceFiles, baseUrl);
    const walker = new VueBodyWalker(api, constEval);

    const storeDir = path.join(projectRoot, 'store');
    const pagesDir = pagesDirOf(projectRoot);
    const files: IrFile[] = [];

    for (const sf of pp.sourceFiles) {
      const real = realOf(sf.fileName);

      // Vuex modules (store/**.js)
      if (within(real, storeDir) && (real.endsWith('.js') || real.endsWith('.ts'))) {
        const vx = resolveVuexFile(sf, storeDir, walker, (f) => ctx.repoRel(f));
        if (vx) {
          files.push(this.fileOf(ctx.repoRel(sf.fileName), repoRoot, vx.actions, [vx.module], []));
          continue;
        }
      }

      // SFC components / pages
      if (real.endsWith('.vue')) {
        const comp = this.parseSfc(sf, ctx, walker);
        if (!comp) continue;
        const routes: IrRoute[] = [];
        if (isUnderPages(real, pagesDir)) {
          const rel = path.relative(pagesDir, real);
          routes.push({
            routePath: nuxtRoutePath(rel),
            screenComponentId: comp.id,
            lazy: false,
            source: 'nuxt-pages',
            line: 1,
          });
        }
        files.push(this.fileOf(ctx.repoRel(sf.fileName), repoRoot, [comp], [], routes));
      }
    }
    return files;
  }

  // ---- SFC (Options API) parsing ----

  private parseSfc(sf: ts.SourceFile, ctx: AnalysisContext, walker: VueBodyWalker): IrComponent | null {
    const obj = findDefaultExportObject(sf);
    const name = (obj && stringProp(obj, 'name')) || pascalFromFile(sf.fileName);
    const id = `${ctx.repoRel(sf.fileName)}::${name}`;
    const calls: IrCall[] = obj ? this.collectSfcCalls(obj, walker) : [];
    return {
      id,
      name,
      kind: 'component',
      exported: true,
      isAsync: false,
      line: obj ? lineOf(sf, obj) : 1,
      jsxUsages: [], // Phase 2 (Pug)
      calls,
    };
  }

  private collectSfcCalls(obj: ts.ObjectLiteralExpression, walker: VueBodyWalker): IrCall[] {
    const calls: IrCall[] = [];
    for (const p of obj.properties) {
      const key = propName(p);
      if (!key) continue;

      // direct function options: asyncData / fetch / lifecycle hooks
      if (LIFECYCLE.has(key)) {
        const fn = functionOf(p);
        if (fn) calls.push(...walker.collect(fn, '', isAsync(fn)));
        continue;
      }

      // methods / computed / watch: objects of functions + map* spreads
      if (METHOD_CONTAINERS.has(key)) {
        const container = objectOf(p);
        if (!container) continue;
        for (const m of container.properties) {
          if (ts.isSpreadAssignment(m)) {
            calls.push(...this.parseMapSpread(m.expression));
            continue;
          }
          const fn = functionOf(m);
          if (fn) calls.push(...walker.collect(fn, '', isAsync(fn)));
        }
      }
    }
    return calls;
  }

  /** `...mapActions(...)` → dispatch edges, `...mapGetters/...mapState(...)` → store reads. */
  private parseMapSpread(expr: ts.Expression): IrCall[] {
    if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return [];
    const helper = expr.expression.text;
    if (!MAP_HELPERS.has(helper) || helper === 'mapMutations') return [];

    let ns = '';
    let entries: ts.Expression = expr.arguments[0];
    if (expr.arguments[0] && ts.isStringLiteralLike(expr.arguments[0])) {
      ns = expr.arguments[0].text;
      entries = expr.arguments[1];
    }
    const specs = entrySpecs(entries);
    const line = lineOf(expr.getSourceFile(), expr);

    return specs.map((spec): IrCall => {
      const full = ns ? `${ns}/${spec}` : spec;
      if (helper === 'mapActions') {
        const slash = full.lastIndexOf('/');
        const aNs = slash >= 0 ? full.slice(0, slash) : '';
        const action = slash >= 0 ? full.slice(slash + 1) : full;
        return { line, inAsyncCtx: true, resolution: { kind: 'storeDispatch', storeId: `store:vuex:${aNs || 'root'}#${action}`, action } };
      }
      // mapGetters / mapState → read on the module node
      const slash = full.lastIndexOf('/');
      const mNs = slash >= 0 ? full.slice(0, slash) : '';
      const sel = slash >= 0 ? full.slice(slash + 1) : full;
      return { line, inAsyncCtx: false, resolution: { kind: 'storeRead', storeId: vuexModuleId(mNs), selector: sel } };
    });
  }

  private fileOf(rel: string, repoRoot: string, components: IrComponent[], stores: IrStore[], routes: IrRoute[]): IrFile {
    const { project, module } = provenance(rel);
    return {
      path: rel,
      project,
      module,
      language: rel.endsWith('.vue') ? 'tsx' : rel.endsWith('.ts') ? 'ts' : 'js',
      components,
      routes,
      stores,
    };
  }
}

// ---- standalone helpers ----

function realOf(fileName: string): string {
  return fileName.endsWith('.vue.ts') ? fileName.slice(0, -3) : fileName;
}

function within(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function findDefaultExportObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      return unwrapObject(stmt.expression);
    }
  }
  return null;
}

/** `{...}` directly, or `Vue.extend({...})` / `defineComponent({...})`. */
function unwrapObject(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isCallExpression(expr)) {
    const arg = expr.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) return arg;
  }
  return null;
}

function entrySpecs(entries: ts.Expression | undefined): string[] {
  if (!entries) return [];
  const out: string[] = [];
  if (ts.isArrayLiteralExpression(entries)) {
    for (const el of entries.elements) if (ts.isStringLiteralLike(el)) out.push(el.text);
  } else if (ts.isObjectLiteralExpression(entries)) {
    for (const p of entries.properties) {
      if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) out.push(p.initializer.text);
    }
  }
  return out;
}

function functionOf(p: ts.ObjectLiteralElementLike): ts.FunctionLikeDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isMethodDeclaration(p)) return p;
  if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
    return p.initializer;
  }
  return null;
}

function objectOf(p: ts.ObjectLiteralElementLike): ts.ObjectLiteralExpression | null {
  if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) return p.initializer;
  return null;
}

function stringProp(obj: ts.ObjectLiteralExpression, key: string): string | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === key && ts.isStringLiteralLike(p.initializer)) {
      return p.initializer.text;
    }
  }
  return null;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}

function pascalFromFile(fileName: string): string {
  const base = path.basename(realOf(fileName)).replace(/\.vue$/, '');
  const cleaned = base === 'index' ? path.basename(path.dirname(realOf(fileName))) : base;
  return cleaned
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') || 'Default';
}

function isAsync(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
