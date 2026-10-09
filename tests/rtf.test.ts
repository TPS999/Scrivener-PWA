import { describe, expect, it } from 'vitest';
import { docPlainText, docToRtf, parseCommentsXml, rtfToDoc } from '../src/scriv/rtf';
import { DOCKS_COMMENTS, DOCKS_RTF, IMAGE_RTF } from './fixtures/sample';

describe('rtf', () => {
  const comments = parseCommentsXml(DOCKS_COMMENTS);

  it('parses comments xml', () => {
    expect(comments.get('EEEEEEEE-0000-4000-8000-000000000001')).toEqual({ text: 'Is this the right street?', footnote: false });
  });

  it('parses text, formatting, unicode, alignment', () => {
    const { doc, style, lossy } = rtfToDoc(DOCKS_RTF, comments);
    const text = docPlainText(doc);
    expect(text).toBe('The fog came in off the water like a held breath. Nobody moved.\nHe said, “It’s late.” Check this and left.\n\n#\nCafé lights burned low.');
    expect(lossy).toEqual([]);
    const p0 = doc.content![0];
    expect(p0.content!.find((n) => n.text === 'Nobody')!.marks).toEqual([{ type: 'italic' }]);
    const p1 = doc.content![1];
    const cm = p1.content!.find((n) => n.text === 'Check this')!;
    expect(cm.marks![0]).toMatchObject({ type: 'scrivComment', attrs: { kind: 'comment', text: 'Is this the right street?' } });
    expect(doc.content![3].attrs).toEqual({ textAlign: 'center' });
    const hl = doc.content![4].content!.find((n) => n.text === 'burned')!;
    expect(hl.marks).toEqual([{ type: 'highlight', attrs: { color: '#fff500' } }]);
    expect(style.fonttbl).toContain('Palatino-Roman');
    expect(style.paraProps).toContain('\\fi360');
    expect(style.paraProps).toContain('\\fs26');
  });

  it('round-trips through the writer', () => {
    const a = rtfToDoc(DOCKS_RTF, comments);
    const { rtf, comments: outC } = docToRtf(a.doc, a.style);
    expect(outC).toHaveLength(1);
    const cmap = new Map(outC.map((c) => [c.id, { text: c.text, footnote: c.kind === 'footnote' }]));
    const b = rtfToDoc(rtf, cmap);
    expect(b.doc).toEqual(a.doc);
    expect(rtf).toContain('Palatino-Roman');
    expect(rtf).toContain('\\fi360');
  });

  it('flags images as lossy and drops the attachment char', () => {
    const r = rtfToDoc(IMAGE_RTF);
    expect(r.lossy).toContain('images');
    expect(docPlainText(r.doc)).toBe('Before  after.');
  });

  it('handles astral characters', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Emoji 🎉 & {braces} \\ ok' }] }] };
    const back = rtfToDoc(docToRtf(doc).rtf).doc;
    expect(docPlainText(back)).toBe('Emoji 🎉 & {braces} \\ ok');
  });

  it('parses classic RTF footnotes', () => {
    const r = rtfToDoc('{\\rtf1\\ansi Word{\\footnote\\pard Source note.} next}');
    const fn = r.doc.content![0].content!.find((n) => n.text === 'Word')!;
    expect(fn.marks![0]).toMatchObject({ type: 'scrivComment', attrs: { kind: 'footnote', text: 'Source note.' } });
  });
});
