// The open project. Holds the binder in memory, loads documents lazily, and
// writes every change to IndexedDB immediately (binder debounced 250 ms).
// Nothing waits on the network: sync is a separate, explicit step.

import { type BinderItem, type DocData, type ItemType, type PMNode, type Project, emptyDoc, isFolderish, isTextual, nowIso, uuid } from '../model/types';
import { countWords, docPlainText } from '../scriv/rtf';
import * as store from './db';

type Listener = () => void;

const AUTO_SNAPSHOT_EVERY = 30 * 60 * 1000;
const MAX_AUTO_SNAPSHOTS = 25;

export class Session {
  project: Project;
  version = 0;
  private listeners = new Set<Listener>();
  private docListeners = new Map<string, Set<(d: DocData) => void>>();
  private docs = new Map<string, DocData>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotted = new Map<string, number>();
  syncing = false;
  syncMessage = '';
  selection: string | null = null;

  constructor(p: Project) { this.project = p; }

  static async open(id: string) {
    const p = await store.getProject(id);
    if (!p) throw new Error('Project not found');
    return new Session(p);
  }

  subscribe = (fn: Listener) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  emit() { this.version++; this.listeners.forEach((l) => l()); }

  onDocReplaced(itemId: string, fn: (d: DocData) => void) {
    let s = this.docListeners.get(itemId);
    if (!s) this.docListeners.set(itemId, (s = new Set()));
    s.add(fn);
    return () => { s!.delete(fn); };
  }

  item(id: string | null | undefined): BinderItem | undefined { return id ? this.project.items[id] : undefined; }

  /** Mutate the binder/project. */
  update(fn: (p: Project) => void, binder = true) {
    fn(this.project);
    this.project.modified = nowIso();
    if (binder) this.project.binderDirty = true;
    this.emit();
    this.scheduleSave();
  }
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await store.putProject(this.project);
  }

  // ---------------------------------------------------------------- docs
  async loadDoc(itemId: string): Promise<DocData | undefined> {
    const cached = this.docs.get(itemId);
    if (cached) return cached;
    let d = await store.getDoc(this.project.id, itemId);
    const it = this.project.items[itemId];
    if (!d && it && isTextual(it.type)) {
      d = { key: store.docKey(this.project.id, itemId), projectId: this.project.id, itemId, content: emptyDoc(), notes: emptyDoc(), contentDirty: false, notesDirty: false, modified: nowIso() };
    }
    if (d) this.docs.set(itemId, d);
    return d;
  }
  cachedDoc(itemId: string) { return this.docs.get(itemId); }

  async saveContent(itemId: string, content: PMNode, extra?: Partial<DocData>) {
    const d = await this.loadDoc(itemId);
    if (!d) return;
    await this.maybeAutoSnapshot(d);
    d.content = content;
    d.contentDirty = true;
    d.modified = nowIso();
    if (extra) Object.assign(d, extra);
    await store.putDoc(d);
    const it = this.project.items[itemId];
    if (it) {
      const words = countWords(docPlainText(content));
      const delta = words - it.wordCount;
      if (delta) {
        it.wordCount = words;
        it.modified = d.modified;
        store.addWordsToday(this.project.id, delta).catch(() => {});
        this.update(() => {}, false);
      }
    }
  }
  async saveNotes(itemId: string, notes: PMNode) {
    const d = await this.loadDoc(itemId);
    if (!d) return;
    d.notes = notes;
    d.notesDirty = true;
    d.modified = nowIso();
    await store.putDoc(d);
  }
  async saveViewState(itemId: string, selection: { from: number; to: number }, scrollTop: number) {
    const d = this.docs.get(itemId);
    if (!d) return;
    d.selection = selection;
    d.scrollTop = scrollTop;
    await store.putDoc(d);
  }
  /** Replace a doc wholesale (sync pull, snapshot restore) and tell open editors. */
  async replaceDoc(d: DocData) {
    this.docs.set(d.itemId, d);
    await store.putDoc(d);
    const it = this.project.items[d.itemId];
    if (it) it.wordCount = countWords(docPlainText(d.content));
    this.docListeners.get(d.itemId)?.forEach((fn) => fn(d));
    this.emit();
  }
  forgetDoc(itemId: string) { this.docs.delete(itemId); }

  private async maybeAutoSnapshot(d: DocData) {
    const last = this.snapshotted.get(d.itemId) ?? 0;
    if (Date.now() - last < AUTO_SNAPSHOT_EVERY) return;
    this.snapshotted.set(d.itemId, Date.now());
    const text = docPlainText(d.content);
    if (!text.trim()) return;
    const existing = await store.listSnapshots(d.key);
    if (existing[0] && JSON.stringify(existing[0].content) === JSON.stringify(d.content)) return;
    await store.addSnapshot({ docKey: d.key, title: 'Auto-saved before editing', date: nowIso(), content: d.content, kind: 'auto', words: countWords(text) });
    const autos = existing.filter((s) => s.kind === 'auto');
    for (const s of autos.slice(MAX_AUTO_SNAPSHOTS - 1)) await store.deleteSnapshot(s.id!);
  }

  async takeSnapshot(itemId: string, title: string) {
    const d = await this.loadDoc(itemId);
    if (!d) return;
    await store.addSnapshot({ docKey: d.key, title: title || 'Snapshot', date: nowIso(), content: d.content, kind: 'manual', words: countWords(docPlainText(d.content)) });
  }

  // ---------------------------------------------------------------- binder
  get draftId() { return this.project.rootIds.find((id) => this.project.items[id]?.type === 'DraftFolder')!; }
  get researchId() { return this.project.rootIds.find((id) => this.project.items[id]?.type === 'ResearchFolder'); }
  get trashId() { return this.project.rootIds.find((id) => this.project.items[id]?.type === 'TrashFolder')!; }

  siblings(id: string) {
    const it = this.project.items[id];
    return it.parent ? this.project.items[it.parent].children : this.project.rootIds;
  }
  isDescendant(id: string, ancestor: string) {
    let cur = this.project.items[id]?.parent ?? null;
    while (cur) { if (cur === ancestor) return true; cur = this.project.items[cur]?.parent ?? null; }
    return false;
  }
  inTrash(id: string) { return id === this.trashId || this.isDescendant(id, this.trashId); }
  isSpecial(id: string) { const t = this.project.items[id]?.type; return t === 'DraftFolder' || t === 'ResearchFolder' || t === 'TrashFolder'; }

  descendants(id: string, includeSelf = false): string[] {
    const out: string[] = includeSelf ? [id] : [];
    const walk = (x: string) => { for (const c of this.project.items[x]?.children ?? []) { out.push(c); walk(c); } };
    walk(id);
    return out;
  }

  async addItem(type: Extract<ItemType, 'Text' | 'Folder'>, anchor: string | null, where: 'after' | 'inside' = 'after', title?: string, content?: PMNode) {
    const id = uuid();
    const now = nowIso();
    let parent: string | null;
    let index: number;
    const a = anchor ? this.project.items[anchor] : undefined;
    if (!a || this.inTrash(anchor!)) { parent = this.draftId; index = this.project.items[parent].children.length; }
    else if (where === 'inside' || this.isSpecial(anchor!)) { parent = anchor; index = a.children.length; }
    else { parent = a.parent; index = this.siblings(anchor!).indexOf(anchor!) + 1; }
    const underDraft = parent === this.draftId || (parent ? this.isDescendant(parent, this.draftId) : false);
    const item: BinderItem = {
      id, type, title: title ?? (type === 'Folder' ? 'New Folder' : 'Untitled'), parent, children: [],
      created: now, modified: now, labelId: -1, statusId: -1, keywords: [], includeInCompile: underDraft, synopsis: '', wordCount: 0,
    };
    const doc: DocData = { key: store.docKey(this.project.id, id), projectId: this.project.id, itemId: id, content: content ?? emptyDoc(), notes: emptyDoc(), contentDirty: true, notesDirty: false, modified: now };
    this.docs.set(id, doc);
    await store.putDoc(doc);
    if (content) item.wordCount = countWords(docPlainText(content));
    this.update((p) => {
      p.items[id] = item;
      const list = parent ? p.items[parent].children : p.rootIds;
      list.splice(index, 0, id);
      if (parent) p.items[parent].expanded = true;
    });
    return id;
  }

  move(id: string, newParent: string | null, index: number) {
    if (this.isSpecial(id)) return false;
    if (newParent && (newParent === id || this.isDescendant(newParent, id))) return false; // never into itself
    if (newParent && !isFolderish(this.project.items[newParent].type) && !isTextual(this.project.items[newParent].type)) return false;
    this.update((p) => {
      const it = p.items[id];
      const from = it.parent ? p.items[it.parent].children : p.rootIds;
      const oldIdx = from.indexOf(id);
      from.splice(oldIdx, 1);
      const to = newParent ? p.items[newParent].children : p.rootIds;
      if (from === to && oldIdx < index) index--;
      to.splice(Math.max(0, Math.min(index, to.length)), 0, id);
      it.parent = newParent;
      it.modified = nowIso();
      if (newParent) p.items[newParent].expanded = true;
    });
    return true;
  }
  moveBy(id: string, delta: -1 | 1) {
    const sib = this.siblings(id);
    const i = sib.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= sib.length) return;
    this.move(id, this.project.items[id].parent, delta > 0 ? j + 1 : j);
  }
  indent(id: string) {
    const sib = this.siblings(id);
    const i = sib.indexOf(id);
    if (i <= 0) return;
    const prev = sib[i - 1];
    this.move(id, prev, this.project.items[prev].children.length);
  }
  outdent(id: string) {
    const it = this.project.items[id];
    if (!it.parent || this.isSpecial(it.parent)) return;
    const parent = this.project.items[it.parent];
    const gp = parent.parent;
    const list = gp ? this.project.items[gp].children : this.project.rootIds;
    this.move(id, gp, list.indexOf(parent.id) + 1);
  }
  trash(id: string) {
    if (this.isSpecial(id)) return;
    this.move(id, this.trashId, this.project.items[this.trashId].children.length);
  }
  async emptyTrash() {
    const ids = this.descendants(this.trashId);
    this.update((p) => {
      for (const id of ids) delete p.items[id];
      p.items[this.trashId].children = [];
    });
    const d = await store.db();
    for (const id of ids) { await d.delete('docs', store.docKey(this.project.id, id)); this.docs.delete(id); }
  }
  async duplicate(id: string) {
    const map = new Map<string, string>();
    const clone = async (src: string, parent: string | null): Promise<string> => {
      const s = this.project.items[src];
      const nid = uuid();
      map.set(src, nid);
      const now = nowIso();
      const copy: BinderItem = { ...s, id: nid, parent, children: [], created: now, modified: now, title: src === id ? `${s.title} copy` : s.title };
      this.project.items[nid] = copy;
      const d = await this.loadDoc(src);
      if (d) await store.putDoc({ ...structuredClone(d), key: store.docKey(this.project.id, nid), itemId: nid, contentDirty: true, notesDirty: true, conflict: false });
      for (const c of s.children) copy.children.push(await clone(c, nid));
      return nid;
    };
    const it = this.project.items[id];
    const nid = await clone(id, it.parent);
    this.update(() => { const sib = this.siblings(id); sib.splice(sib.indexOf(id) + 1, 0, nid); });
    return nid;
  }

  /** Splits a doc: `after` becomes a new document placed right after it. */
  async split(id: string, before: PMNode, after: PMNode, newTitle?: string) {
    await this.takeSnapshot(id, 'Before split');
    await this.saveContent(id, before);
    const it = this.project.items[id];
    const nid = await this.addItem('Text', id, 'after', newTitle ?? `${it.title} (2)`, after);
    this.project.items[nid].labelId = it.labelId;
    this.project.items[nid].statusId = it.statusId;
    this.project.items[nid].includeInCompile = it.includeInCompile;
    this.update(() => {});
    await this.replaceDoc((await this.loadDoc(id))!);
    return nid;
  }
  /** Merges docs (in binder order) into the first; the rest go to the trash. */
  async mergeDocs(ids: string[]) {
    if (ids.length < 2) return;
    const [first, ...rest] = ids;
    const parts: PMNode[] = [];
    for (const id of ids) {
      const d = await this.loadDoc(id);
      await this.takeSnapshot(id, 'Before merge');
      parts.push(...(d?.content.content ?? []));
      if (id !== ids[ids.length - 1]) parts.push({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '#' }] });
    }
    await this.saveContent(first, { type: 'doc', content: parts });
    const fd = await this.loadDoc(first);
    if (fd) await this.replaceDoc(fd);
    const syn = rest.map((id) => this.project.items[id].synopsis).filter(Boolean);
    this.update((p) => { if (syn.length) p.items[first].synopsis = [p.items[first].synopsis, ...syn].filter(Boolean).join('\n'); });
    for (const id of rest) this.trash(id);
  }

  /** Text documents under `id` (inclusive) in reading order. */
  textDescendants(id: string, includeSelf = true) {
    return this.descendants(id, includeSelf).filter((x) => isTextual(this.project.items[x].type) && !this.isSpecial(x));
  }
}
