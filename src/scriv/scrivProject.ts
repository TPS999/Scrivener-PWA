// Converting between a .scriv package (a map of relative paths -> bytes) and
// Inkwell's project model.

import { unzipSync, zipSync } from 'fflate';
import { type BinderItem, type DocData, type PMNode, type Project, DEFAULT_LABELS, DEFAULT_STATUSES, emptyDoc, isTextual, nowIso, uuid } from '../model/types';
import { buildCommentsXml, countWords, docPlainText, docToRtf, encodeLatin1, parseCommentsXml, rtfToDoc } from './rtf';
import { parseScrivx, updateScrivx } from './scrivx';

export type FileMap = Map<string, Uint8Array>;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export const dataDir = (id: string) => `Files/Data/${id}`;
export const DOC_FILES = ['content.rtf', 'notes.rtf', 'synopsis.txt', 'content.comments'] as const;

/** Normalises a zip / folder listing so paths are relative to the .scriv root. */
export function normaliseScrivFiles(input: Record<string, Uint8Array>): { files: FileMap; name: string } {
  const paths = Object.keys(input).filter((p) => !p.endsWith('/') && !p.includes('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(p));
  const scrivx = paths.find((p) => /\.scrivx$/i.test(p));
  if (!scrivx) throw new Error('No .scrivx file found. Make sure you picked a Scrivener project (.scriv) or a zip of one.');
  const prefix = scrivx.includes('/') ? scrivx.slice(0, scrivx.lastIndexOf('/') + 1) : '';
  const files: FileMap = new Map();
  for (const p of paths) if (p.startsWith(prefix)) files.set(p.slice(prefix.length), input[p]);
  const name = scrivx.slice(prefix.length).replace(/\.scrivx$/i, '');
  return { files, name };
}

export function unzipScriv(zip: Uint8Array) {
  return normaliseScrivFiles(unzipSync(zip));
}

export function findScrivx(files: FileMap) {
  for (const k of files.keys()) if (!k.includes('/') && /\.scrivx$/i.test(k)) return k;
  return null;
}

export function getFile(files: FileMap, path: string) {
  // Dropbox & zips can disagree on case; Scrivener paths are case-insensitive on macOS
  const direct = files.get(path);
  if (direct) return direct;
  const lower = path.toLowerCase();
  for (const [k, v] of files) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function docFromFiles(projectId: string, item: BinderItem, files: FileMap): { doc: DocData; synopsis: string; lossy: string[] } {
  const dir = dataDir(item.id);
  const commentsRaw = getFile(files, `${dir}/content.comments`);
  const comments = commentsRaw ? parseCommentsXml(utf8d.decode(commentsRaw)) : new Map();
  const contentRaw = getFile(files, `${dir}/content.rtf`);
  const notesRaw = getFile(files, `${dir}/notes.rtf`);
  const synRaw = getFile(files, `${dir}/synopsis.txt`);
  let content: PMNode = emptyDoc();
  let style;
  let lossy: string[] = [];
  if (contentRaw) {
    const r = rtfToDoc(contentRaw, comments);
    content = r.doc; style = r.style; lossy = r.lossy;
  }
  const notes = notesRaw ? rtfToDoc(notesRaw).doc : emptyDoc();
  return {
    doc: {
      key: `${projectId}:${item.id}`, projectId, itemId: item.id, content, notes,
      contentDirty: false, notesDirty: false, rtfPrefix: style, modified: item.modified,
      lossy: lossy.length ? lossy : undefined,
    } as DocData,
    synopsis: synRaw ? utf8d.decode(synRaw).trim() : '',
    lossy,
  };
}

export function importScriv(files: FileMap, fallbackName: string, projectId = uuid()): { project: Project; docs: DocData[]; scrivxName: string } {
  const scrivxName = findScrivx(files);
  if (!scrivxName) throw new Error('No .scrivx file found in the project.');
  const parsed = parseScrivx(utf8d.decode(files.get(scrivxName)!));
  const docs: DocData[] = [];
  for (const item of Object.values(parsed.items)) {
    // research files: detect content.<ext>
    if (!isTextual(item.type) && !item.fileExt) {
      const prefix = `${dataDir(item.id)}/content.`.toLowerCase();
      for (const k of files.keys()) if (k.toLowerCase().startsWith(prefix)) item.fileExt = k.slice(prefix.length);
    }
    if (!isTextual(item.type)) {
      if (item.type === 'TrashFolder') continue;
      const syn = getFile(files, `${dataDir(item.id)}/synopsis.txt`);
      if (syn) item.synopsis = utf8d.decode(syn).trim();
      continue;
    }
    const { doc, synopsis } = docFromFiles(projectId, item, files);
    item.synopsis = synopsis;
    item.wordCount = countWords(docPlainText(doc.content));
    docs.push(doc);
  }
  const now = nowIso();
  const project: Project = {
    id: projectId,
    title: scrivxName.replace(/\.scrivx$/i, '') || fallbackName,
    author: parsed.author,
    created: now,
    modified: now,
    rootIds: parsed.rootIds,
    items: parsed.items,
    labels: parsed.labels.length ? parsed.labels : DEFAULT_LABELS,
    statuses: parsed.statuses.length ? parsed.statuses : DEFAULT_STATUSES,
    keywords: parsed.keywords,
    targets: parsed.targets,
    scriv: { scrivxName },
  };
  ensureSpecialFolders(project);
  return { project, docs, scrivxName };
}

export function ensureSpecialFolders(p: Project) {
  const has = (t: string) => p.rootIds.find((id) => p.items[id]?.type === t);
  const mk = (type: BinderItem['type'], title: string) => {
    const id = uuid();
    const now = nowIso();
    p.items[id] = { id, type, title, parent: null, children: [], created: now, modified: now, labelId: -1, statusId: -1, keywords: [], includeInCompile: type === 'DraftFolder', synopsis: '', wordCount: 0, expanded: type === 'DraftFolder' };
    return id;
  };
  if (!has('DraftFolder')) p.rootIds.unshift(mk('DraftFolder', 'Draft'));
  if (!has('ResearchFolder')) p.rootIds.splice(1, 0, mk('ResearchFolder', 'Research'));
  if (!has('TrashFolder')) p.rootIds.push(mk('TrashFolder', 'Trash'));
}

/** Files that represent one document in a .scriv package. */
export function renderDocFiles(item: BinderItem, doc: DocData | undefined): Record<string, Uint8Array | null> {
  const dir = dataDir(item.id);
  const out: Record<string, Uint8Array | null> = {};
  out[`${dir}/synopsis.txt`] = item.synopsis ? utf8.encode(item.synopsis) : null;
  if (doc) {
    const { rtf, comments } = docToRtf(doc.content, doc.rtfPrefix);
    out[`${dir}/content.rtf`] = encodeLatin1(rtf);
    out[`${dir}/content.comments`] = comments.length ? utf8.encode(buildCommentsXml(comments)) : null;
    const notesText = docPlainText(doc.notes);
    out[`${dir}/notes.rtf`] = notesText.trim() ? encodeLatin1(docToRtf(doc.notes).rtf) : null;
  }
  return out;
}

export function renderContentFiles(item: BinderItem, doc: DocData) {
  const all = renderDocFiles(item, doc);
  const dir = dataDir(item.id);
  return { [`${dir}/content.rtf`]: all[`${dir}/content.rtf`], [`${dir}/content.comments`]: all[`${dir}/content.comments`] };
}
export function renderNotesFiles(item: BinderItem, doc: DocData) {
  const all = renderDocFiles(item, doc);
  const dir = dataDir(item.id);
  return { [`${dir}/notes.rtf`]: all[`${dir}/notes.rtf`] };
}

/**
 * Builds a complete .scriv package. Untouched documents keep their original
 * bytes; only edited documents are re-serialised.
 */
export function buildScrivPackage(project: Project, docs: Map<string, DocData>, raw: FileMap): FileMap {
  const out: FileMap = new Map(raw);
  const scrivxName = project.scriv?.scrivxName ?? `${project.title}.scrivx`;
  const origXml = raw.get(scrivxName) ? utf8d.decode(raw.get(scrivxName)!) : null;
  out.set(scrivxName, utf8.encode(updateScrivx(origXml, project)));
  if (!origXml) {
    out.set('Files/version.txt', utf8.encode('23'));
  }
  for (const item of Object.values(project.items)) {
    const doc = docs.get(item.id);
    const dir = dataDir(item.id);
    const files = renderDocFiles(item, doc);
    const writeIf = (path: string, cond: boolean) => {
      if (!cond) return;
      const v = files[path];
      if (v) out.set(path, v); else out.delete(path);
    };
    writeIf(`${dir}/synopsis.txt`, true);
    if (doc) {
      const hasRaw = raw.has(`${dir}/content.rtf`);
      writeIf(`${dir}/content.rtf`, doc.contentDirty || !hasRaw);
      writeIf(`${dir}/content.comments`, doc.contentDirty || !hasRaw);
      writeIf(`${dir}/notes.rtf`, doc.notesDirty || !raw.has(`${dir}/notes.rtf`));
    }
  }
  // Remove data folders of items that no longer exist (emptied trash)
  for (const k of [...out.keys()]) {
    const m = /^Files\/Data\/([^/]+)\//.exec(k);
    if (m && !project.items[m[1].toUpperCase()] && !project.items[m[1]]) out.delete(k);
  }
  return out;
}

export function zipScriv(project: Project, files: FileMap): Uint8Array {
  const root = `${project.title.replace(/[\\/:*?"<>|]/g, '_')}.scriv/`;
  const obj: Record<string, Uint8Array> = {};
  for (const [k, v] of files) obj[root + k] = v;
  return zipSync(obj, { level: 6 });
}
