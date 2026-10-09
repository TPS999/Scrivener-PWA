import type { DocData, PMNode, Project } from '../model/types';
import { countWords, docPlainText } from '../scriv/rtf';
import { buildScrivPackage, importScriv } from '../scriv/scrivProject';
import * as store from '../store/db';
import type { Session } from '../store/session';
import * as dbx from './dropbox';
import { type BaseRec, type LocalStore, type RemoteFS, type SyncReport, fetchWholeProject, syncProject } from './syncEngine';

export function dropboxRemote(root: string): RemoteFS {
  const rootLower = root.toLowerCase().replace(/\/$/, '');
  const rel = (p: string) => p.slice(rootLower.length + 1);
  return {
    async list() {
      const entries = await dbx.listFolder(root, true);
      return entries
        .filter((e) => e.tag === 'file' && e.pathLower.startsWith(rootLower + '/'))
        .map((e) => ({ path: rel(e.path), rev: e.rev!, hash: e.hash!, size: e.size ?? 0 }));
    },
    async download(p) { const r = await dbx.download(`${root}/${p}`); return { data: r.data, rev: r.meta.rev!, hash: r.meta.hash! }; },
    async upload(p, data, baseRev) { const r = await dbx.upload(`${root}/${p}`, data, baseRev); return { rev: r.rev!, hash: r.hash! }; },
    async remove(p, rev) { await dbx.remove(`${root}/${p}`, rev); },
  };
}

function idbLocal(projectId: string, session?: Session): LocalStore {
  return {
    async getDoc(id) { return session ? session.loadDoc(id) : store.getDoc(projectId, id); },
    async putDoc(d) { if (session) await session.replaceDoc(d); else await store.putDoc(d); },
    getRaw: (p) => store.getRaw(projectId, p),
    putRaw: (p, d) => store.putRaw(projectId, p, d),
    deleteRaw: (p) => store.deleteRaw(projectId, p),
    async getBase() {
      const all = await (await store.db()).getAllFromIndex('syncbase', 'byProject', projectId);
      return new Map(all.map((b) => [b.path.toLowerCase(), { path: b.path, rev: b.rev, hash: b.hash }]));
    },
    async putBase(r: BaseRec) { await (await store.db()).put('syncbase', { key: store.rawKey(projectId, r.path), projectId, ...r }); },
    async deleteBase(p) { await (await store.db()).delete('syncbase', store.rawKey(projectId, p)); },
    async snapshot(doc: DocData, title: string, content: PMNode, kind) {
      await store.addSnapshot({ docKey: doc.key, title, date: new Date().toISOString(), content, kind, words: countWords(docPlainText(content)) });
    },
    async saveProject(p: Project) { if (session) { session.emit(); await session.flush(); } else await store.putProject(p); },
  };
}

export async function openFromDropbox(path: string, onProgress: (m: string) => void): Promise<string> {
  const remote = dropboxRemote(path);
  const { files, base, lockFile } = await fetchWholeProject(remote, onProgress);
  const name = path.split('/').pop()!.replace(/\.scriv$/i, '');
  const { project, docs } = importScriv(files, name);
  project.scriv!.dropboxPath = path;
  project.scriv!.lastSync = new Date().toISOString();
  onProgress('Saving to this device…');
  const d = await store.db();
  const tx = d.transaction(['projects', 'docs', 'raw', 'syncbase'], 'readwrite');
  await tx.objectStore('projects').put(project);
  for (const doc of docs) await tx.objectStore('docs').put(doc);
  for (const [p, data] of files) await tx.objectStore('raw').put({ key: store.rawKey(project.id, p), projectId: project.id, path: p, data });
  for (const b of base) await tx.objectStore('syncbase').put({ key: store.rawKey(project.id, b.path), projectId: project.id, ...b });
  await tx.done;
  if (lockFile) onProgress('Note: this project seems to be open in Scrivener on another device.');
  return project.id;
}

let running: Promise<SyncReport> | null = null;

export async function syncSession(session: Session, opts: { ignoreLock?: boolean } = {}): Promise<SyncReport> {
  if (running) return running;
  const p = session.project;
  if (!p.scriv?.dropboxPath) throw new Error('This project is not linked to Dropbox.');
  session.syncing = true;
  session.emit();
  running = (async () => {
    try {
      await session.flush();
      window.dispatchEvent(new Event('inkwell:flush'));
      await new Promise((r) => setTimeout(r, 50));
      return await syncProject(p, idbLocal(p.id, session), dropboxRemote(p.scriv!.dropboxPath!), {
        ignoreLock: opts.ignoreLock,
        onProgress: (m) => { session.syncMessage = m; session.emit(); },
      });
    } finally {
      session.syncing = false;
      session.syncMessage = '';
      await session.flush();
      session.emit();
      running = null;
    }
  })();
  return running;
}

/** Uploads a project that only exists on this device to Dropbox as a new .scriv. */
export async function publishToDropbox(session: Session, folder: string, onProgress: (m: string) => void) {
  const p = session.project;
  const path = `${folder.replace(/\/$/, '')}/${p.title.replace(/[\\/:*?"<>|]/g, '_')}.scriv`;
  const existing = await dbx.listFolder(folder).catch(() => []);
  if (existing.some((e) => e.pathLower === path.toLowerCase())) throw new Error(`${path} already exists in Dropbox. Rename the project first.`);
  const docs = new Map<string, DocData>();
  for (const id of Object.keys(p.items)) { const d = await session.loadDoc(id); if (d) docs.set(id, d); }
  const rawList = await store.listRaw(p.id);
  const raw = new Map(rawList.map((r) => [r.path, r.data]));
  if (!p.scriv) p.scriv = { scrivxName: `${p.title}.scrivx` };
  const files = buildScrivPackage(p, docs, raw);
  const local = idbLocal(p.id, session);
  let k = 0;
  for (const [rel, data] of files) {
    if (rel.endsWith('.scrivx')) continue;
    const up = await dbx.upload(`${path}/${rel}`, data, null);
    await local.putRaw(rel, data);
    await local.putBase({ path: rel, rev: up.rev!, hash: up.hash! });
    onProgress(`Uploading ${++k}/${files.size}…`);
  }
  const sxName = [...files.keys()].find((k2) => k2.endsWith('.scrivx'))!;
  const up = await dbx.upload(`${path}/${sxName}`, files.get(sxName)!, null);
  await local.putRaw(sxName, files.get(sxName)!);
  await local.putBase({ path: sxName, rev: up.rev!, hash: up.hash! });
  for (const d of docs.values()) { d.contentDirty = false; d.notesDirty = false; await store.putDoc(d); }
  session.update((pp) => { pp.scriv = { scrivxName: sxName, dropboxPath: path, lastSync: new Date().toISOString() }; pp.binderDirty = false; }, false);
  await session.flush();
  return path;
}

export async function loadResearchFile(session: Session, itemId: string): Promise<Uint8Array | undefined> {
  const it = session.project.items[itemId];
  const rel = `Files/Data/${itemId}/content.${it.fileExt ?? ''}`;
  let data = await store.getRaw(session.project.id, rel);
  if (!data && session.project.scriv?.dropboxPath) {
    data = (await dbx.download(`${session.project.scriv.dropboxPath}/${rel}`)).data;
    await store.putRaw(session.project.id, rel, data);
  }
  return data;
}
