import { useState } from 'react';
import type { BinderItem } from '../model/types';
import type { Session } from '../store/session';
import { useNav, useSession } from './ctx';
import { Icon, itemIcon } from './icons';
import { ActionMenu, type MenuItem, Sheet, confirm, prompt, toast } from './kit';

type DropPos = 'before' | 'after' | 'inside';

export function Binder({ onPicked }: { onPicked?: () => void }) {
  const session = useSession();
  const nav = useNav();
  const p = session.project;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);

  const open = (id: string) => { nav.open(id); onPicked?.(); };
  const toggle = (id: string) => session.update((pp) => { pp.items[id].expanded = !pp.items[id].expanded; }, false);

  const addNew = async (type: 'Text' | 'Folder', anchor = nav.current, where: 'after' | 'inside' = 'after') => {
    const id = await session.addItem(type, anchor, where);
    nav.open(id);
    const t = await prompt(type === 'Folder' ? 'Folder name' : 'Document title', type === 'Folder' ? 'New Folder' : 'Untitled');
    if (t !== null) session.update((pp) => { pp.items[id].title = t.trim() || pp.items[id].title; });
    onPicked?.();
  };

  const onDrop = (target: string, pos: DropPos) => {
    if (!drag || drag === target) return;
    const t = p.items[target];
    let ok: boolean;
    if (pos === 'inside') ok = session.move(drag, target, t.children.length);
    else {
      const sib = t.parent ? p.items[t.parent].children : p.rootIds;
      if (!t.parent) { ok = session.move(drag, target, t.children.length); } // can't sit beside Draft/Research/Trash
      else ok = session.move(drag, t.parent, sib.indexOf(target) + (pos === 'after' ? 1 : 0));
    }
    if (!ok) toast('Can’t move an item inside itself');
    setDrag(null); setDrop(null);
  };

  const rows: { it: BinderItem; depth: number }[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const it = p.items[id];
      if (!it) continue;
      rows.push({ it, depth });
      if (it.expanded && it.children.length) walk(it.children, depth + 1);
    }
  };
  walk(p.rootIds, 0);

  const menuItems = (id: string): (MenuItem | null)[] => {
    const it = p.items[id];
    const special = session.isSpecial(id);
    const trashed = session.inTrash(id) && id !== session.trashId;
    if (id === session.trashId) return [
      { label: 'Empty Trash', danger: true, icon: '🗑', onClick: async () => { if (await confirm('Empty Trash?', `This permanently deletes ${session.descendants(id).length} item(s) from this project${p.scriv?.dropboxPath ? ' and from Dropbox on next sync' : ''}.`, 'Empty Trash', true)) await session.emptyTrash(); } },
    ];
    return [
      trashed ? { label: 'Restore to Draft', icon: '↩', onClick: () => session.move(id, session.draftId, p.items[session.draftId].children.length) } : null,
      { label: 'New document', icon: '+', onClick: () => addNew('Text', id, special ? 'inside' : 'after') },
      { label: 'New folder', icon: '+', onClick: () => addNew('Folder', id, special ? 'inside' : 'after') },
      !special ? { label: 'New document inside', icon: '↳', onClick: () => addNew('Text', id, 'inside') } : null,
      !special ? { label: 'Rename', icon: '✎', onClick: async () => { const t = await prompt('Rename', it.title); if (t !== null) session.update((pp) => { pp.items[id].title = t.trim() || 'Untitled'; }); } } : null,
      !special ? { label: 'Duplicate', icon: '⧉', onClick: () => session.duplicate(id) } : null,
      !special ? { label: 'Move up', icon: '↑', onClick: () => session.moveBy(id, -1) } : null,
      !special ? { label: 'Move down', icon: '↓', onClick: () => session.moveBy(id, 1) } : null,
      !special ? { label: 'Indent (into item above)', icon: '→', onClick: () => session.indent(id) } : null,
      !special ? { label: 'Outdent', icon: '←', onClick: () => session.outdent(id) } : null,
      !special ? { label: 'Move to…', icon: '⇢', onClick: () => setMoveFor(id) } : null,
      { label: 'Expand all', icon: '⊞', onClick: () => session.update((pp) => { for (const x of session.descendants(id, true)) pp.items[x].expanded = true; }, false) },
      { label: 'Collapse all', icon: '⊟', onClick: () => session.update((pp) => { for (const x of session.descendants(id, true)) pp.items[x].expanded = false; }, false) },
      !special && !trashed ? { label: 'Move to Trash', icon: '🗑', danger: true, onClick: () => { session.trash(id); toast(`“${it.title}” moved to Trash`); } } : null,
    ];
  };

  const ordered = (ids: string[]) => {
    const order = session.descendants(session.draftId, true).concat(session.researchId ? session.descendants(session.researchId, true) : []);
    return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  };

  return (
    <nav className="binder" aria-label="Binder">
      <div className="binder-head">
        <strong className="binder-title" title={p.title}>{p.title}</strong>
        <div className="row tight">
          <button className="icon-btn" onClick={() => { setSelecting(!selecting); setSelected([]); }} aria-pressed={selecting} title="Select several">{selecting ? 'Done' : 'Select'}</button>
          <button className="icon-btn" onClick={() => addNew('Folder')} title="New folder" aria-label="New folder"><Icon name="folder" /></button>
          <button className="icon-btn" onClick={() => addNew('Text')} title="New document" aria-label="New document"><Icon name="plus" /></button>
        </div>
      </div>
      {selecting && (
        <div className="binder-selbar">
          <span>{selected.length} selected</span>
          <button className="btn small" disabled={selected.length < 2} onClick={async () => {
            const ids = ordered(selected).filter((id) => p.items[id].type === 'Text');
            if (await confirm('Merge documents?', `Merge ${ids.length} documents into “${p.items[ids[0]].title}”? Each is snapshotted first; the others go to the Trash.`, 'Merge')) {
              await session.mergeDocs(ids); setSelected([]); setSelecting(false); nav.open(ids[0]);
            }
          }}>Merge</button>
          <button className="btn small" disabled={!selected.length} onClick={() => setMoveFor('__multi__')}>Move</button>
          <button className="btn small danger" disabled={!selected.length} onClick={() => { selected.forEach((id) => session.trash(id)); setSelected([]); }}>Trash</button>
        </div>
      )}
      <ul className="binder-list" role="tree">
        {rows.map(({ it, depth }) => {
          const active = nav.current === it.id;
          const label = p.labels.find((l) => l.id === it.labelId);
          const dropCls = drop?.id === it.id ? `drop-${drop.pos}` : '';
          return (
            <li key={it.id} role="treeitem" aria-selected={active} aria-expanded={it.children.length ? !!it.expanded : undefined}
              className={`binder-row ${active ? 'active' : ''} ${dropCls} ${drag === it.id ? 'dragging' : ''}`}
              style={{ paddingLeft: 6 + depth * 16 }}
              draggable={!session.isSpecial(it.id) && !selecting}
              onDragStart={(e) => { setDrag(it.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); }}
              onDragEnd={() => { setDrag(null); setDrop(null); }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const y = (e.clientY - r.top) / r.height;
                const pos: DropPos = !it.parent ? 'inside' : y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
                if (drop?.id !== it.id || drop.pos !== pos) setDrop({ id: it.id, pos });
              }}
              onDrop={(e) => { e.preventDefault(); if (drop) onDrop(drop.id, drop.pos); }}
            >
              {it.children.length ? (
                <button className={`disclosure ${it.expanded ? 'open' : ''}`} onClick={() => toggle(it.id)} aria-label={it.expanded ? 'Collapse' : 'Expand'}><Icon name="chevron" size={14} /></button>
              ) : <span className="disclosure-spacer" />}
              {selecting && !session.isSpecial(it.id) && (
                <input type="checkbox" aria-label={`Select ${it.title}`} checked={selected.includes(it.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, it.id] : selected.filter((x) => x !== it.id))} />
              )}
              <button className="binder-main" onClick={() => (selecting && !session.isSpecial(it.id) ? setSelected(selected.includes(it.id) ? selected.filter((x) => x !== it.id) : [...selected, it.id]) : open(it.id))}
                onContextMenu={(e) => { e.preventDefault(); setMenuFor(it.id); }}>
                <span className="b-icon" style={label?.color ? { color: label.color } : undefined}><Icon name={itemIcon(it.type, it.wordCount > 0, it.children.length > 0)} size={18} /></span>
                <span className="b-title">{it.title || 'Untitled'}</span>
                {label?.color && it.labelId >= 0 && <span className="label-dot" style={{ background: label.color }} title={label.title} />}
                {session.cachedDoc(it.id)?.conflict && <span className="badge warn" title="Sync conflict">!</span>}
              </button>
              <button className="row-more" onClick={() => setMenuFor(it.id)} aria-label={`Actions for ${it.title}`}><Icon name="more" size={18} /></button>
            </li>
          );
        })}
      </ul>
      {menuFor && p.items[menuFor] && <ActionMenu title={p.items[menuFor].title} items={menuItems(menuFor)} onClose={() => setMenuFor(null)} />}
      {moveFor && (
        <MoveTo session={session} ids={moveFor === '__multi__' ? ordered(selected) : [moveFor]} onClose={() => { setMoveFor(null); if (moveFor === '__multi__') { setSelected([]); setSelecting(false); } }} />
      )}
    </nav>
  );
}

function MoveTo({ session, ids, onClose }: { session: Session; ids: string[]; onClose: () => void }) {
  const p = session.project;
  const targets: { id: string; depth: number }[] = [];
  const walk = (list: string[], depth: number) => {
    for (const id of list) {
      const it = p.items[id];
      if (!it || ids.includes(id) || ids.some((x) => session.isDescendant(id, x))) continue;
      if (it.type === 'Image' || it.type === 'PDF' || it.type === 'Other' || it.type === 'WebArchive') continue;
      targets.push({ id, depth });
      walk(it.children, depth + 1);
    }
  };
  walk(p.rootIds, 0);
  return (
    <Sheet title={`Move ${ids.length > 1 ? `${ids.length} items` : `“${p.items[ids[0]].title}”`} into…`} onClose={onClose}>
      <ul className="pick-list">
        {targets.map(({ id, depth }) => (
          <li key={id}><button style={{ paddingLeft: 12 + depth * 16 }} onClick={() => { for (const x of ids) session.move(x, id, p.items[id].children.length); onClose(); }}>
            <Icon name={itemIcon(p.items[id].type, false, p.items[id].children.length > 0)} size={16} /> {p.items[id].title}
          </button></li>
        ))}
      </ul>
    </Sheet>
  );
}
