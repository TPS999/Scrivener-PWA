import { EditorContent, type Editor, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PMNode, Snapshot } from '../model/types';
import { editorExtensions } from '../editor/extensions';
import { docPlainText } from '../scriv/rtf';
import { deleteSnapshot, listSnapshots } from '../store/db';
import { type InspectorTab, useSession } from './ctx';
import { DiffView } from './Conflict';
import { updateComment } from './DocEditor';
import { Sheet, confirm, fmtDate, prompt, toast } from './kit';

export function Inspector({ itemId, tab, setTab, editor }: { itemId: string; tab: InspectorTab; setTab: (t: InspectorTab) => void; editor: Editor | null }) {
  const session = useSession();
  const it = session.item(itemId);
  if (!it) return null;
  const tabs: [InspectorTab, string][] = [['synopsis', 'Synopsis'], ['meta', 'Info'], ['notes', 'Notes'], ['snapshots', 'Snapshots'], ['comments', 'Comments']];
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="seg" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="insp-body">
        {tab === 'synopsis' && <SynopsisTab itemId={itemId} />}
        {tab === 'meta' && <MetaTab itemId={itemId} />}
        {tab === 'notes' && <NotesTab key={itemId} itemId={itemId} />}
        {tab === 'snapshots' && <SnapshotsTab key={itemId} itemId={itemId} />}
        {tab === 'comments' && <CommentsTab itemId={itemId} editor={editor} />}
      </div>
    </aside>
  );
}

function SynopsisTab({ itemId }: { itemId: string }) {
  const session = useSession();
  const it = session.item(itemId)!;
  return (
    <div className="stack">
      <input className="insp-title" value={it.title} aria-label="Title" onChange={(e) => session.update((p) => { p.items[itemId].title = e.target.value; })} />
      <textarea className="synopsis" rows={8} placeholder="What happens here? (Shown on the index card.)" value={it.synopsis}
        onChange={(e) => session.update((p) => { p.items[itemId].synopsis = e.target.value; }, false)} />
      <button className="btn small" onClick={async () => {
        const d = await session.loadDoc(itemId);
        const text = d ? docPlainText(d.content) : '';
        const first = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 280);
        if (first) session.update((p) => { p.items[itemId].synopsis = first; }, false);
      }}>Fill from opening lines</button>
    </div>
  );
}

function MetaTab({ itemId }: { itemId: string }) {
  const session = useSession();
  const p = session.project;
  const it = p.items[itemId];
  const set = (fn: (i: typeof it) => void) => session.update((pp) => fn(pp.items[itemId]));
  return (
    <div className="form">
      <label>Label
        <select value={it.labelId} onChange={(e) => set((i) => { i.labelId = Number(e.target.value); })}>
          {p.labels.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </label>
      <label>Status
        <select value={it.statusId} onChange={(e) => set((i) => { i.statusId = Number(e.target.value); })}>
          {p.statuses.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={it.includeInCompile} onChange={(e) => set((i) => { i.includeInCompile = e.target.checked; })} /> Include in compile</label>
      <label className="check"><input type="checkbox" checked={!!it.pageBreakBefore} onChange={(e) => set((i) => { i.pageBreakBefore = e.target.checked; })} /> Page break before</label>
      <label>Word target for this document
        <input type="number" inputMode="numeric" min={0} value={it.target ?? ''} placeholder="none" onChange={(e) => session.update((pp) => { pp.items[itemId].target = Number(e.target.value) || undefined; }, false)} />
      </label>
      <fieldset>
        <legend>Keywords</legend>
        <div className="chips">
          {it.keywords.map((k) => {
            const kw = p.keywords.find((x) => x.id === k);
            return <span key={k} className="chip" style={kw?.color ? { borderColor: kw.color } : undefined}>{kw?.title ?? `#${k}`}<button aria-label="Remove keyword" onClick={() => set((i) => { i.keywords = i.keywords.filter((x) => x !== k); })}>×</button></span>;
          })}
          <button className="chip add" onClick={async () => {
            const t = (await prompt('Add keyword', '', { label: `Existing: ${p.keywords.map((k) => k.title).join(', ') || 'none yet'}` }))?.trim();
            if (!t) return;
            session.update((pp) => {
              let kw = pp.keywords.find((k) => k.title.toLowerCase() === t.toLowerCase());
              if (!kw) { kw = { id: Math.max(-1, ...pp.keywords.map((k) => k.id)) + 1, title: t, color: '' }; pp.keywords.push(kw); }
              if (!pp.items[itemId].keywords.includes(kw.id)) pp.items[itemId].keywords.push(kw.id);
            });
          }}>+ keyword</button>
        </div>
      </fieldset>
      <dl className="facts">
        <dt>Words</dt><dd>{it.wordCount.toLocaleString()}</dd>
        <dt>Created</dt><dd>{fmtDate(it.created)}</dd>
        <dt>Modified</dt><dd>{fmtDate(it.modified)}</dd>
        <dt>Kind</dt><dd>{it.type}</dd>
      </dl>
    </div>
  );
}

function NotesTab({ itemId }: { itemId: string }) {
  const session = useSession();
  const [notes, setNotes] = useState<PMNode | null>(null);
  useEffect(() => { session.loadDoc(itemId).then((d) => setNotes(d?.notes ?? null)); }, [itemId, session]);
  if (!notes) return <p className="muted">No notes for this item.</p>;
  return <NotesEditor itemId={itemId} initial={notes} />;
}
function NotesEditor({ itemId, initial }: { itemId: string; initial: PMNode }) {
  const session = useSession();
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edRef = useRef<Editor | null>(null);
  const save = useCallback(() => { if (t.current) { clearTimeout(t.current); t.current = null; if (edRef.current) session.saveNotes(itemId, edRef.current.getJSON() as PMNode); } }, [session, itemId]);
  const editor = useEditor({
    extensions: editorExtensions('Notes, research, reminders…'),
    content: initial,
    editorProps: { attributes: { class: 'prose notes-prose', 'aria-label': 'Document notes' } },
    onUpdate({ editor: e }) { edRef.current = e; if (t.current) clearTimeout(t.current); t.current = setTimeout(() => { t.current = null; session.saveNotes(itemId, e.getJSON() as PMNode); }, 400); },
    onBlur: () => save(),
  });
  useEffect(() => () => save(), [save]);
  return <EditorContent editor={editor} className="notes-surface" />;
}

function SnapshotsTab({ itemId }: { itemId: string }) {
  const session = useSession();
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [cmp, setCmp] = useState<Snapshot | null>(null);
  const key = `${session.project.id}:${itemId}`;
  const reload = useCallback(() => listSnapshots(key).then(setSnaps), [key]);
  useEffect(() => { reload(); }, [reload]);
  const kinds: Record<string, string> = { manual: '', auto: 'auto', sync: 'sync', conflict: 'conflict' };
  return (
    <div className="stack">
      <button className="btn primary" onClick={async () => {
        window.dispatchEvent(new Event('inkwell:flush'));
        const t = await prompt('Take snapshot', '', { label: 'Optional title, e.g. “Before cutting the flashback”', okLabel: 'Take snapshot' });
        if (t === null) return;
        await session.takeSnapshot(itemId, t || `Snapshot ${new Date().toLocaleString()}`);
        reload(); toast('Snapshot saved', 'ok');
      }}>Take snapshot</button>
      {snaps && !snaps.length && <p className="muted">No snapshots yet. Inkwell also takes one automatically before your first edit each half hour, and before any sync change.</p>}
      <ul className="snap-list">
        {snaps?.map((s) => (
          <li key={s.id}>
            <div><strong>{s.title}</strong> {kinds[s.kind] && <span className={`badge ${s.kind}`}>{kinds[s.kind]}</span>}</div>
            <div className="muted small">{fmtDate(s.date)} · {s.words.toLocaleString()} words</div>
            <div className="row tight">
              <button className="btn small" onClick={() => setCmp(s)}>Compare</button>
              <button className="btn small" onClick={async () => {
                if (!(await confirm('Restore snapshot?', 'The current text will be saved as a snapshot first, so you can always go back.', 'Restore'))) return;
                window.dispatchEvent(new Event('inkwell:flush'));
                await session.takeSnapshot(itemId, 'Before restoring a snapshot');
                await session.saveContent(itemId, s.content);
                await session.replaceDoc((await session.loadDoc(itemId))!);
                reload(); toast('Snapshot restored', 'ok');
              }}>Restore</button>
              <button className="btn small ghost danger" onClick={async () => { if (await confirm('Delete snapshot?', s.title, 'Delete', true)) { await deleteSnapshot(s.id!); reload(); } }}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      {cmp && (
        <Sheet title={`Compare: ${cmp.title}`} wide onClose={() => setCmp(null)}>
          <DiffView oldText={docPlainText(cmp.content)} newText={docPlainText(session.cachedDoc(itemId)?.content ?? cmp.content)} oldLabel="Snapshot (removed since)" newLabel="Current (added since)" />
        </Sheet>
      )}
    </div>
  );
}

function CommentsTab({ itemId, editor }: { itemId: string; editor: Editor | null }) {
  const session = useSession();
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const f = () => force((x) => x + 1);
    editor.on('update', f);
    return () => { editor.off('update', f); };
  }, [editor]);
  const content = editor?.getJSON() as PMNode | undefined ?? session.cachedDoc(itemId)?.content;
  const found = new Map<string, { id: string; kind: string; text: string; anchor: string }>();
  const walk = (n: PMNode) => {
    if (n.type === 'text') for (const m of n.marks ?? []) {
      if (m.type !== 'scrivComment') continue;
      const id = String(m.attrs?.id);
      const cur = found.get(id);
      if (cur) cur.anchor += n.text; else found.set(id, { id, kind: String(m.attrs?.kind), text: String(m.attrs?.text ?? ''), anchor: n.text ?? '' });
    }
    n.content?.forEach(walk);
  };
  if (content) walk(content);
  const list = [...found.values()];
  const jump = (id: string) => {
    if (!editor) return;
    let pos = -1;
    editor.state.doc.descendants((node, p) => { if (pos < 0 && node.marks.some((m) => m.attrs.id === id)) pos = p; });
    if (pos >= 0) editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  };
  if (!editor) return <p className="muted">Open the document in the editor to see its comments.</p>;
  return (
    <div className="stack">
      {!list.length && <p className="muted">No comments or footnotes. Select text and use the 💬 or footnote buttons in the toolbar.</p>}
      {list.map((c) => (
        <div key={c.id} className={`comment-card ${c.kind}`}>
          <button className="link small" onClick={() => jump(c.id)}>{c.kind === 'footnote' ? 'Footnote' : 'Comment'} on “{c.anchor.slice(0, 40)}{c.anchor.length > 40 ? '…' : ''}”</button>
          <p>{c.text || <span className="muted">(empty)</span>}</p>
          <div className="row tight">
            <button className="btn small" onClick={async () => { const t = await prompt(`Edit ${c.kind}`, c.text, { multiline: true }); if (t !== null) updateComment(editor, c.id, t); }}>Edit</button>
            <button className="btn small ghost danger" onClick={() => updateComment(editor, c.id, null)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
