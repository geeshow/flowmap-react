/** Pug/HTML template tag extraction — comments, literal blocks, multiline attrs. */
import { describe, expect, it } from 'vitest';
import { extractPugTags, extractHtmlTags, extractTemplateTags, tagKey } from '../src/resolver/vue/vueTemplate';

const tags = (out: { tag: string }[]) => out.map((t) => t.tag);

describe('extractPugTags', () => {
  it('extracts component tags, skipping native/keyword tokens', () => {
    const t = tags(extractPugTags(`div
  my-widget
  about-section-first
  h2 title`));
    expect(t).toEqual(['my-widget', 'about-section-first']);
  });

  it('does not read multi-line attribute lines as tags', () => {
    const t = tags(extractPugTags(`my-comp(
  type="text"
  v-model="x"
  class="foo")
  child-comp`));
    expect(t).toEqual(['my-comp', 'child-comp']);
  });

  it('skips // and //- comment blocks including indented bodies', () => {
    const t = tags(extractPugTags(`div
  //- commented
    hidden-comp
  // also-comment
    another-hidden
  real-comp`));
    expect(t).toEqual(['real-comp']);
  });

  it('skips trailing-dot literal text blocks', () => {
    const t = tags(extractPugTags(`p.
  This is raw text MyComponent words
  AnotherComp here
visible-comp`));
    expect(t).toEqual(['visible-comp']);
  });

  it('recovers components in inline (colon) nesting', () => {
    const t = tags(extractPugTags(`li: my-component\na: another-comp`));
    expect(t).toEqual(['my-component', 'another-comp']);
  });
});

describe('extractHtmlTags', () => {
  it('drops HTML comments and attribute-string angle brackets', () => {
    const t = tags(extractHtmlTags(`<!-- <OldComp/> --><NewComp/><div title="<FakeComp>"><RealComp/></div>`));
    expect(t.sort()).toEqual(['NewComp', 'RealComp']);
  });

  it('handles multi-line HTML comments', () => {
    const t = tags(extractHtmlTags(`<NewComp/>\n<!--\n<Hidden/>\n-->\n<Other/>`));
    expect(t.sort()).toEqual(['NewComp', 'Other']);
  });
});

describe('extractTemplateTags dispatch + tagKey', () => {
  it('routes pug vs html by lang', () => {
    expect(tags(extractTemplateTags('my-comp', 'pug'))).toEqual(['my-comp']);
    expect(tags(extractTemplateTags('<my-comp/>', 'html'))).toEqual(['my-comp']);
  });
  it('canonicalizes kebab and Pascal to the same key', () => {
    expect(tagKey('about-section-first')).toBe(tagKey('AboutSectionFirst'));
  });
});
