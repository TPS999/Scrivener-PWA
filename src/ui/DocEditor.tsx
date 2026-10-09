import { EditorContent, type Editor, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocData, PMNode } from '../model/types';
import { editorExtensions } from '../editor/extensions';
import { countWords } from '../scriv/rtf';
import { getPrefs, usePrefs } from '../store/prefs';
import { useNav, useSession } from './ctx';
import { ConflictBanner } from './Conflict';
import { prompt, toast } from './kit';

const SAVE_DELAY = 400;

/** Selects the word around the caret when nothing is selected. */
function ensureSelection(editor: Editor) {
  const { from, to, $from } = editor.state.selection;
  if (from !== to) return true;
  const text = $from.parent.textContent;
  const off = $from.parentOffset;
  const isW = (c: string | undefined) => !!c && /[\p{L}\p{N}'’-]/u.test(c);
  let a = off, b = off;
  // caret after punctuation/space: use the nearest word before it
  if (!isW(text[a - 1]) && !isW(text[b])) { while (a > 0 && !isW(text[a - 1])) a--; b = a; }
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  if (a === b) return false;
  const start = $from.start();
  editor.commands.setTextSelection({ from: start + a, to: start + b });
  return true;
}

export async function addComment(editor: Editor, kind: 'comment' | 'footnote') {
  if (!ensureSelection(editor)) { toast(kind === 'footnote' ? 'Place the cursor on a word or select text for the footnote' : 'Select some text to comment on'); return; }
  const { from, to } = editor.state.selection;
  const text = await prompt(kind === 'footnote' ? 'New footnote' : 'New comment', '', { multiline: true, okLabel: 'Add' });
  if (text === null) return;
  editor.chain().focus().setTextSelection({ from, to }).setMark('scrivComment', { id: crypto.randomUUID().toUpperCase(), kind, text }).setTextSelection(to).run();
}

export function updateComment(editor: Editor, id: string, text: string | null) {
  const { state } = editor;
  const type = state.schema.marks.scrivComment;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find((mk) => mk.type === type && mk.attrs.id === id);
    if (!m) return;
    tr.removeMark(pos, pos + node.nodeSize, m);
    if (text !== null) tr.addMark(pos, pos + node.nodeSize, type.create({ ...m.attrs, text }));
  });
  editor.view.dispatch(tr);
}

export function DocEditor({ itemId, inScrivenings, onEditor, autoFocus }: { itemId: string; inScrivenings?: boolean; onEditor?: (e: Editor | null) => void; autoFocus?: boolean }) {
  const session = useSession();
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDoc(null);
    session.loadDoc(itemId).then((d) => { if (alive) setDoc(d ?? null); }).catch((e) => setError(String(e)));
    return () => { alive = false; };
  }, [itemId, session]);
  if (error) return <div className="empty">Couldn’t open this document: {error}</div>;
  if (!doc) return <div className="ed-loading" aria-busy="true" />;
  return <LoadedEditor key={itemId} doc={doc} inScrivenings={inScrivenings} onEditor={onEditor} autoFocus={autoFocus} />;
}

function LoadedEditor({ doc, inScrivenings, onEditor, autoFocus }: { doc: DocData; inScrivenings?: boolean; onEditor?: (e: Editor | null) => void; autoFocus?: boolean }) {
  const session = useSession();
  const nav = useNav();
  const prefs = usePrefs();
  const itemId = doc.itemId;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const [words, setWords] = useState(() => session.item(itemId)?.wordCount ?? 0);
  const [selWords, setSelWords] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  const [conflict, setConflict] = useState(!!doc.conflict);
  const lossy = !!doc.lossy?.length && !unlocked;
  const wrapRef = useRef<HTMLDivElement>(null);

  const flush = useCallback((ed: Editor | null) => {
    if (!ed || !pending.current) return;
    pending.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    session.saveContent(itemId, ed.getJSON() as PMNode).catch((e) => toast('Could not save: ' + e, 'error'));
  }, [session, itemId]);

  const editor = useEditor({
    extensions: editorExtensions(inScrivenings ? '' : 'Start writing…'),
    content: doc.content,
    editable: !lossy && !session.syncing,
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': session.item(itemId)?.title ?? 'Document' },
      handleClick(view, pos) {
        // First tap places the caret; tapping again inside the same comment opens it.
        const find = (p: number) => view.state.doc.resolve(p).marks().find((mk) => mk.type.name === 'scrivComment');
        const m = find(pos);
        const prev = view.state.selection.empty ? find(view.state.selection.from) : undefined;
        if (m && prev && prev.attrs.id === m.attrs.id) {
          window.dispatchEvent(new CustomEvent('inkwell:comment', { detail: { itemId, id: m.attrs.id } }));
        }
        return false;
      },
    },
    onUpdate({ editor: ed }) {
      pending.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(ed), SAVE_DELAY);
      setWords(countWords(ed.getText({ blockSeparator: '\n' })));
    },
    onSelectionUpdate({ editor: ed }) {
      const { from, to } = ed.state.selection;
      setSelWords(from === to ? 0 : countWords(ed.state.doc.textBetween(from, to, '\n')));
      if (getPrefs().typewriter) typewriterScroll(ed);
    },
    onBlur({ editor: ed }) { flush(ed); },
  }, [itemId]);

  // restore caret & scroll, expose editor
  useEffect(() => {
    if (!editor) return;
    onEditor?.(editor);
    if (!inScrivenings) {
      const sel = doc.selection;
      const size = editor.state.doc.content.size;
      if (sel && sel.from <= size && sel.to <= size) {
        try { editor.commands.setTextSelection(sel); } catch { /* stale selection */ }
      }
      const sc = scrollerOf(wrapRef.current);
      if (sc && doc.scrollTop) requestAnimationFrame(() => { sc.scrollTop = doc.scrollTop!; });
      if (autoFocus && !lossy && window.matchMedia('(min-width: 900px)').matches) editor.commands.focus(undefined, { scrollIntoView: false });
    }
    return () => onEditor?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // flush on every way the page can go away
  useEffect(() => {
    if (!editor) return;
    const f = () => flush(editor);
    const vis = () => { if (document.visibilityState === 'hidden') f(); };
    window.addEventListener('inkwell:flush', f);
    window.addEventListener('pagehide', f);
    document.addEventListener('visibilitychange', vis);
    return () => {
      f();
      if (!inScrivenings) {
        const sc = scrollerOf(wrapRef.current);
        const { from, to } = editor.state.selection;
        session.saveViewState(itemId, { from, to }, sc?.scrollTop ?? 0).catch(() => {});
      }
      window.removeEventListener('inkwell:flush', f);
      window.removeEventListener('pagehide', f);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [editor, flush, session, itemId, inScrivenings]);

  // external replacement (sync pull, snapshot restore) — the only time we setContent
  useEffect(() => session.onDocReplaced(itemId, (d) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    pending.current = false;
    editor.commands.setContent(d.content, { emitUpdate: false });
    const size = editor.state.doc.content.size;
    try { editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) }); } catch { /* ignore */ }
    setWords(countWords(editor.getText()));
    setConflict(!!d.conflict);
  }), [editor, session, itemId]);

  // jump to a search hit
  useEffect(() => {
    const f = (e: Event) => {
      const { itemId: id, q, caseSens } = (e as CustomEvent).detail as { itemId: string; q: string; caseSens: boolean };
      if (id !== itemId || !editor) return;
      const needle = caseSens ? q : q.toLowerCase();
      let found: { from: number; to: number } | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found || !node.isText || !node.text) return;
        const t = caseSens ? node.text : node.text.toLowerCase();
        const k = t.indexOf(needle);
        if (k >= 0) found = { from: pos + k, to: pos + k + q.length };
      });
      if (found) editor.chain().focus().setTextSelection(found).scrollIntoView().run();
    };
    window.addEventListener('inkwell:find', f);
    return () => window.removeEventListener('inkwell:find', f);
  }, [editor, itemId]);

  // read-only while syncing / for protected docs
  useEffect(() => {
    if (!editor) return;
    const want = !lossy && !session.syncing;
    if (editor.isEditable !== want) editor.setEditable(want, false);
  });

  const it = session.item(itemId);
  const target = it?.target ?? 0;

  return (
    <div className={`doc-editor ${inScrivenings ? 'in-scrivenings' : ''}`} ref={wrapRef}>
      {conflict && !inScrivenings && <ConflictBanner itemId={itemId} onResolved={() => setConflict(false)} />}
      {lossy && (
        <div className="banner warn" role="alert">
          <div>
            <strong>Protected document.</strong> This document contains {doc.lossy!.join(' and ')} that the mobile editor can’t display.
            Editing it here would remove them, so it’s read-only.
          </div>
          <button className="btn" onClick={async () => { await session.takeSnapshot(itemId, 'Before editing a protected document'); setUnlocked(true); toast('Snapshot saved. Images/tables will be removed when this document syncs.'); }}>Edit anyway</button>
        </div>
      )}
      <EditorContent editor={editor} className="editor-surface" />
      {!inScrivenings && prefs.showWordCount && (
        <div className="ed-footer" aria-live="polite">
          {selWords ? `${selWords.toLocaleString()} of ` : ''}{words.toLocaleString()} words
          {target > 0 && <span className="target-pill"><progress max={target} value={Math.min(words, target)} /> {Math.round((words / target) * 100)}%</span>}
          {session.syncing && <span className="muted"> · syncing (read-only)</span>}
          <button className="link" onClick={() => nav.showInspector('meta')}>{target ? 'target' : 'set target'}</button>
        </div>
      )}
    </div>
  );
}

function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const s = getComputedStyle(cur).overflowY;
    if (s === 'auto' || s === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}

function typewriterScroll(ed: Editor) {
  requestAnimationFrame(() => {
    try {
      const { head } = ed.state.selection;
      const c = ed.view.coordsAtPos(head);
      const sc = scrollerOf(ed.view.dom as HTMLElement);
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
      const mid = r.top + (r.height - kb) / 2;
      sc.scrollTop += c.top - mid;
    } catch { /* ignore */ }
  });
}
