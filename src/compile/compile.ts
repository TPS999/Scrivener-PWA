import { zipSync, strToU8 } from 'fflate';
import type { PMMark, PMNode } from '../model/types';
import type { Session } from '../store/session';

export type CompileFormat = 'docx' | 'epub' | 'pdf' | 'html' | 'md' | 'txt';
export type CompilePreset = 'manuscript' | 'novel' | 'plain';

export interface CompileOptions {
  format: CompileFormat;
  preset: CompilePreset;
  title: string;
  author: string;
  rootId: string;
  onlyIncluded: boolean;
  folderTitles: boolean;   // folder titles become chapter headings
  docTitles: boolean;      // text document titles become headings too
  sceneSeparator: string;  // between consecutive text documents
  stripComments: boolean;
  stripAnnotations: boolean;
  titlePage: boolean;
  numberChapters: boolean;
}

// ---------------------------------------------------------------- gathering

interface Run { text: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; footnote?: string; br?: boolean }
interface Para { runs: Run[]; align?: string; heading?: number; quote?: boolean; separator?: boolean }
export interface Chapter { title: string | null; paras: Para[] }

function inlineRuns(nodes: PMNode[] | undefined, opts: CompileOptions): Run[] {
  const runs: Run[] = [];
  const seenNotes = new Set<string>();
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') { runs.push({ text: '', br: true }); continue; }
    if (n.type !== 'text') continue;
    const m = (t: string): PMMark | undefined => n.marks?.find((x) => x.type === t);
    if (m('annotation') && opts.stripAnnotations) continue;
    const r: Run = { text: n.text ?? '', b: !!m('bold'), i: !!m('italic'), u: !!m('underline'), s: !!m('strike') };
    runs.push(r);
    const c = m('scrivComment');
    if (c && c.attrs?.kind === 'footnote') {
      const id = String(c.attrs.id);
      // footnote reference goes after the last run of the anchored text
      const next = (nodes ?? [])[(nodes ?? []).indexOf(n) + 1];
      const continues = next?.marks?.some((x) => x.type === 'scrivComment' && x.attrs?.id === id);
      if (!continues && !seenNotes.has(id)) { seenNotes.add(id); r.footnote = String(c.attrs.text ?? ''); }
    }
  }
  return runs;
}

function blocks(doc: PMNode, opts: CompileOptions): Para[] {
  const out: Para[] = [];
  const walk = (nodes: PMNode[] | undefined, quote = false) => {
    for (const n of nodes ?? []) {
      if (n.type === 'paragraph') out.push({ runs: inlineRuns(n.content, opts), align: n.attrs?.textAlign as string, quote });
      else if (n.type === 'heading') out.push({ runs: inlineRuns(n.content, opts), heading: Math.min(3, Number(n.attrs?.level ?? 2)) + 1, quote });
      else if (n.type === 'blockquote') walk(n.content, true);
      else if (n.type === 'bulletList' || n.type === 'orderedList') {
        let k = Number(n.attrs?.start ?? 1);
        for (const li of n.content ?? []) {
          const [first, ...rest] = li.content ?? [];
          const runs = inlineRuns(first?.content, opts);
          runs.unshift({ text: n.type === 'bulletList' ? '• ' : `${k++}. ` });
          out.push({ runs, quote });
          walk(rest, quote);
        }
      } else if (n.type === 'horizontalRule') out.push({ runs: [], separator: true });
    }
  };
  walk(doc.content);
  // a lone "#" or "* * *" paragraph is a scene break
  for (const p of out) {
    const t = p.runs.map((r) => r.text).join('').trim();
    if (/^(#|\*\s*\*\s*\*|\*\*\*)$/.test(t)) p.separator = true;
  }
  while (out.length && !out[out.length - 1].runs.some((r) => r.text.trim()) && !out[out.length - 1].separator) out.pop();
  return out;
}

export async function gather(session: Session, opts: CompileOptions): Promise<Chapter[]> {
  const p = session.project;
  const chapters: Chapter[] = [];
  let cur: Chapter | null = null;
  let chapterNo = 0;
  let lastWasText = false;

  const visit = async (id: string, depth: number) => {
    const it = p.items[id];
    if (!it) return;
    if (opts.onlyIncluded && !it.includeInCompile && id !== opts.rootId) return;
    const folderLike = it.type === 'Folder' || it.children.length > 0;
    if (id !== opts.rootId) {
      const wantsTitle = folderLike ? opts.folderTitles : opts.docTitles;
      const startsChapter = !cur || !!it.pageBreakBefore || (depth === 1 && (folderLike || opts.docTitles));
      if (startsChapter) {
        let title: string | null = null;
        if (wantsTitle && depth === 1) {
          chapterNo++;
          title = opts.numberChapters ? `Chapter ${chapterNo}${it.title ? ': ' + it.title : ''}` : it.title;
        }
        cur = { title, paras: [] };
        chapters.push(cur);
        lastWasText = false;
        if (wantsTitle && depth > 1) cur.paras.push({ runs: [{ text: it.title }], heading: 2 });
      } else if (wantsTitle) {
        cur!.paras.push({ runs: [{ text: it.title }], heading: 2 });
        lastWasText = false;
      }
      const d = await session.loadDoc(id);
      const ps = d ? blocks(d.content, opts) : [];
      if (ps.length) {
        if (lastWasText && opts.sceneSeparator) cur!.paras.push({ runs: [{ text: opts.sceneSeparator }], separator: true, align: 'center' });
        cur!.paras.push(...ps);
        lastWasText = true;
      }
    }
    for (const c of it.children) await visit(c, depth + 1);
    if (folderLike) lastWasText = false;
  };
  const root = p.items[opts.rootId];
  if (root.type === 'Text' && !root.children.length) {
    const d = await session.loadDoc(root.id);
    chapters.push({ title: opts.docTitles ? root.title : null, paras: d ? blocks(d.content, opts) : [] });
  } else await visit(opts.rootId, 0);
  return chapters.filter((c) => c.title || c.paras.length);
}

// ---------------------------------------------------------------- outputs

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runsHtml(runs: Run[], notes: string[], noteHref: (n: number) => string) {
  return runs.map((r) => {
    if (r.br) return '<br/>';
    let t = escHtml(r.text);
    if (r.b) t = `<strong>${t}</strong>`;
    if (r.i) t = `<em>${t}</em>`;
    if (r.u) t = `<u>${t}</u>`;
    if (r.s) t = `<s>${t}</s>`;
    if (r.footnote !== undefined) {
      notes.push(r.footnote);
      const n = notes.length;
      t += `<sup><a id="ref${n}" href="${noteHref(n)}" epub:type="noteref">${n}</a></sup>`;
    }
    return t;
  }).join('');
}

function chapterHtml(ch: Chapter, notes: string[], noteHref: (n: number) => string) {
  let h = ch.title ? `<h1>${escHtml(ch.title)}</h1>\n` : '';
  let first = true;
  for (const p of ch.paras) {
    if (p.separator) { h += `<p class="sep">${escHtml(p.runs.map((r) => r.text).join('').trim() || '#')}</p>\n`; first = true; continue; }
    const tag = p.heading ? `h${p.heading}` : p.quote ? 'blockquote' : 'p';
    const cls = [first && !p.heading ? 'first' : '', p.align && p.align !== 'left' ? `al-${p.align}` : ''].filter(Boolean).join(' ');
    h += `<${tag}${cls ? ` class="${cls}"` : ''}>${runsHtml(p.runs, notes, noteHref) || '&#160;'}</${tag}>\n`;
    first = !!p.heading;
  }
  return h;
}

const BOOK_CSS = `
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; margin: 0 auto; max-width: 38em; padding: 1em; }
h1 { text-align: center; margin: 3em 0 1.5em; font-weight: normal; page-break-before: always; break-before: page; }
h1:first-child { page-break-before: auto; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
p.first, p.al-center, p.sep { text-indent: 0; }
p.sep { text-align: center; margin: 1em 0; }
.al-center { text-align: center; } .al-right { text-align: right; text-indent: 0; }
blockquote { margin: .5em 2em; }
.titlepage { text-align: center; margin-top: 30vh; page-break-after: always; break-after: page; }
.titlepage h1 { page-break-before: auto; margin: 0 0 1em; font-size: 2.2em; }
.notes { margin-top: 2em; font-size: .9em; border-top: 1px solid #999; padding-top: .5em; }
.notes p { text-indent: 0; margin-bottom: .4em; }
`;
const MS_CSS = `
@page { margin: 1in; }
body { font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 2; max-width: 6.5in; margin: 0 auto; }
h1 { text-align: center; font-size: 12pt; font-weight: normal; margin: 2.5in 0 1em; page-break-before: always; break-before: page; }
h1:first-child { page-break-before: auto; }
p { margin: 0; text-indent: .5in; }
p.first, p.al-center, p.sep { text-indent: 0; }
p.sep { text-align: center; }
.al-center { text-align: center; } .al-right { text-align: right; }
.titlepage { text-align: center; margin-top: 3in; page-break-after: always; break-after: page; }
.titlepage h1 { margin: 0; page-break-before: auto; }
.notes { margin-top: 2em; } .notes p { text-indent: 0; }
`;

export function toHtml(chs: Chapter[], o: CompileOptions) {
  const notes: string[] = [];
  const body = chs.map((c) => chapterHtml(c, notes, (n) => `#note${n}`)).join('\n');
  const tp = o.titlePage ? `<div class="titlepage"><h1>${escHtml(o.title)}</h1><p class="al-center">${escHtml(o.author)}</p></div>` : '';
  const notesHtml = notes.length ? `<div class="notes"><h2>Notes</h2>${notes.map((t, k) => `<p id="note${k + 1}"><a href="#ref${k + 1}">${k + 1}.</a> ${escHtml(t)}</p>`).join('')}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(o.title)}</title><style>${o.preset === 'manuscript' ? MS_CSS : BOOK_CSS}</style></head><body>${tp}${body}${notesHtml}</body></html>`;
}

export function toMarkdown(chs: Chapter[], o: CompileOptions) {
  const notes: string[] = [];
  const md = (runs: Run[]) => runs.map((r) => {
    if (r.br) return '  \n';
    let t = r.text.replace(/([*_`\\[\]])/g, '\\$1');
    const lead = t.match(/^\s*/)![0], trail = t.match(/\s*$/)![0];
    let core = t.trim();
    if (core) {
      if (r.b) core = `**${core}**`;
      if (r.i) core = `*${core}*`;
      if (r.s) core = `~~${core}~~`;
      t = lead + core + trail;
    }
    if (r.footnote !== undefined) { notes.push(r.footnote); t += `[^${notes.length}]`; }
    return t;
  }).join('');
  let out = o.titlePage ? `# ${o.title}\n\n${o.author ? `*${o.author}*\n\n` : ''}` : '';
  for (const c of chs) {
    if (c.title) out += `## ${c.title}\n\n`;
    for (const p of c.paras) {
      if (p.separator) { out += `${p.runs.map((r) => r.text).join('').trim() === '#' ? '\\#' : '* * *'}\n\n`; continue; }
      const text = md(p.runs);
      out += p.heading ? `${'#'.repeat(Math.min(6, p.heading + 1))} ${text}\n\n` : p.quote ? `> ${text}\n\n` : `${text}\n\n`;
    }
  }
  if (notes.length) out += notes.map((n, k) => `[^${k + 1}]: ${n}`).join('\n') + '\n';
  return out;
}

export function toText(chs: Chapter[], o: CompileOptions) {
  const notes: string[] = [];
  let out = o.titlePage ? `${o.title}\n${o.author}\n\n\n` : '';
  for (const c of chs) {
    if (c.title) out += `${c.title}\n\n`;
    for (const p of c.paras) {
      out += p.runs.map((r) => {
        if (r.br) return '\n';
        if (r.footnote !== undefined) { notes.push(r.footnote); return `${r.text}[${notes.length}]`; }
        return r.text;
      }).join('') + '\n\n';
    }
    out += '\n';
  }
  if (notes.length) out += 'Notes\n\n' + notes.map((n, k) => `[${k + 1}] ${n}`).join('\n') + '\n';
  return out;
}

export function toEpub(chs: Chapter[], o: CompileOptions): Uint8Array {
  const id = 'urn:uuid:' + crypto.randomUUID();
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  files['OEBPS/style.css'] = strToU8(BOOK_CSS.replace('max-width: 38em;', ''));
  const xhtml = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><meta charset="utf-8"/><title>${escHtml(title)}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;
  const manifest: string[] = [];
  const spine: string[] = [];
  const nav: string[] = [];
  if (o.titlePage) {
    files['OEBPS/title.xhtml'] = strToU8(xhtml(o.title, `<div class="titlepage"><h1>${escHtml(o.title)}</h1><p class="al-center">${escHtml(o.author)}</p></div>`));
    manifest.push('<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="title"/>');
  }
  chs.forEach((c, k) => {
    const notes: string[] = [];
    let body = chapterHtml(c, notes, (n) => `#n${n}`);
    if (notes.length) body += `<section class="notes" epub:type="footnotes">${notes.map((t, j) => `<aside id="n${j + 1}" epub:type="footnote"><p><a href="#ref${j + 1}">${j + 1}.</a> ${escHtml(t)}</p></aside>`).join('')}</section>`;
    const name = `ch${k + 1}.xhtml`;
    files[`OEBPS/${name}`] = strToU8(xhtml(c.title ?? o.title, body));
    manifest.push(`<item id="ch${k + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${k + 1}"/>`);
    nav.push(`<li><a href="${name}">${escHtml(c.title ?? `Section ${k + 1}`)}</a></li>`);
  });
  files['OEBPS/nav.xhtml'] = strToU8(xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${nav.join('')}</ol></nav>`));
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${escHtml(o.title)}</dc:title><dc:creator>${escHtml(o.author)}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join('')}</manifest>
<spine>${spine.join('')}</spine></package>`);
  return zipSync(files as Parameters<typeof zipSync>[0]);
}

export async function toDocx(chs: Chapter[], o: CompileOptions): Promise<Blob> {
  const d = await import('docx');
  const ms = o.preset === 'manuscript';
  const font = ms ? 'Times New Roman' : 'Georgia';
  const footnotes: Record<number, { children: InstanceType<typeof d.Paragraph>[] }> = {};
  let fnId = 1;
  const line = ms ? 480 : 300;
  const runs = (rs: Run[]) => rs.flatMap((r) => {
    if (r.br) return [new d.TextRun({ text: '', break: 1 })];
    const out: (InstanceType<typeof d.TextRun> | InstanceType<typeof d.FootnoteReferenceRun>)[] = [
      new d.TextRun({ text: r.text, bold: r.b, italics: r.i, underline: r.u ? {} : undefined, strike: r.s }),
    ];
    if (r.footnote !== undefined) {
      footnotes[fnId] = { children: [new d.Paragraph({ children: [new d.TextRun(r.footnote)] })] };
      out.push(new d.FootnoteReferenceRun(fnId++));
    }
    return out;
  });
  const children: InstanceType<typeof d.Paragraph>[] = [];
  if (o.titlePage) {
    children.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, spacing: { before: 4000 }, children: [new d.TextRun({ text: o.title, size: ms ? 24 : 48, bold: !ms })] }));
    if (o.author) children.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ text: `by ${o.author}` })] }));
  }
  chs.forEach((c, k) => {
    const breakBefore = k > 0 || o.titlePage;
    if (c.title) children.push(new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, alignment: d.AlignmentType.CENTER, pageBreakBefore: breakBefore, spacing: { before: ms ? 2880 : 1440, after: 480 }, children: [new d.TextRun({ text: c.title, size: 24 * (ms ? 1 : 1.4), bold: !ms, font, color: '000000' })] }));
    let first = true;
    c.paras.forEach((p, j) => {
      const pb = !c.title && j === 0 && breakBefore;
      if (p.separator) {
        children.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, pageBreakBefore: pb, children: [new d.TextRun(p.runs.map((r) => r.text).join('').trim() || '#')] }));
        first = true;
        return;
      }
      const align = p.align === 'center' ? d.AlignmentType.CENTER : p.align === 'right' ? d.AlignmentType.RIGHT : p.align === 'justify' ? d.AlignmentType.JUSTIFIED : d.AlignmentType.LEFT;
      children.push(new d.Paragraph({
        alignment: align, pageBreakBefore: pb,
        heading: p.heading ? d.HeadingLevel.HEADING_2 : undefined,
        indent: p.quote ? { left: 720, right: 720 } : first || p.heading || align === d.AlignmentType.CENTER ? undefined : { firstLine: 720 },
        children: runs(p.runs),
      }));
      first = !!p.heading;
    });
  });
  const header = ms ? {
    default: new d.Header({ children: [new d.Paragraph({ alignment: d.AlignmentType.RIGHT, children: [new d.TextRun(`${o.author.split(' ').pop() ?? ''} / ${o.title.toUpperCase().slice(0, 30)} / `), new d.TextRun({ children: [d.PageNumber.CURRENT] })] })] }),
  } : undefined;
  const doc = new d.Document({
    creator: o.author, title: o.title,
    styles: { default: { document: { run: { font, size: 24 }, paragraph: { spacing: { line } } } } },
    footnotes,
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } }, titlePage: o.titlePage }, headers: header, children }],
  });
  return d.Packer.toBlob(doc);
}

export async function compile(session: Session, o: CompileOptions): Promise<{ blob: Blob; filename: string } | { printHtml: string }> {
  const chs = await gather(session, o);
  const base = o.title.replace(/[\\/:*?"<>|]/g, '_') || 'Manuscript';
  switch (o.format) {
    case 'docx': return { blob: await toDocx(chs, o), filename: `${base}.docx` };
    case 'epub': return { blob: new Blob([toEpub(chs, o) as BlobPart], { type: 'application/epub+zip' }), filename: `${base}.epub` };
    case 'html': return { blob: new Blob([toHtml(chs, o)], { type: 'text/html' }), filename: `${base}.html` };
    case 'md': return { blob: new Blob([toMarkdown(chs, o)], { type: 'text/markdown' }), filename: `${base}.md` };
    case 'txt': return { blob: new Blob([toText(chs, o)], { type: 'text/plain' }), filename: `${base}.txt` };
    case 'pdf': return { printHtml: toHtml(chs, o) };
  }
}
