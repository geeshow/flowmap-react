/**
 * `.vue`-aware ts.Program — the Vue analog of program.ts's buildProjectProgram.
 *
 * The TypeChecker can't read `.vue` files, so we present each `foo.vue` to the
 * compiler as a virtual `foo.vue.ts` whose text is the SFC's `<script>` block
 * (line-aligned via sfc.splitSfc). A custom module resolver rewrites import
 * specifiers that point at a `.vue` file to its `.vue.ts` twin, so cross-file
 * symbol resolution works across `.vue` SFCs and plain `.js` store/api modules —
 * which is what the ConstantEvaluator and wrapper-tracing depend on.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BuildOptions, ProjectProgram, collectSourceFiles } from '../program';
import { splitSfc } from './sfc';

const VUE = '.vue';
const VUE_TS = '.vue.ts';

const toVirtual = (f: string) => (f.endsWith(VUE) ? f + '.ts' : f);
const fromVirtual = (f: string) => (f.endsWith(VUE_TS) ? f.slice(0, -3) : f);

export function buildVueProgram(rootDir: string, opts: BuildOptions): ProjectProgram {
  const realFiles = collectSourceFiles(rootDir, [VUE]);
  const vueReal = new Set(realFiles.filter((f) => f.endsWith(VUE)).map((f) => path.resolve(f)));
  const rootNames = realFiles.map(toVirtual);

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowNonTsExtensions: true,
    resolveJsonModule: true,
    baseUrl: rootDir,
    paths: aliasPaths(rootDir),
  };

  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const scriptCache = new Map<string, string>();

  const scriptOf = (virtual: string): string => {
    if (scriptCache.has(virtual)) return scriptCache.get(virtual)!;
    const real = fromVirtual(virtual);
    let text = '';
    try {
      text = splitSfc(origReadFile(real) ?? '').scriptContent;
    } catch {
      text = '';
    }
    scriptCache.set(virtual, text);
    return text;
  };

  host.fileExists = (f) => (f.endsWith(VUE_TS) ? origFileExists(fromVirtual(f)) : origFileExists(f));
  host.readFile = (f) => (f.endsWith(VUE_TS) ? scriptOf(f) : origReadFile(f));
  host.getSourceFile = (fileName, langVersion, onError, shouldCreate) => {
    if (fileName.endsWith(VUE_TS)) {
      return ts.createSourceFile(fileName, scriptOf(fileName), langVersion, true, ts.ScriptKind.JS);
    }
    return origGetSourceFile(fileName, langVersion, onError, shouldCreate);
  };

  // resolve `.vue` (and aliased/relative) specifiers to their `.vue.ts` twin;
  // delegate everything else to standard resolution.
  host.resolveModuleNameLiterals = (literals, containingFile, _redirect, opts2, _sf) =>
    literals.map((lit) => {
      const vueHit = resolveVue(lit.text, containingFile, rootDir, vueReal);
      if (vueHit) {
        return {
          resolvedModule: {
            resolvedFileName: toVirtual(vueHit),
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        } as ts.ResolvedModuleWithFailedLookupLocations;
      }
      return ts.resolveModuleName(lit.text, containingFile, opts2, host);
    });

  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();

  const rootSet = new Set(rootNames.map((f) => path.resolve(f)));
  const sourceFiles = program.getSourceFiles().filter((sf) => rootSet.has(path.resolve(sf.fileName)));

  return { project: path.basename(rootDir), rootDir, program, checker, sourceFiles, repoRoot: opts.repoRoot };
}

/** Nuxt default aliases (@ / ~ → srcDir == root) plus a tsconfig/jsconfig `paths` merge. */
function aliasPaths(rootDir: string): ts.MapLike<string[]> {
  const paths: ts.MapLike<string[]> = {
    '@/*': ['./*'],
    '~/*': ['./*'],
    '@@/*': ['./*'],
    '~~/*': ['./*'],
  };
  for (const cfg of ['jsconfig.json', 'tsconfig.json']) {
    const p = path.join(rootDir, cfg);
    if (!fs.existsSync(p)) continue;
    try {
      const read = ts.readConfigFile(p, ts.sys.readFile);
      const userPaths = read.config?.compilerOptions?.paths as ts.MapLike<string[]> | undefined;
      if (userPaths) Object.assign(paths, userPaths);
    } catch {
      /* ignore */
    }
  }
  return paths;
}

/** Manually resolve relative/aliased specifiers to a project `.vue` file. */
function resolveVue(name: string, containingFile: string, rootDir: string, vueReal: Set<string>): string | undefined {
  let base: string | undefined;
  if (name.startsWith('.')) {
    base = path.resolve(path.dirname(fromVirtual(containingFile)), name);
  } else if (/^[@~]{1,2}\//.test(name)) {
    base = path.resolve(rootDir, name.replace(/^[@~]{1,2}\//, ''));
  } else {
    return undefined; // bare module → standard resolution
  }
  const candidates = name.endsWith(VUE) ? [base] : [base + VUE, path.join(base, 'index.vue')];
  for (const c of candidates) {
    if (vueReal.has(path.resolve(c))) return c;
  }
  return undefined;
}
