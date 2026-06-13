/**
 * SFC (.vue) block splitter. Uses @vue/compiler-sfc's Vue 2 `parseComponent`
 * (robust against `</script>` inside strings, attributes, etc.).
 *
 * Line fidelity: the returned `scriptContent` is the ORIGINAL file with every
 * non-script character blanked to spaces (newlines kept). So a TS SourceFile
 * built from it reports line numbers identical to the original `.vue` file — ids
 * and call-site lines stay accurate and joinable with the graph/screens output.
 */

import { parseComponent } from '@vue/compiler-sfc';

export interface SfcBlocks {
  scriptContent: string; // line-aligned to the original .vue
  scriptStartLine: number; // 1-based line where <script> content begins
  scriptLang: string | null;
  templateContent: string | null;
  templateLang: string | null;
  templateStartLine: number;
}

const EMPTY: SfcBlocks = {
  scriptContent: '',
  scriptStartLine: 1,
  scriptLang: null,
  templateContent: null,
  templateLang: null,
  templateStartLine: 1,
};

export function splitSfc(raw: string): SfcBlocks {
  let pc: ReturnType<typeof parseComponent>;
  try {
    pc = parseComponent(raw);
  } catch {
    return EMPTY;
  }

  // pick the main <script> (fall back to <script setup>)
  const scriptBlock = pc.script ?? pc.scriptSetup;
  let scriptContent = '';
  let scriptStartLine = 1;
  let scriptLang: string | null = null;
  if (scriptBlock && typeof scriptBlock.start === 'number' && typeof scriptBlock.end === 'number') {
    const start = scriptBlock.start;
    const head = raw.slice(0, start).replace(/[^\n]/g, ' '); // blank everything before, keep newlines
    scriptContent = head + raw.slice(start, scriptBlock.end);
    scriptStartLine = countNewlines(raw.slice(0, start)) + 1;
    scriptLang = (scriptBlock as { lang?: string }).lang ?? null;
  }

  let templateContent: string | null = null;
  let templateLang: string | null = null;
  let templateStartLine = 1;
  if (pc.template && typeof pc.template.start === 'number' && typeof pc.template.end === 'number') {
    templateContent = raw.slice(pc.template.start, pc.template.end);
    templateLang = pc.template.lang ?? 'html';
    templateStartLine = countNewlines(raw.slice(0, pc.template.start)) + 1;
  }

  return { scriptContent, scriptStartLine, scriptLang, templateContent, templateLang, templateStartLine };
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
