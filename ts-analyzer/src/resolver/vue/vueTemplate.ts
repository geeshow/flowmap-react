/**
 * Vue SFC template → child component tags. Phase 2 of the Vue analyzer: extract
 * the component usages a template renders so the GraphBuilder can draw render
 * edges (page → component → component). Without this every presentational SFC
 * (no API call / no dispatch) floats as an orphan node.
 *
 * Templates are usually Pug (`<template lang="pug">`) in real Nuxt 2 apps, with
 * plain HTML as a fallback. We extract leading tag tokens line-by-line (Pug,
 * indentation-aware so comment/literal-text blocks are skipped) or via a tag
 * scan (HTML, with comments/attribute-strings blanked). Native HTML / framework
 * builtins are dropped; resolution to a component id is the caller's job.
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
  'samp', 'var', 'del', 'ins', 'bdi', 'bdo', 'ruby', 'rt', 'rp',
  // Vue / Nuxt builtins (resolve to nothing user-defined)
  'component', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense',
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

/** Split a Pug line into inline-nested segments on top-level `: ` (outside quotes/parens). */
function inlineSegments(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === ':' && s[i + 1] === ' ') {
      out.push(s.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Extract component-candidate tags from a Pug template body.
 *
 * Indentation-aware: `//`/`//-` comment blocks and trailing-dot literal text
 * blocks (`p.`, `div.`) suppress their deeper-indented bodies. Multi-line
 * attribute lists `(...)` are tracked so continuation lines aren't read as tags.
 */
export function extractPugTags(pug: string): TemplateTag[] {
  const out: TemplateTag[] = [];
  const lines = stripWrapper(pug).split(/\r?\n/);
  let attrDepth = 0; // >0 while inside a multi-line attribute list
  let blockIndent = -1; // >=0 while inside a comment/literal-text block of this indent
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (attrDepth > 0) {
      attrDepth += parenDelta(raw);
      continue;
    }
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const s = raw.slice(indent);
    if (!s) continue; // blank lines do not terminate a block
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue; // still inside the comment/literal block
      blockIndent = -1; // block ended — process this line normally
    }
    if (s.startsWith('//')) {
      blockIndent = indent; // `//` and `//-` suppress the indented sub-tree
      continue;
    }
    const c0 = s[0];
    if (c0 === '|' || c0 === '=' || c0 === '-' || c0 === '+' || c0 === '.' || c0 === '#' || c0 === ':') {
      attrDepth += parenDelta(s);
      continue;
    }
    if (c0 === '<') {
      for (const t of scanHtmlTags(s)) out.push({ tag: t, line: i });
      continue;
    }
    for (const seg of inlineSegments(s)) {
      const m = seg.replace(/^\s+/, '').match(/^([A-Za-z][\w-]*)/);
      if (!m) continue;
      const tag = m[1];
      if (!PUG_KEYWORDS.has(tag) && !isNative(tag)) out.push({ tag, line: i });
    }
    // A trailing dot (balanced parens) opens a literal text block.
    if (parenDelta(s) === 0 && /\.\s*$/.test(s)) blockIndent = indent;
    else attrDepth += parenDelta(s);
  }
  return out;
}

/** Blank quoted-string regions in a single line (keeps length/positions). */
function blankQuotes(s: string): string {
  return s.replace(/"[^"]*"|'[^']*'/g, (m) => ' '.repeat(m.length));
}

function scanHtmlTags(html: string): string[] {
  const out: string[] = [];
  const re = /<([A-Za-z][\w-]*)/g;
  let m: RegExpExecArray | null;
  const cleaned = blankQuotes(stripHtmlComments(html));
  while ((m = re.exec(cleaned)) !== null) {
    const tag = m[1];
    if (!isNative(tag)) out.push(tag);
  }
  return out;
}

/** Replace HTML comment regions with same-length blanks, preserving newlines. */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Extract component-candidate tags from an HTML template body. */
export function extractHtmlTags(html: string): TemplateTag[] {
  const body = stripHtmlComments(stripWrapper(html));
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
