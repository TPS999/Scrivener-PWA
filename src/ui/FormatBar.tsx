import type { Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import type { PMNode } from '../model/types';
import { useNav, useSession } from './ctx';
import { addComment } from './DocEditor';
import { Icon } from './icons';
import { ActionMenu, prompt, toast } from './kit';

export function FormatBar({ editor, itemId }: { editor: Editor | null; itemId: string | null }) {
  const session = useSession();
  const nav = useNav();
  const [, force] = useState(0);
  const [menu, setMenu] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const f = () => force((x) => x + 1);
    editor.on('transaction', f);
    return () => { editor.off('transaction', f); };
  }, [editor]);

  const dis = !editor || !editor.isEditable;
  const B = ({ name, label, active, run, disabled }: { name: string; label: string; active?: boolean; run: () => void; disabled?: boolean }) => (
    <button className={`fb-btn ${active ? 'on' : ''}`} aria-label={label} title={label} aria-pressed={active}
      disabled={disabled ?? dis}
      onMouseDown={(e) => e.preventDefault() /* keep the selection & keyboard */}
      onClick={run}><Icon name={name} size={19} /></button>
  );
  const T = ({ ch, label, active, run, style }: { ch: string; label: string; active?: boolean; run: () => void; style?: React.CSSProperties }) => (
    <button className={`fb-btn txt ${active ? 'on' : ''}`} aria-label={label} title={label} aria-pressed={active} disabled={dis}
      onMouseDown={(e) => e.preventDefault()} onClick={run} style={style}>{ch}</button>
  );
  const c = () => editor!.chain().focus();
  const align = (['left', 'center', 'right', 'justify'] as const).find((a) => editor?.isActive({ textAlign: a })) ?? 'left';
  const nextAlign = { left: 'center', center: 'right', right: 'justify', justify: 'left' }[align];

  const split = async () => {
    if (!editor || !itemId) return;
    const { from } = editor.state.selection;
    const doc = editor.state.doc;
    if (from <= 1 || from >= doc.content.size - 1) { toast('Put the cursor where the new document should start'); return; }
    const title = await prompt('Split document here', `${session.item(itemId)?.title ?? ''} (2)`, { label: 'Title for the new document (text after the cursor)', okLabel: 'Split' });
    if (title === null) return;
    const before = doc.cut(0, from).toJSON() as PMNode;
    const after = doc.cut(from).toJSON() as PMNode;
    const nid = await session.split(itemId, before, after, title);
    nav.open(nid);
  };

  const speak = () => {
    if (speaking) { speechSynthesis.cancel(); setSpeaking(false); return; }
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const text = from !== to ? editor.state.doc.textBetween(from, to, '\n') : editor.state.doc.textBetween(from, editor.state.doc.content.size, '\n');
    if (!text.trim()) { toast('Nothing to read from here'); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
    setSpeaking(true);
  };

  return (
    <div className="formatbar" role="toolbar" aria-label="Formatting">
      <B name="undo" label="Undo" run={() => c().undo().run()} disabled={dis || !editor?.can().undo()} />
      <B name="redo" label="Redo" run={() => c().redo().run()} disabled={dis || !editor?.can().redo()} />
      <span className="fb-sep" />
      <T ch="B" label="Bold" active={editor?.isActive('bold')} run={() => c().toggleBold().run()} style={{ fontWeight: 700 }} />
      <T ch="I" label="Italic" active={editor?.isActive('italic')} run={() => c().toggleItalic().run()} style={{ fontStyle: 'italic' }} />
      <T ch="U" label="Underline" active={editor?.isActive('underline')} run={() => c().toggleUnderline().run()} style={{ textDecoration: 'underline' }} />
      <T ch="S" label="Strikethrough" active={editor?.isActive('strike')} run={() => c().toggleStrike().run()} style={{ textDecoration: 'line-through' }} />
      <B name="highlight" label="Highlight" active={editor?.isActive('highlight')} run={() => c().toggleHighlight({ color: '#fff59d' }).run()} />
      <span className="fb-sep" />
      <B name="comment" label="Add comment" run={() => editor && addComment(editor, 'comment')} />
      <B name="footnote" label="Add footnote" run={() => editor && addComment(editor, 'footnote')} />
      <B name="annot" label="Inline annotation (never compiled)" active={editor?.isActive('annotation')} run={() => c().toggleMark('annotation').run()} />
      <span className="fb-sep" />
      <B name="align" label={`Align ${nextAlign}`} active={align !== 'left'} run={() => c().setTextAlign(nextAlign).run()} />
      <B name="quote" label="Block quote" active={editor?.isActive('blockquote')} run={() => c().toggleBlockquote().run()} />
      <B name="list" label="Bulleted list" active={editor?.isActive('bulletList')} run={() => c().toggleBulletList().run()} />
      <button className="fb-btn" aria-label="More" title="More" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(true)}><Icon name="more" size={19} /></button>
      {menu && <ActionMenu onClose={() => setMenu(false)} items={[
        { label: 'Heading', icon: 'H', disabled: dis, onClick: () => c().toggleHeading({ level: 2 }).run() },
        { label: 'Numbered list', icon: '1.', disabled: dis, onClick: () => c().toggleOrderedList().run() },
        { label: 'Scene break (#)', icon: '#', disabled: dis, onClick: () => c().insertContent([{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '#' }] }, { type: 'paragraph' }]).run() },
        { label: 'Clear formatting', icon: '⌫', disabled: dis, onClick: () => c().unsetAllMarks().run() },
        { label: 'Split document at cursor', icon: '✂', disabled: dis || !itemId, onClick: split },
        { label: speaking ? 'Stop reading aloud' : 'Read aloud from cursor', icon: '🔊', onClick: speak },
        { label: 'Take snapshot', icon: '📷', disabled: !itemId, onClick: () => nav.showInspector('snapshots') },
        { label: 'Composition mode', icon: '⛶', onClick: () => nav.compose(true) },
      ]} />}
    </div>
  );
}
