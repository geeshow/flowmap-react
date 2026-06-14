/**
 * Vue SFC template → child component tags. Phase 2 of the Vue analyzer: extract
 * the component usages a template renders so the GraphBuilder can draw render
 * edges (page → component → component). Without this every presentational SFC
 * (no API call / no dispatch) floats as an orphan node.
 *
 * Templates are usually Pug (`<template lang="pug">`) in real Nuxt 2 apps, with
 * plain HTML as a fallback. We extract leading tag tokens line-by-line (Pug) or
 * via tag scan (HTML), drop native HTML / framework builtins, and return the
 * component-candidate tags. Resolution to a component id is the caller's job.
 */

/** Native HTML + SVG + Vue/Nuxt framework tags that are never user components. */
const NATIVE_TAGS = new Set([
  // structural / text
  'html', 'head', 'body', 'div', 'span', 'p', 'a', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'pre', 'code', 'blockquote', 'q', 'cite', 'abbr', 'address',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'main', 'header', 'footer', 'nav', 'section', 'article',
  'aside', 'details', 'summary', 'dialog', 'menu',
  // table
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  // form
  'form', 'input', 'textarea', 'button', 'select', 'option', 'optgroup', 'label', 'fieldset', 'legend', 'datalist',
  'output', 'progress', 'meter',
  // media / embedded
  'img', 'picture', 'source', 'video', 'audio', 'track', 'canvas', 'svg', 'path', 'g', 'circle', 'rect', 'line',
  'polyline', 'polygon', 'ellipse', 'text', 'defs', 'use', 'symbol', 'clippath', 'mask', 'pattern', 'lineargradient',
  'radialgradient', 'stop', 'tspan', 'iframe', 'embed', 'object', 'param', 'map', 'area',
  // misc inline
  'script', 'style', 'link', 'meta', 'title', 'base', 'noscript', 'template', 'slot', 'wbr', 'time', 'data', 'kbd',
  'samp', 'var', 'del', 'ins', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'figcaption', 'picture',
  // Vue / Nuxt builtins (resolve to nothing user-defined)
  'component', 'transition', 'transition-group', 'keep-alive', 'slot', 'teleport', 'suspense',
  'router-view', 'router-link', 'nuxt', 'nuxt-child', 'nuxt-link', 'client-only', 'no-ssr', 'nuxt-content',
]);

/** Pug control keywords that lead a line but are not tags. */
const PUG_KEYWORDS = new Set([
  'if', 'else', 'unless', 'each', 'for', 'while', 'case', 'when', 'default', 'block', 'extends', 'include',
  'mixin', 'append', 'prepend', 'yield', 'doctype', 'do',
]);

export interface TemplateTag {
  tag: string; // raw tag as written (e.g. "about-section-first")
  line: number; // 0-based line offset within the template content
}

function isNative(tag: string): boolean {
  return NATIVE_TAGS.has(tag.toLowerCase());
}

/** Strip a wrapping `<template ...> ... </template>` if present (defensive). */
function stripWrapper(content: string): string {
  const open = content.match(/^\s*<template[^>]*>/i);
  if (open) {
    const inner = content.slice(open[0].length);
    return inner.replace(/<\/template>\s*$/i, '');
  }
  return content;
}

/** Net parenthesis depth change on a line, ignoring parens inside quotes. */
function parenDelta(s: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth;
}

/**
 * Extract component-candidate tags from a Pug template body.
 *
 * Pug attributes may span multiple lines inside `(...)`; we track paren depth so
 * continuation lines (`type="text"`, `v-if="..."`) are not mistaken for tags.
 */
export function extractPugTags(pug: string): TemplateTag[] {
  const out: TemplateTag[] = [];
  const lines = stripWrapper(pug).split(/\r?\n/);
  let attrDepth = 0; // >0 while inside a multi-line attribute list
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (attrDepth > 0) {
      attrDepth += parenDelta(raw);
      continue; // still inside an open (...) attribute list — not a tag line
    }
    const s = raw.replace(/^\s+/, '');
    if (!s) continue;
    const c0 = s[0];
    // text / code / interpolation / piped text / comments / mixin-call / raw-html
    if (c0 === '|' || c0 === '=' || c0 === '-' || c0 === '+' || c0 === '.' || c0 === '#' || c0 === ':') {
      attrDepth += parenDelta(s);
      continue;
    }
    if (s.startsWith('//')) continue;
    if (c0 === '<') {
      // embedded raw HTML line inside Pug
      for (const t of scanHtmlTags(s)) out.push({ tag: t, line: i });
      continue;
    }
    const m = s.match(/^([A-Za-z][\w-]*)/);
    if (m) {
      const tag = m[1];
      if (!PUG_KEYWORDS.has(tag) && !isNative(tag)) out.push({ tag, line: i });
    }
    // Carry any attribute paren opened on this line into the next.
    attrDepth += parenDelta(s);
  }
  return out;
}

function scanHtmlTags(html: string): string[] {
  const out: string[] = [];
  const re = /<([A-Za-z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1];
    if (!isNative(tag)) out.push(tag);
  }
  return out;
}

/** Extract component-candidate tags from an HTML template body. */
export function extractHtmlTags(html: string): TemplateTag[] {
  const body = stripWrapper(html);
  const lines = body.split(/\r?\n/);
  const out: TemplateTag[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of scanHtmlTags(lines[i])) out.push({ tag: t, line: i });
  }
  return out;
}

/** Dispatch on template language. */
export function extractTemplateTags(content: string, lang: string | null): TemplateTag[] {
  if (lang === 'pug' || lang === 'jade') return extractPugTags(content);
  return extractHtmlTags(content);
}

/** Canonical key so kebab `about-section-first` and Pascal `AboutSectionFirst` match. */
export function tagKey(name: string): string {
  return name.toLowerCase().replace(/-/g, '');
}
