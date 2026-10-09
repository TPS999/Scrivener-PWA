// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildScrivPackage, importScriv, unzipScriv, zipScriv } from '../src/scriv/scrivProject';
import { parseScrivx } from '../src/scriv/scrivx';
import { DOCKS_COMMENTS, DOCKS_RTF, SCRIVX } from './fixtures/sample';

const enc = new TextEncoder();
const dec = new TextDecoder();
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function sampleFiles() {
  return new Map<string, Uint8Array>([
    ['Novel.scrivx', enc.encode(SCRIVX)],
    ['Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.rtf', latin1(DOCKS_RTF)],
    ['Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.comments', enc.encode(DOCKS_COMMENTS)],
    ['Files/Data/CCCCCCCC-0000-4000-8000-000000000001/synopsis.txt', enc.encode('Arrival at the docks.')],
    ['Files/Data/DDDDDDDD-0000-4000-8000-000000000001/content.png', new Uint8Array([137, 80, 78, 71])],
    ['Settings/ui.plist', enc.encode('<plist/>')],
  ]);
}

describe('scrivx', () => {
  it('parses binder, labels, statuses, keywords', () => {
    const p = parseScrivx(SCRIVX);
    expect(p.rootIds).toHaveLength(3);
    const ch = p.items['BBBBBBBB-0000-4000-8000-000000000001'];
    expect(ch.title).toBe('Chapter One');
    expect(ch.children).toEqual(['CCCCCCCC-0000-4000-8000-000000000001', 'CCCCCCCC-0000-4000-8000-000000000002']);
    expect(ch.labelId).toBe(1);
    expect(ch.statusId).toBe(2);
    expect(p.items['CCCCCCCC-0000-4000-8000-000000000002'].includeInCompile).toBe(false);
    expect(p.items['CCCCCCCC-0000-4000-8000-000000000001'].keywords).toEqual([0]);
    expect(p.labels.find((l) => l.id === 1)!.color).toBe('#3366e6');
    expect(p.keywords[0].title).toBe('Harbour');
    expect(p.author).toBe('TJ Roark');
  });
});

describe('scriv package', () => {
  it('imports a project', () => {
    const { project, docs } = importScriv(sampleFiles(), 'x');
    expect(project.title).toBe('Novel');
    const docks = project.items['CCCCCCCC-0000-4000-8000-000000000001'];
    expect(docks.synopsis).toBe('Arrival at the docks.');
    expect(docks.wordCount).toBeGreaterThan(15);
    expect(project.items['DDDDDDDD-0000-4000-8000-000000000001'].fileExt).toBe('png');
    expect(docs.length).toBe(5); // draft, chapter, 2 scenes, research folder
  });

  it('keeps untouched files byte-identical and preserves unknown xml', () => {
    const raw = sampleFiles();
    const { project, docs } = importScriv(raw, 'x');
    const dm = new Map(docs.map((d) => [d.itemId, d]));
    const out = buildScrivPackage(project, dm, raw);
    expect(out.get('Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.rtf')).toBe(raw.get('Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.rtf'));
    expect(out.get('Settings/ui.plist')).toBe(raw.get('Settings/ui.plist'));
    const xml = dec.decode(out.get('Novel.scrivx')!);
    expect(xml).toContain('<CompileSettings><Format>Novel</Format></CompileSettings>');
    expect(xml).toContain('<TextSettings><TextSelection>0,0</TextSelection></TextSettings>');
    expect(xml).toContain('Collection Type="Search"');
    const again = parseScrivx(xml);
    expect(again.items['BBBBBBBB-0000-4000-8000-000000000001'].children).toHaveLength(2);
  });

  it('writes edits, moves and new docs', () => {
    const raw = sampleFiles();
    const { project, docs } = importScriv(raw, 'x');
    const dm = new Map(docs.map((d) => [d.itemId, d]));
    const scene = dm.get('CCCCCCCC-0000-4000-8000-000000000001')!;
    scene.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rewritten.' }] }] };
    scene.contentDirty = true;
    const ch = project.items['BBBBBBBB-0000-4000-8000-000000000001'];
    ch.children.reverse();
    ch.title = 'Chapter 1';
    const out = buildScrivPackage(project, dm, raw);
    const rtf = String.fromCharCode(...out.get('Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.rtf')!);
    expect(rtf).toContain('Rewritten.');
    expect(rtf).toContain('Palatino-Roman');
    expect(out.has('Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.comments')).toBe(false);
    const again = parseScrivx(dec.decode(out.get('Novel.scrivx')!));
    expect(again.items['BBBBBBBB-0000-4000-8000-000000000001'].title).toBe('Chapter 1');
    expect(again.items['BBBBBBBB-0000-4000-8000-000000000001'].children[0]).toBe('CCCCCCCC-0000-4000-8000-000000000002');
  });

  it('zips and unzips', () => {
    const raw = sampleFiles();
    const { project } = importScriv(raw, 'x');
    const z = zipScriv(project, raw);
    const back = unzipScriv(z);
    expect(back.name).toBe('Novel');
    expect(back.files.get('Novel.scrivx')!.length).toBe(raw.get('Novel.scrivx')!.length);
  });
});
