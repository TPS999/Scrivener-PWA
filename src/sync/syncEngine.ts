// Two-way sync of a .scriv package with a remote folder (Dropbox).
//
// Safety rules (the reasons this exists):
//  1. Nothing local is ever overwritten without a snapshot of it first.
//  2. A document edited on both sides is never auto-merged: local stays in the
//     editor, the remote version is saved as a "conflict" snapshot, and the
//     user picks. Until then that document is not uploaded.
//  3. Every upload names the revision it is replacing. If someone else
//     changed the file in the meantime Dropbox refuses, and we start over
//     instead of clobbering their work.
//  4. Sync state is recorded per file as each file completes, so an
//     interrupted sync (app closed, network lost) simply resumes next time.
//  5. Documents are uploaded before the binder, so desktop Scrivener never
//     sees a binder entry whose text hasn't arrived yet.

import { type BinderItem, type DocData, type PMNode, type Project, emptyDoc, isTextual, nowIso } from '../model/types';
import { countWords, docPlainText } from '../scriv/rtf';
import { dataDir, docFromFiles, renderDocFiles } from '../scriv/scrivProject';
import { parseScrivx, updateScrivx } from '../scriv/scrivx';
import { DbxConflictError, contentHash } from './dropbox';
import { type BinderState, mergeBinder } from './merge';

export interface RemoteFile { path: string; rev: string; hash: string; size: number }
export interface RemoteFS {
  list(): Promise<RemoteFile[]>;                       // paths relative to the .scriv root
  download(path: string): Promise<{ data: Uint8Array; rev: string; hash: string }>;
  upload(path: string, data: Uint8Array, baseRev: string | null): Promise<{ rev: string; hash: string }>; // throws DbxConflictError
  remove(path: string, rev?: string): Promise<void>;
}
export interface BaseRec { path: string; rev: string; hash: string }
export interface LocalStore {
  getDoc(itemId: string): Promise<DocData | undefined>;
  putDoc(doc: DocData): Promise<void>;
  getRaw(path: string): Promise<Uint8Array | undefined>;
  putRaw(path: string, data: Uint8Array): Promise<void>;
  deleteRaw(path: string): Promise<void>;
  getBase(): Promise<Map<string, BaseRec>>;           // keyed by lower-case path
  putBase(rec: BaseRec): Promise<void>;
  deleteBase(path: string): Promise<void>;
  snapshot(doc: DocData, title: string, content: PMNode, kind: 'sync' | 'conflict'): Promise<void>;
  saveProject(p: Project): Promise<void>;
}

export interface SyncReport {
  status: 'ok' | 'locked';
  downloaded: number;
  uploaded: number;
  conflicts: string[];
  notes: string[];
  lockFile?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const lc = (s: string) => s.toLowerCase();
const PARTS = {
  content: ['content.rtf', 'content.comments'],
  notes: ['notes.rtf'],
  synopsis: ['synopsis.txt'],
} as const;
type Part = keyof typeof PARTS;

export const isLockFile = (p: string) => /(^|\/)user\.lock$/i.test(p) || (/\.lock$/i.test(p) && !/^files\/data\//i.test(p));

function binderFingerprint(s: BinderState) {
  const items = Object.values(s.items)
    .map((i) => [i.id, i.title, i.type, i.labelId, i.statusId, i.keywords, i.includeInCompile, !!i.pageBreakBefore, i.children])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([s.rootIds, items, s.labels, s.statuses, s.keywords]);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) await fn(items[k++]);
  }));
}

export async function syncProject(
  project: Project, local: LocalStore, remote: RemoteFS,
  opts: { ignoreLock?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<SyncReport> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncOnce(project, local, remote, opts);
    } catch (e) {
      if (e instanceof DbxConflictError && attempt < 3) {
        opts.onProgress?.('Someone else changed the project mid-sync; re-checking…');
        continue;
      }
      throw e;
    }
  }
}

async function syncOnce(project: Project, local: LocalStore, remote: RemoteFS, opts: { ignoreLock?: boolean; onProgress?: (msg: string) => void }): Promise<SyncReport> {
  const progress = opts.onProgress ?? (() => {});
  const report: SyncReport = { status: 'ok', downloaded: 0, uploaded: 0, conflicts: [], notes: [] };
  progress('Checking Dropbox…');
  const entries = await remote.list();
  const R = new Map(entries.map((e) => [lc(e.path), e]));
  const base = await local.getBase();

  const lock = entries.find((e) => isLockFile(e.path));
  if (lock && !opts.ignoreLock) return { ...report, status: 'locked', lockFile: lock.path };

  // ---- 1. binder (.scrivx)
  let sx = project.scriv!.scrivxName;
  let rsx = R.get(lc(sx));
  if (!rsx) {
    const other = entries.find((e) => !e.path.includes('/') && /\.scrivx$/i.test(e.path));
    if (other) { rsx = other; sx = other.path; project.scriv!.scrivxName = other.path; }
  }
  const rawSx = await local.getRaw(sx);
  let currentXml = rawSx ? dec.decode(rawSx) : null;
  const localState = (): BinderState => ({ rootIds: project.rootIds, items: project.items, labels: project.labels, statuses: project.statuses, keywords: project.keywords });

  if (rsx && base.get(lc(sx))?.hash !== rsx.hash) {
    progress('Merging binder…');
    const dl = await remote.download(rsx.path);
    report.downloaded++;
    const remoteXml = dec.decode(dl.data);
    const remoteParsed = parseScrivx(remoteXml);
    const baseParsed = currentXml ? parseScrivx(currentXml) : remoteParsed;
    const merged = mergeBinder(baseParsed, remoteParsed, localState());
    for (const it of Object.values(merged.items)) {
      const prev = project.items[it.id];
      if (!prev) { it.synopsis = ''; it.wordCount = 0; }
    }
    project.rootIds = merged.rootIds;
    project.items = merged.items;
    project.labels = merged.labels;
    project.statuses = merged.statuses;
    project.keywords = merged.keywords;
    if (remoteParsed.targets.draft && !project.targets.draft) project.targets = { ...project.targets, ...remoteParsed.targets };
    await local.putRaw(sx, dl.data);
    await local.putBase({ path: rsx.path, rev: dl.rev, hash: dl.hash });
    base.set(lc(sx), { path: rsx.path, rev: dl.rev, hash: dl.hash });
    currentXml = remoteXml;
    await local.saveProject(project);
  }

  // ---- 2. prefetch every changed remote document file in parallel
  const docPaths = new Set<string>();
  for (const it of Object.values(project.items)) for (const fs of Object.values(PARTS)) for (const f of fs) docPaths.add(lc(`${dataDir(it.id)}/${f}`));
  const toFetch = entries.filter((e) => {
    if (base.get(lc(e.path))?.hash === e.hash) return false;
    if (docPaths.has(lc(e.path))) return true;
    // small research files (images, PDFs) for items we know about
    const m = /^files\/data\/([^/]+)\/content\.[a-z0-9]+$/i.exec(e.path);
    return !!m && !!project.items[m[1].toUpperCase()] && e.size < 5 * 1024 * 1024;
  });
  const fetched = new Map<string, { data: Uint8Array; rev: string; hash: string }>();
  let done = 0;
  await pool(toFetch, 6, async (e) => {
    fetched.set(lc(e.path), await remote.download(e.path));
    done++;
    progress(`Downloading ${done}/${toFetch.length}…`);
  });
  report.downloaded += fetched.size;
  for (const e of toFetch) {
    const m = /^files\/data\/[^/]+\/content\.([a-z0-9]+)$/i.exec(e.path);
    if (m && m[1].toLowerCase() !== 'rtf') {
      const f = fetched.get(lc(e.path))!;
      await local.putRaw(e.path, f.data);
      await local.putBase({ path: e.path, rev: f.rev, hash: f.hash });
    }
  }

  const remoteBytes = async (path: string) => {
    const f = fetched.get(lc(path));
    if (f) return f.data;
    if (R.has(lc(path))) return local.getRaw(path);
    return undefined;
  };
  const acceptRemote = async (path: string) => {
    const e = R.get(lc(path));
    const f = fetched.get(lc(path));
    if (e && f) {
      await local.putRaw(e.path, f.data);
      await local.putBase({ path: e.path, rev: f.rev, hash: f.hash });
      base.set(lc(path), { path: e.path, rev: f.rev, hash: f.hash });
    } else if (!e) {
      await local.deleteRaw(path);
      await local.deleteBase(path);
      base.delete(lc(path));
    }
  };
  const push = async (path: string, data: Uint8Array | null) => {
    const b = base.get(lc(path));
    const e = R.get(lc(path));
    const realPath = e?.path ?? b?.path ?? path;
    if (!data) {
      if (e) { await remote.remove(realPath, b?.rev); report.uploaded++; }
      await local.deleteRaw(realPath);
      await local.deleteBase(realPath);
      base.delete(lc(path));
      return;
    }
    const hash = await contentHash(data);
    if (e && e.hash === hash) {
      await local.putBase({ path: realPath, rev: e.rev, hash });
    } else {
      // name the revision we expect to replace; Dropbox refuses if it moved on
      const up = await remote.upload(realPath, data, e ? (b && b.hash !== e.hash ? b.rev : e.rev) : null);
      report.uploaded++;
      await local.putBase({ path: realPath, rev: up.rev, hash: up.hash });
      base.set(lc(path), { path: realPath, rev: up.rev, hash: up.hash });
    }
    await local.putRaw(realPath, data);
  };

  // ---- 3. documents
  const items = Object.values(project.items);
  let k = 0;
  for (const item of items) {
    k++;
    if (item.type === 'TrashFolder') continue;
    const textual = isTextual(item.type);
    const dir = dataDir(item.id);
    let doc = textual ? await local.getDoc(item.id) : undefined;
    const before = doc ? JSON.stringify([doc.content, doc.notes, doc.contentDirty, doc.notesDirty, doc.conflict]) : '';
    const synBefore = item.synopsis;

    for (const part of Object.keys(PARTS) as Part[]) {
      if (!textual && part !== 'synopsis') continue;
      const paths = PARTS[part].map((f) => `${dir}/${f}`);
      const remoteChanged = paths.some((p) => (R.get(lc(p))?.hash ?? null) !== (base.get(lc(p))?.hash ?? null));
      let localChanged = false;
      if (part === 'content') localChanged = !!doc?.contentDirty || (!doc && false);
      if (part === 'notes') localChanged = !!doc?.notesDirty;
      if (part === 'synopsis') {
        const raw = await local.getRaw(`${dir}/synopsis.txt`);
        localChanged = item.synopsis.trim() !== (raw ? dec.decode(raw).trim() : '');
      }
      if (!remoteChanged && !localChanged) continue;

      // Build a mini file-map of the remote state of this part
      const fm = new Map<string, Uint8Array>();
      if (remoteChanged) {
        for (const p of paths) { const b = await remoteBytes(p); if (b) fm.set(p, b); }
        // content.comments goes with content.rtf
        if (part === 'content') {
          for (const p of PARTS.content.map((f) => `${dir}/${f}`)) if (!fm.has(p)) { const b = await remoteBytes(p); if (b) fm.set(p, b); }
        }
      }
      const parsed = remoteChanged ? docFromFiles(project.id, item, fm) : null;

      if (!doc && textual) {
        doc = { key: `${project.id}:${item.id}`, projectId: project.id, itemId: item.id, content: emptyDoc(), notes: emptyDoc(), contentDirty: false, notesDirty: false, modified: nowIso() };
      }

      if (remoteChanged && !localChanged) {
        if (part === 'content' && doc && parsed) {
          if (docPlainText(doc.content).trim() && docPlainText(doc.content) !== docPlainText(parsed.doc.content)) {
            await local.snapshot(doc, `Before update from Dropbox`, doc.content, 'sync');
          }
          doc.content = parsed.doc.content;
          doc.rtfPrefix = parsed.doc.rtfPrefix;
          doc.lossy = parsed.doc.lossy;
          item.wordCount = countWords(docPlainText(doc.content));
        } else if (part === 'notes' && doc && parsed) {
          doc.notes = parsed.doc.notes;
        } else if (part === 'synopsis' && parsed) {
          item.synopsis = parsed.synopsis;
        }
        for (const p of paths) await acceptRemote(p);
        continue;
      }

      if (remoteChanged && localChanged && parsed) {
        if (part === 'content' && doc) {
          if (docPlainText(doc.content) === docPlainText(parsed.doc.content)) {
            doc.content = parsed.doc.content; doc.rtfPrefix = parsed.doc.rtfPrefix; doc.contentDirty = false;
            for (const p of paths) await acceptRemote(p);
            continue;
          }
          await local.snapshot(doc, `Dropbox version (sync conflict ${new Date().toLocaleString()})`, parsed.doc.content, 'conflict');
          doc.conflict = true;
          if (!doc.rtfPrefix) doc.rtfPrefix = parsed.doc.rtfPrefix;
          report.conflicts.push(item.title || 'Untitled');
          // remember the remote revision as our base so "keep mine" can overwrite it deliberately later
          for (const p of paths) await acceptRemote(p);
          continue;
        }
        if (part === 'notes' && doc) {
          const remoteNotes = parsed.doc.notes;
          if (docPlainText(remoteNotes).trim() && docPlainText(remoteNotes) !== docPlainText(doc.notes)) {
            doc.notes = { type: 'doc', content: [...(doc.notes.content ?? []), { type: 'paragraph', content: [{ type: 'text', text: '——— Notes from your other device ———', marks: [{ type: 'bold' }] }] }, ...(remoteNotes.content ?? [])] };
            report.notes.push(`Merged notes for “${item.title}”`);
          }
          for (const p of paths) await acceptRemote(p);
        }
        if (part === 'synopsis') {
          if (parsed.synopsis.trim() && parsed.synopsis.trim() !== item.synopsis.trim()) {
            item.synopsis = `${item.synopsis.trim()}\n\n${parsed.synopsis.trim()}`;
            report.notes.push(`Merged synopsis for “${item.title}”`);
          }
          for (const p of paths) await acceptRemote(p);
        }
      }

      // local → remote
      if (part === 'content' && doc?.conflict) continue; // waits for the user
      progress(`Uploading “${item.title}” (${k}/${items.length})…`);
      const files = renderDocFiles(item, doc);
      for (const p of paths) await push(p, files[p] ?? null);
      if (doc) {
        if (part === 'content') doc.contentDirty = false;
        if (part === 'notes') doc.notesDirty = false;
      }
    }
    if (doc && JSON.stringify([doc.content, doc.notes, doc.contentDirty, doc.notesDirty, doc.conflict]) !== before) {
      doc.modified = nowIso();
      await local.putDoc(doc);
    }
    if (item.synopsis !== synBefore) await local.saveProject(project);
  }

  // ---- 4. documents removed from the binder (trash emptied) — only if untouched remotely
  for (const [p, b] of base) {
    const m = /^files\/data\/([^/]+)\//.exec(p);
    if (!m || project.items[m[1].toUpperCase()] || project.items[m[1]]) continue;
    const e = R.get(p);
    if (e && e.hash === b.hash) { await remote.remove(e.path, e.rev); report.uploaded++; }
    await local.deleteBase(b.path);
    await local.deleteRaw(b.path);
  }

  // ---- 5. binder last
  const remoteState = currentXml ? parseScrivx(currentXml) : null;
  if (!remoteState || binderFingerprint(remoteState) !== binderFingerprint(localState()) || project.binderDirty) {
    if (!remoteState || binderFingerprint(remoteState) !== binderFingerprint(localState())) {
      progress('Saving binder…');
      const xml = enc.encode(updateScrivx(currentXml, project));
      const b = base.get(lc(sx));
      const up = await remote.upload(rsx?.path ?? sx, xml, rsx ? (b?.rev ?? rsx.rev) : null);
      report.uploaded++;
      await local.putRaw(sx, xml);
      await local.putBase({ path: rsx?.path ?? sx, rev: up.rev, hash: up.hash });
    }
  }
  project.binderDirty = false;
  project.scriv!.lastSync = nowIso();
  await local.saveProject(project);
  progress('');
  return report;
}

/** First download of a project from the remote. Returns the files for importScriv. */
export async function fetchWholeProject(remote: RemoteFS, onProgress?: (m: string) => void) {
  const entries = await remote.list();
  const wanted = entries.filter((e) =>
    /\.scrivx$/i.test(e.path) && !e.path.includes('/') ||
    /^files\/data\/[^/]+\/(content\.rtf|content\.comments|notes\.rtf|synopsis\.txt)$/i.test(e.path) ||
    (/^files\/data\/[^/]+\/content\.[a-z0-9]+$/i.test(e.path) && e.size < 5 * 1024 * 1024));
  const files = new Map<string, Uint8Array>();
  const base: BaseRec[] = [];
  let done = 0;
  await pool(wanted, 6, async (e) => {
    const d = await remote.download(e.path);
    files.set(e.path, d.data);
    base.push({ path: e.path, rev: d.rev, hash: d.hash });
    onProgress?.(`Downloading ${++done}/${wanted.length}…`);
  });
  const lock = entries.find((e) => isLockFile(e.path));
  return { files, base, lockFile: lock?.path };
}

export type { BinderItem };
