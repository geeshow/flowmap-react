/**
 * Nuxt filesystem routing for `pages/**.vue`. `_param.vue` → `{}` (dynamic),
 * `index.vue` → the parent path, nested folders preserved. The screen component
 * is the page file's default export (wired in vueIrBuilder).
 */

import * as path from 'path';

/** Absolute pages dir for a project, or null if none. */
export function pagesDirOf(rootDir: string): string {
  return path.join(rootDir, 'pages');
}

/** True if an absolute file is under the project's pages/ dir. */
export function isUnderPages(absFile: string, pagesDir: string): boolean {
  const rel = path.relative(pagesDir, absFile);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Route path for a page file relative to pages/, e.g. "products/_id.vue" → "/products/{}". */
export function nuxtRoutePath(relFromPages: string): string {
  const noExt = relFromPages.replace(/\.vue$/, '').split(path.sep).join('/');
  const segs = noExt.split('/').filter((s) => s.length > 0);
  const mapped: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === 'index' && i === segs.length - 1) continue; // trailing index → parent path
    mapped.push(seg.startsWith('_') ? '{}' : seg);
  }
  return '/' + mapped.join('/');
}
