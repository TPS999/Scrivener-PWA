// Scrivener 3 project file (.scrivx) reader / in-place updater.
//
// We never regenerate the .scrivx from scratch for an existing project: the
// original XML is kept and only the parts we model (binder structure, titles,
// label/status/keywords/include-in-compile, label & status lists) are
// rewritten. Everything else desktop Scrivener stores there (collections,
// compile settings, print settings, custom metadata, ...) round-trips intact.

import type { BinderItem, ItemType, Keyword, Label, Project, Status } from '../model/types';

const KNOWN_TYPES = new Set<ItemType>(['DraftFolder', 'ResearchFolder', 'TrashFolder', 'Folder', 'Text', 'Image', 'PDF', 'WebArchive', 'Other']);

const kids = (el: Element | null | undefined, tag: string) =>
  el ? Array.from(el.children).filter((c) => c.tagName === tag) : [];
const kid = (el: Element | null | undefined, tag: string) => kids(el, tag)[0] ?? null;

export function scrivDateToIso(s: string | null): string {
  if (!s) return new Date().toISOString();
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(s.trim());
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (!isNaN(+d)) return d.toISOString();
  }
  const d = new Date(s);
  return isNaN(+d) ? new Date().toISOString() : d.toISOString();
}
export function isoToScrivDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function colorFromScriv(s: string | null): string {
  if (!s) return '';
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return '';
  return '#' + parts.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}
function colorToScriv(hex: string) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => (c / 255).toFixed(6)).join(' ');
}

export interface ParsedScrivx {
  title?: string;
  author: string;
  rootIds: string[];
  items: Record<string, BinderItem>;
  labels: Label[];
  statuses: Status[];
  keywords: Keyword[];
  targets: { draft: number; session: number; deadline?: string };
  version: string;
}

export function parseScrivx(xml: string): ParsedScrivx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The .scrivx file is not valid XML');
  const root = doc.documentElement;
  const version = root.getAttribute('Version') ?? '';
  if (version && parseFloat(version) < 2) {
    throw new Error('This is a Scrivener 2 project. Open it once in Scrivener 3 on your computer to upgrade it, then try again.');
  }
  const items: Record<string, BinderItem> = {};
  const rootIds: string[] = [];

  const walk = (el: Element, parent: string | null): string => {
    const id = (el.getAttribute('UUID') ?? el.getAttribute('ID') ?? crypto.randomUUID()).toUpperCase();
    const typeAttr = el.getAttribute('Type') as ItemType;
    const type: ItemType = KNOWN_TYPES.has(typeAttr) ? typeAttr : 'Other';
    const md = kid(el, 'MetaData');
    const inc = kid(md, 'IncludeInCompile')?.textContent;
    const item: BinderItem = {
      id, type, parent,
      title: kid(el, 'Title')?.textContent ?? '',
      children: [],
      created: scrivDateToIso(el.getAttribute('Created')),
      modified: scrivDateToIso(el.getAttribute('Modified')),
      labelId: Number(kid(md, 'LabelID')?.textContent ?? -1),
      statusId: Number(kid(md, 'StatusID')?.textContent ?? -1),
      keywords: kids(kid(el, 'Keywords'), 'KeywordID').map((k) => Number(k.textContent)),
      includeInCompile: inc ? inc === 'Yes' : type === 'Text' || type === 'Folder',
      synopsis: '',
      wordCount: 0,
      pageBreakBefore: kid(md, 'PageBreakBefore')?.textContent === 'Yes',
      expanded: type === 'DraftFolder',
    };
    const fileExt = kid(md, 'FileExtension')?.textContent;
    if (fileExt) item.fileExt = fileExt;
    items[id] = item;
    for (const c of kids(kid(el, 'Children'), 'BinderItem')) item.children.push(walk(c, id));
    return id;
  };
  for (const el of kids(kid(root, 'Binder'), 'BinderItem')) rootIds.push(walk(el, null));

  const labels: Label[] = kids(kid(kid(root, 'LabelSettings'), 'Labels'), 'Label').map((l) => ({
    id: Number(l.getAttribute('ID')), title: l.textContent ?? '', color: colorFromScriv(l.getAttribute('Color')),
  }));
  const statuses: Status[] = kids(kid(kid(root, 'StatusSettings'), 'StatusItems'), 'Status').map((s) => ({
    id: Number(s.getAttribute('ID')), title: s.textContent ?? '',
  }));
  const keywords: Keyword[] = kids(kid(root, 'Keywords'), 'Keyword').map((k) => ({
    id: Number(k.getAttribute('ID')), title: kid(k, 'Title')?.textContent ?? '', color: colorFromScriv(kid(k, 'Color')?.textContent ?? null),
  }));
  const pt = kid(root, 'ProjectTargets');
  const targets = {
    draft: Number(kid(pt, 'DraftTarget')?.textContent ?? 0) || 0,
    session: Number(kid(pt, 'SessionTarget')?.textContent ?? 0) || 0,
    deadline: kid(pt, 'Deadline')?.textContent || undefined,
  };
  return { author: root.getAttribute('Author') ?? '', rootIds, items, labels, statuses, keywords, targets, version };
}

export function newScrivxTemplate(author = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ScrivenerProject Template="No" Version="2.0" Identifier="${crypto.randomUUID().toUpperCase()}" Creator="Inkwell-1.0" Device="Inkwell" Author="${escAttr(author)}">
    <Binder/>
    <LabelSettings><Title>Label</Title><DefaultLabelID>-1</DefaultLabelID><Labels/></LabelSettings>
    <StatusSettings><Title>Status</Title><DefaultStatusID>-1</DefaultStatusID><StatusItems/></StatusSettings>
    <ProjectTargets Notify="No"><DraftTarget Type="Words" CountIncludedOnly="Yes" CurrentCompileGroupOnly="No">0</DraftTarget><SessionTarget Type="Words" Reset="Midnight" AllowNegatives="No" CountDraftOnly="Yes">0</SessionTarget></ProjectTargets>
</ScrivenerProject>
`;
}
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Rewrite the binder & settings of `origXml` to match `project`. */
export function updateScrivx(origXml: string | null, project: Project): string {
  const xml = origXml ?? newScrivxTemplate(project.author);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const ensure = (parent: Element, tag: string, before?: Element | null) => {
    let e = kid(parent, tag);
    if (!e) {
      e = doc.createElement(tag);
      if (before) parent.insertBefore(e, before); else parent.appendChild(e);
    }
    return e;
  };
  const setText = (parent: Element, tag: string, value: string) => { ensure(parent, tag).textContent = value; };

  const binder = ensure(root, 'Binder', root.firstElementChild);
  const orig = new Map<string, Element>();
  for (const el of Array.from(binder.getElementsByTagName('BinderItem'))) {
    const id = (el.getAttribute('UUID') ?? el.getAttribute('ID') ?? '').toUpperCase();
    if (id) orig.set(id, el);
  }

  const build = (id: string): Element => {
    const it = project.items[id];
    const o = orig.get(id);
    const el = o ? (o.cloneNode(true) as Element) : doc.createElement('BinderItem');
    const oldChildren = kid(el, 'Children');
    if (oldChildren) el.removeChild(oldChildren);
    el.setAttribute('UUID', id);
    el.removeAttribute('ID');
    el.setAttribute('Type', it.type);
    if (!el.getAttribute('Created')) el.setAttribute('Created', isoToScrivDate(it.created));
    el.setAttribute('Modified', isoToScrivDate(it.modified));
    setText(el, 'Title', it.title);
    const md = ensure(el, 'MetaData');
    setText(md, 'IncludeInCompile', it.includeInCompile ? 'Yes' : 'No');
    const setOpt = (tag: string, v: number) => {
      if (v >= 0) setText(md, tag, String(v));
      else { const e = kid(md, tag); if (e) md.removeChild(e); }
    };
    setOpt('LabelID', it.labelId);
    setOpt('StatusID', it.statusId);
    if (it.pageBreakBefore) setText(md, 'PageBreakBefore', 'Yes');
    else { const e = kid(md, 'PageBreakBefore'); if (e) md.removeChild(e); }
    const oldKw = kid(el, 'Keywords');
    if (oldKw) el.removeChild(oldKw);
    if (it.keywords.length) {
      const kw = doc.createElement('Keywords');
      for (const k of it.keywords) { const e = doc.createElement('KeywordID'); e.textContent = String(k); kw.appendChild(e); }
      el.appendChild(kw);
    }
    if (it.children.length) {
      const ch = doc.createElement('Children');
      for (const c of it.children) if (project.items[c]) ch.appendChild(build(c));
      el.appendChild(ch);
    }
    return el;
  };
  while (binder.firstChild) binder.removeChild(binder.firstChild);
  for (const id of project.rootIds) if (project.items[id]) binder.appendChild(build(id));

  // Labels
  const ls = ensure(root, 'LabelSettings');
  const labelsEl = ensure(ls, 'Labels');
  while (labelsEl.firstChild) labelsEl.removeChild(labelsEl.firstChild);
  for (const l of project.labels) {
    const e = doc.createElement('Label');
    e.setAttribute('ID', String(l.id));
    if (l.color) e.setAttribute('Color', colorToScriv(l.color));
    e.textContent = l.title;
    labelsEl.appendChild(e);
  }
  const ss = ensure(root, 'StatusSettings');
  const stEl = ensure(ss, 'StatusItems');
  while (stEl.firstChild) stEl.removeChild(stEl.firstChild);
  for (const s of project.statuses) {
    const e = doc.createElement('Status');
    e.setAttribute('ID', String(s.id));
    e.textContent = s.title;
    stEl.appendChild(e);
  }
  if (project.keywords.length || kid(root, 'Keywords')) {
    const kwEl = ensure(root, 'Keywords');
    while (kwEl.firstChild) kwEl.removeChild(kwEl.firstChild);
    for (const k of project.keywords) {
      const e = doc.createElement('Keyword');
      e.setAttribute('ID', String(k.id));
      const t = doc.createElement('Title'); t.textContent = k.title; e.appendChild(t);
      if (k.color) { const c = doc.createElement('Color'); c.textContent = colorToScriv(k.color); e.appendChild(c); }
      kwEl.appendChild(e);
    }
  }
  const pt = ensure(root, 'ProjectTargets');
  setText(pt, 'DraftTarget', String(project.targets.draft || 0));
  setText(pt, 'SessionTarget', String(project.targets.session || 0));

  let out = new XMLSerializer().serializeToString(doc);
  if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + out;
  return out;
}
