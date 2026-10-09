import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocData, Project, Snapshot } from '../model/types';

export interface SyncBase { key: string; projectId: string; path: string; rev: string; hash: string }
export interface RawFile { key: string; projectId: string; path: string; data: Uint8Array }
export interface DayStat { key: string; projectId: string; date: string; words: number }

interface InkDB extends DBSchema {
  projects: { key: string; value: Project };
  docs: { key: string; value: DocData; indexes: { byProject: string } };
  snapshots: { key: number; value: Snapshot; indexes: { byDoc: string } };
  raw: { key: string; value: RawFile; indexes: { byProject: string } };
  syncbase: { key: string; value: SyncBase; indexes: { byProject: string } };
  stats: { key: string; value: DayStat; indexes: { byProject: string } };
  kv: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<InkDB>> | null = null;
export function db() {
  if (!dbp) {
    dbp = openDB<InkDB>('inkwell', 1, {
      upgrade(d) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('docs', { keyPath: 'key' }).createIndex('byProject', 'projectId');
        d.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }).createIndex('byDoc', 'docKey');
        d.createObjectStore('raw', { keyPath: 'key' }).createIndex('byProject', 'projectId');
        d.createObjectStore('syncbase', { keyPath: 'key' }).createIndex('byProject', 'projectId');
        d.createObjectStore('stats', { keyPath: 'key' }).createIndex('byProject', 'projectId');
        d.createObjectStore('kv');
      },
    });
    // Ask the browser not to evict our data under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbp;
}

export const docKey = (projectId: string, itemId: string) => `${projectId}:${itemId}`;
export const rawKey = (projectId: string, path: string) => `${projectId}:${path.toLowerCase()}`;

export async function kvGet<T>(k: string): Promise<T | undefined> {
  return (await (await db()).get('kv', k)) as T | undefined;
}
export async function kvSet(k: string, v: unknown) {
  await (await db()).put('kv', v, k);
}

export async function listProjects() {
  return (await db()).getAll('projects');
}
export async function getProject(id: string) {
  return (await db()).get('projects', id);
}
export async function putProject(p: Project) {
  await (await db()).put('projects', p);
}
export async function getDoc(projectId: string, itemId: string) {
  return (await db()).get('docs', docKey(projectId, itemId));
}
export async function putDoc(d: DocData) {
  await (await db()).put('docs', d);
}
export async function getRaw(projectId: string, path: string) {
  return (await (await db()).get('raw', rawKey(projectId, path)))?.data;
}
export async function putRaw(projectId: string, path: string, data: Uint8Array) {
  await (await db()).put('raw', { key: rawKey(projectId, path), projectId, path, data });
}
export async function listRaw(projectId: string) {
  return (await db()).getAllFromIndex('raw', 'byProject', projectId);
}
export async function deleteRaw(projectId: string, path: string) {
  await (await db()).delete('raw', rawKey(projectId, path));
}

export async function addSnapshot(s: Snapshot) {
  return (await db()).add('snapshots', s);
}
export async function listSnapshots(docKeyStr: string) {
  const all = await (await db()).getAllFromIndex('snapshots', 'byDoc', docKeyStr);
  return all.sort((a, b) => b.date.localeCompare(a.date));
}
export async function deleteSnapshot(id: number) {
  await (await db()).delete('snapshots', id);
}

export async function addWordsToday(projectId: string, delta: number) {
  if (!delta) return;
  const date = new Date().toLocaleDateString('en-CA');
  const key = `${projectId}:${date}`;
  const d = await db();
  const tx = d.transaction('stats', 'readwrite');
  const cur = (await tx.store.get(key)) ?? { key, projectId, date, words: 0 };
  cur.words += delta;
  await tx.store.put(cur);
  await tx.done;
}
export async function listStats(projectId: string) {
  return (await db()).getAllFromIndex('stats', 'byProject', projectId);
}

export async function deleteProject(id: string) {
  const d = await db();
  const tx = d.transaction(['projects', 'docs', 'raw', 'syncbase', 'stats', 'snapshots'], 'readwrite');
  await tx.objectStore('projects').delete(id);
  for (const s of ['docs', 'raw', 'syncbase', 'stats'] as const) {
    const keys = await tx.objectStore(s).index('byProject').getAllKeys(id);
    for (const k of keys) await tx.objectStore(s).delete(k);
  }
  const snaps = tx.objectStore('snapshots');
  let cur = await snaps.openCursor();
  while (cur) {
    if (cur.value.docKey.startsWith(id + ':')) await cur.delete();
    cur = await cur.continue();
  }
  await tx.done;
}
