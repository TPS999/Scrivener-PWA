// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocData, PMNode, Project, Snapshot } from '../src/model/types';
import { docPlainText, rtfToDoc, textToRtf } from '../src/scriv/rtf';
import { importScriv } from '../src/scriv/scrivProject';
import { parseScrivx } from '../src/scriv/scrivx';
import { DbxConflictError, contentHash } from '../src/sync/dropbox';
import { type BaseRec, type LocalStore, type RemoteFS, fetchWholeProject, syncProject } from '../src/sync/syncEngine';
import { DOCKS_COMMENTS, DOCKS_RTF, SCRIVX } from './fixtures/sample';

const enc = new TextEncoder();
const dec = new TextDecoder();
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const SCENE = 'CCCCCCCC-0000-4000-8000-000000000001';
const SCENE2 = 'CCCCCCCC-0000-4000-8000-000000000002';
const CHAPTER = 'BBBBBBBB-0000-4000-8000-000000000001';

class FakeDropbox implements RemoteFS {
  files = new Map<string, { data: Uint8Array; rev: string; hash: string }>();
  revN = 0;
  beforeUpload?: (path: string) => void;
  uploads: string[] = [];
  async put(path: string, data: Uint8Array) {
    this.files.set(path.toLowerCase(), { data, rev: 'r' + ++this.revN, hash: await contentHash(data) });
    (this.files.get(path.toLowerCase()) as { path?: string }).path = path;
  }
  async list() {
    return [...this.files.values()].map((f) => ({ path: (f as unknown as { path: string }).path, rev: f.rev, hash: f.hash, size: f.data.length }));
  }
  async download(path: string) {
    const f = this.files.get(path.toLowerCase());
    if (!f) throw new Error('404 ' + path);
    return { data: f.data, rev: f.rev, hash: f.hash };
  }
  async upload(path: string, data: Uint8Array, baseRev: string | null) {
    this.beforeUpload?.(path);
    const cur = this.files.get(path.toLowerCase());
    if (cur && cur.rev !== baseRev) throw new DbxConflictError(path);
    if (!cur && baseRev) throw new DbxConflictError(path);
    await this.put(path, data);
    this.uploads.push(path);
    const f = this.files.get(path.toLowerCase())!;
    return { rev: f.rev, hash: f.hash };
  }
  async remove(path: string) { this.files.delete(path.toLowerCase()); }
  text(path: string) { return dec.decode(this.files.get(path.toLowerCase())!.data); }
}

class MemStore implements LocalStore {
  docs = new Map<string, DocData>();
  raw = new Map<string, Uint8Array>();
  base = new Map<string, BaseRec>();
  snaps: Snapshot[] = [];
  project!: Project;
  async getDoc(id: string) { return this.docs.get(id); }
  async putDoc(d: DocData) { this.docs.set(d.itemId, structuredClone(d)); }
  async getRaw(p: string) { return this.raw.get(p.toLowerCase()); }
  async putRaw(p: string, d: Uint8Array) { this.raw.set(p.toLowerCase(), d); }
  async deleteRaw(p: string) { this.raw.delete(p.toLowerCase()); }
  async getBase() { return new Map(this.base); }
  async putBase(r: BaseRec) { this.base.set(r.path.toLowerCase(), r); }
  async deleteBase(p: string) { this.base.delete(p.toLowerCase()); }
  async snapshot(doc: DocData, title: string, content: PMNode, kind: 'sync' | 'conflict') {
    this.snaps.push({ docKey: doc.key, title, content, kind, date: new Date().toISOString(), words: 0 });
  }
  async saveProject(p: Project) { this.project = structuredClone(p); }
}

const para = (t: string): PMNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

let dbx: FakeDropbox;
let store: MemStore;
let project: Project;

async function seedRemote() {
  dbx = new FakeDropbox();
  await dbx.put('Novel.scrivx', enc.encode(SCRIVX));
  await dbx.put(`Files/Data/${SCENE}/content.rtf`, latin1(DOCKS_RTF));
  await dbx.put(`Files/Data/${SCENE}/content.comments`, enc.encode(DOCKS_COMMENTS));
  await dbx.put(`Files/Data/${SCENE}/synopsis.txt`, enc.encode('Arrival.'));
  await dbx.put(`Files/Data/${SCENE2}/content.rtf`, latin1(textToRtf('Second scene.')));
  await dbx.put('Settings/ui.plist', enc.encode('<plist/>'));
}

async function clone() {
  store = new MemStore();
  const { files, base } = await fetchWholeProject(dbx);
  const r = importScriv(files, 'Novel', 'P1');
  project = r.project;
  project.scriv!.dropboxPath = '/Apps/Scrivener/Novel.scriv';
  for (const d of r.docs) store.docs.set(d.itemId, d);
  for (const [p, d] of files) store.raw.set(p.toLowerCase(), d);
  for (const b of base) store.base.set(b.path.toLowerCase(), b);
  // Scrivener's template special folders already exist; nothing to add
}

const sync = (opts = {}) => syncProject(project, store, dbx, opts);
const sceneText = () => docPlainText(store.docs.get(SCENE)!.content);

beforeEach(async () => { await seedRemote(); await clone(); });

describe('sync', () => {
  it('is a no-op when nothing changed', async () => {
    const r = await sync();
    expect(r).toMatchObject({ status: 'ok', uploaded: 0, conflicts: [] });
    expect(dbx.uploads).toEqual([]);
  });

  it('uploads a local edit against the right revision', async () => {
    const d = store.docs.get(SCENE)!;
    d.content = para('Rewritten on the phone.');
    d.contentDirty = true;
    const r = await sync();
    expect(r.uploaded).toBeGreaterThan(0);
    const remote = rtfToDoc(dbx.files.get(`files/data/${SCENE.toLowerCase()}/content.rtf`)!.data).doc;
    expect(docPlainText(remote)).toBe('Rewritten on the phone.');
    expect(store.docs.get(SCENE)!.contentDirty).toBe(false);
    expect((await sync()).uploaded).toBe(0); // stable afterwards
  });

  it('pulls a desktop edit and snapshots the old text first', async () => {
    await dbx.put(`Files/Data/${SCENE}/content.rtf`, latin1(textToRtf('Desktop rewrite.')));
    const r = await sync();
    expect(r.conflicts).toEqual([]);
    expect(sceneText()).toBe('Desktop rewrite.');
    expect(store.snaps).toHaveLength(1);
    expect(store.snaps[0].kind).toBe('sync');
    expect(dbx.uploads).toEqual([]);
  });

  it('never loses either side of a true conflict', async () => {
    await dbx.put(`Files/Data/${SCENE}/content.rtf`, latin1(textToRtf('Desktop version.')));
    const d = store.docs.get(SCENE)!;
    d.content = para('Phone version.');
    d.contentDirty = true;
    const r = await sync();
    expect(r.conflicts).toEqual(['The Docks']);
    expect(sceneText()).toBe('Phone version.');
    expect(store.docs.get(SCENE)!.conflict).toBe(true);
    expect(docPlainText(store.snaps.find((s) => s.kind === 'conflict')!.content)).toBe('Desktop version.');
    // remote untouched until the user decides
    expect(docPlainText(rtfToDoc(dbx.files.get(`files/data/${SCENE.toLowerCase()}/content.rtf`)!.data).doc)).toBe('Desktop version.');
    // user picks "keep mine"
    store.docs.get(SCENE)!.conflict = false;
    await sync();
    expect(docPlainText(rtfToDoc(dbx.files.get(`files/data/${SCENE.toLowerCase()}/content.rtf`)!.data).doc)).toBe('Phone version.');
  });

  it('treats identical edits on both sides as no conflict', async () => {
    await dbx.put(`Files/Data/${SCENE}/content.rtf`, latin1(textToRtf('Same words.')));
    const d = store.docs.get(SCENE)!;
    d.content = para('Same words.');
    d.contentDirty = true;
    const r = await sync();
    expect(r.conflicts).toEqual([]);
    expect(store.docs.get(SCENE)!.contentDirty).toBe(false);
  });

  it('merges binder changes from both sides', async () => {
    // desktop adds a new scene to chapter one
    const xml = SCRIVX.replace('</Children>\n                </BinderItem>\n            </Children>',
      `    <BinderItem UUID="CCCCCCCC-0000-4000-8000-000000000009" Type="Text" Created="2024-05-01 10:00:00 +0000" Modified="2024-05-01 10:00:00 +0000"><Title>Desktop Scene</Title><MetaData><IncludeInCompile>Yes</IncludeInCompile></MetaData></BinderItem>
                    </Children>
                </BinderItem>
            </Children>`);
    expect(xml).not.toBe(SCRIVX);
    await dbx.put('Novel.scrivx', enc.encode(xml));
    await dbx.put('Files/Data/CCCCCCCC-0000-4000-8000-000000000009/content.rtf', latin1(textToRtf('New from desktop.')));
    // phone renames the chapter and adds its own scene
    project.items[CHAPTER].title = 'Chapter 1: Fog';
    const newId = 'FFFFFFFF-0000-4000-8000-000000000001';
    project.items[newId] = { ...project.items[SCENE2], id: newId, title: 'Phone Scene', children: [], parent: CHAPTER };
    project.items[CHAPTER].children.push(newId);
    store.docs.set(newId, { key: 'P1:' + newId, projectId: 'P1', itemId: newId, content: para('Written on the bus.'), notes: { type: 'doc', content: [{ type: 'paragraph' }] }, contentDirty: true, notesDirty: false, modified: '' });
    project.binderDirty = true;

    await sync();
    const remote = parseScrivx(dbx.text('Novel.scrivx'));
    expect(remote.items[CHAPTER].title).toBe('Chapter 1: Fog');
    expect(remote.items[CHAPTER].children).toEqual([SCENE, SCENE2, newId, 'CCCCCCCC-0000-4000-8000-000000000009']);
    expect(dbx.text('Novel.scrivx')).toContain('<CompileSettings>');
    expect(docPlainText(store.docs.get('CCCCCCCC-0000-4000-8000-000000000009')!.content)).toBe('New from desktop.');
    expect(dbx.files.has(`files/data/${newId.toLowerCase()}/content.rtf`)).toBe(true);
    // binder was written after the new document's text
    expect(dbx.uploads.indexOf('Novel.scrivx')).toBeGreaterThan(dbx.uploads.findIndex((p) => p.includes(newId)));
  });

  it('restarts instead of clobbering when Dropbox changes mid-sync', async () => {
    const d = store.docs.get(SCENE)!;
    d.content = para('Phone edit.');
    d.contentDirty = true;
    let fired = false;
    dbx.beforeUpload = (p) => {
      if (!fired && p.includes(SCENE)) {
        fired = true;
        // desktop saves at the worst moment
        const f = dbx.files.get(`files/data/${SCENE.toLowerCase()}/content.rtf`)!;
        f.rev = 'sneaky';
        f.data = latin1(textToRtf('Desktop edit.'));
        f.hash = 'changed-' + Math.random();
      }
    };
    const r = await sync();
    // second pass saw both edits => conflict, nothing overwritten
    expect(r.conflicts).toEqual(['The Docks']);
    expect(sceneText()).toBe('Phone edit.');
  });

  it('refuses to sync while the project is open elsewhere unless told to', async () => {
    await dbx.put('Files/user.lock', enc.encode('x'));
    expect((await sync()).status).toBe('locked');
    expect((await sync({ ignoreLock: true })).status).toBe('ok');
  });

  it('syncs synopsis and notes', async () => {
    project.items[SCENE].synopsis = 'Arrival at night.';
    const d = store.docs.get(SCENE2)!;
    d.notes = para('Remember the gulls.');
    d.notesDirty = true;
    await sync();
    expect(dbx.text(`Files/Data/${SCENE}/synopsis.txt`)).toBe('Arrival at night.');
    expect(docPlainText(rtfToDoc(dbx.files.get(`files/data/${SCENE2.toLowerCase()}/notes.rtf`)!.data).doc)).toBe('Remember the gulls.');
    expect(dbx.uploads.some((p) => p.endsWith('.scrivx'))).toBe(false);
  });

  it('deletes remote files for documents removed from the trash', async () => {
    delete project.items[SCENE2];
    project.items[CHAPTER].children = [SCENE];
    project.binderDirty = true;
    await sync();
    expect(dbx.files.has(`files/data/${SCENE2.toLowerCase()}/content.rtf`)).toBe(false);
    expect(parseScrivx(dbx.text('Novel.scrivx')).items[SCENE2]).toBeUndefined();
  });
});
