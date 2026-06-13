/** SFC splitter: script content must be line-aligned to the original .vue file. */
import { describe, expect, it } from 'vitest';
import { splitSfc } from '../src/resolver/vue/sfc';

describe('splitSfc', () => {
  const raw = ['<template lang="pug">', '  div hi', '</template>', '<script>', "export default { name: 'X' }", '</script>', ''].join('\n');
  const b = splitSfc(raw);

  it('extracts the template lang', () => {
    expect(b.templateLang).toBe('pug');
    expect(b.templateContent).toContain('div hi');
  });

  it('keeps script line numbers aligned to the .vue source', () => {
    // "export default" is on line 5 of the original file → index 4 of the split content
    const lines = b.scriptContent.split('\n');
    expect(lines[4]).toContain('export default');
  });
});
