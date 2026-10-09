import type { Editor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { isTextual } from '../model/types';
import { loadResearchFile } from '../sync/actions';
import { useNav, useSession } from './ctx';
import { DocEditor } from './DocEditor';
import { Icon, itemIcon } from './icons';
import { ActionMenu, toast } from './kit';

// ---------------------------------------------------------------- corkboard

export function Corkboard({ folderId }: { folderId: string }) {
  const session = useSession();
  const nav = useNav();
  const p = session.project;
  const folder = p.items[folderId];
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  if (!folder.children.length) return (
    <div className="empty">
      <p>No cards yet.</p>
      <button className="btn primary" onClick={() => session.addItem('Text', folderId, 'inside').then(nav.open)}>Add a card</button>
    </div>
  );

  return (
    <div className="corkboard" role="list" aria-label={`Corkboard: ${folder.title}`}>
      {folder.children.map((id, idx) => {
        const it = p.items[id];
        if (!it) return null;
        const label = p.labels.find((l) => l.id === it.labelId && l.id >= 0);
        const status = p.statuses.find((s) => s.id === it.statusId && s.id >= 0);
        return (
          <article key={id} role="listitem" className={`card ${over === id ? 'drop-target' : ''} ${drag === id ? 'dragging' : ''}`}
            style={label?.color ? { ['--label' as string]: label.color } : undefined}
            draggable
            onDragStart={(e) => { setDrag(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
            onDragEnd={() => { setDrag(null); setOver(null); }}
            onDragOver={(e) => { if (drag && drag !== id) { e.preventDefault(); setOver(id); } }}
            onDrop={(e) => { e.preventDefault(); if (drag && drag !== id) session.move(drag, folderId, idx + (folder.children.indexOf(drag) < idx ? 1 : 0)); setDrag(null); setOver(null); }}
          >
            <header className="card-head">
              <input className="card-title" value={it.title} aria-label="Card title"
                onChange={(e) => session.update((pp) => { pp.items[id].title = e.target.value; })} />
              <button className="row-more" aria-label="Card actions" onClick={() => setMenu(id)}><Icon name="more" size={16} /></button>
            </header>
            <textarea className="card-syn" value={it.synopsis} placeholder="Synopsis…" aria-label={`Synopsis for ${it.title}`}
              onChange={(e) => session.update((pp) => { pp.items[id].synopsis = e.target.value; }, false)} />
            <footer className="card-foot">
              <button className="link" onClick={() => nav.open(id)}>Open</button>
              {it.children.length > 0 && <span className="muted">{it.children.length} inside</span>}
              <span className="muted">{it.wordCount.toLocaleString()} w</span>
              {status && <span className="stamp">{status.title}</span>}
            </footer>
          </article>
        );
      })}
      <button className="card add-card" onClick={() => session.addItem('Text', folderId, 'inside')} aria-label="Add card"><Icon name="plus" size={28} /></button>
      {menu && <ActionMenu title={p.items[menu]?.title} onClose={() => setMenu(null)} items={[
        { label: 'Open', onClick: () => nav.open(menu) },
        { label: 'Move left', onClick: () => session.moveBy(menu, -1) },
        { label: 'Move right', onClick: () => session.moveBy(menu, 1) },
        { label: 'Duplicate', onClick: () => session.duplicate(menu) },
        { label: 'Move to Trash', danger: true, onClick: () => session.trash(menu) },
      ]} />}
    </div>
  );
}

// ---------------------------------------------------------------- outliner

export function Outliner({ folderId }: { folderId: string }) {
  const session = useSession();
  const nav = useNav();
  const p = session.project;
  const rows: { id: string; depth: number }[] = [];
  const walk = (ids: string[], depth: number) => { for (const id of ids) { if (!p.items[id]) continue; rows.push({ id, depth }); walk(p.items[id].children, depth + 1); } };
  walk(p.items[folderId].children, 0);
  const total = rows.reduce((s, r) => s + p.items[r.id].wordCount, 0);
  return (
    <div className="outliner-wrap">
      <table className="outliner">
        <thead><tr><th>Title &amp; synopsis</th><th>Label</th><th>Status</th><th className="num">Words</th><th className="num">Target</th><th title="Include in compile">Compile</th></tr></thead>
        <tbody>
          {rows.map(({ id, depth }) => {
            const it = p.items[id];
            const label = p.labels.find((l) => l.id === it.labelId);
            return (
              <tr key={id}>
                <td style={{ paddingLeft: 8 + depth * 18 }}>
                  <button className="link strong" onClick={() => nav.open(id)}>{it.title || 'Untitled'}</button>
                  {it.synopsis && <div className="muted small clamp2">{it.synopsis}</div>}
                </td>
                <td>
                  <span className="label-dot" style={{ background: label?.color || 'transparent' }} />
                  <select aria-label="Label" value={it.labelId} onChange={(e) => session.update((pp) => { pp.items[id].labelId = Number(e.target.value); })}>
                    {p.labels.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                  </select>
                </td>
                <td>
                  <select aria-label="Status" value={it.statusId} onChange={(e) => session.update((pp) => { pp.items[id].statusId = Number(e.target.value); })}>
                    {p.statuses.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </td>
                <td className="num">{it.wordCount.toLocaleString()}</td>
                <td className="num">{it.target ? <progress max={it.target} value={Math.min(it.wordCount, it.target)} title={`${it.wordCount}/${it.target}`} /> : '—'}</td>
                <td className="center"><input type="checkbox" aria-label="Include in compile" checked={it.includeInCompile} onChange={(e) => session.update((pp) => { pp.items[id].includeInCompile = e.target.checked; })} /></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><td>Total</td><td /><td /><td className="num">{total.toLocaleString()}</td><td /><td /></tr></tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- scrivenings

/** Every text document under a folder, each in its own editor, read as one. */
export function Scrivenings({ folderId, onEditor }: { folderId: string; onEditor: (e: Editor | null) => void }) {
  const session = useSession();
  const nav = useNav();
  const ids = session.textDescendants(folderId, session.project.items[folderId].type !== 'DraftFolder' && session.project.items[folderId].wordCount > 0);
  if (!ids.length) return <div className="empty">This folder has no text documents yet.</div>;
  return (
    <div className="scrivenings">
      {ids.map((id) => (
        <section key={id} className="scriv-section">
          <div className="scriv-divider"><button className="link" onClick={() => nav.open(id)}>{session.project.items[id].title || 'Untitled'}</button></div>
          <LazyMount><DocEditor itemId={id} inScrivenings onEditor={(e) => { if (e) e.on('focus', () => onEditor(e)); }} /></LazyMount>
        </section>
      ))}
    </div>
  );
}

/** Mounts children only once scrolled near, so 300-scene folders open instantly. */
function LazyMount({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } }, { rootMargin: '1200px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} style={show ? undefined : { minHeight: 200 }}>{show ? children : null}</div>;
}

// ---------------------------------------------------------------- research files

export function ResearchView({ itemId }: { itemId: string }) {
  const session = useSession();
  const it = session.project.items[itemId];
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    loadResearchFile(session, itemId).then((data) => {
      if (!data) { setErr('This file isn’t on this device yet.'); return; }
      const ext = (it.fileExt ?? '').toLowerCase();
      const type = ext === 'pdf' ? 'application/pdf' : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';
      u = URL.createObjectURL(new Blob([data as BlobPart], { type }));
      setUrl(u);
    }).catch((e) => setErr(String(e.message ?? e)));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [itemId, session, it.fileExt]);
  if (err) return <div className="empty">{err}</div>;
  if (!url) return <div className="empty">Loading…</div>;
  if (it.type === 'Image') return <div className="research"><img src={url} alt={it.title} /></div>;
  if (it.type === 'PDF') return <div className="research"><iframe src={url} title={it.title} /></div>;
  return <div className="empty"><a className="btn" href={url} download={`${it.title}.${it.fileExt ?? 'bin'}`}>Download {it.title}</a></div>;
}

export function FolderPlaceholder({ id }: { id: string }) {
  const session = useSession();
  const it = session.project.items[id];
  return <div className="empty"><Icon name={itemIcon(it.type, false, true)} size={40} /><p>{it.title}</p></div>;
}

export function canHaveText(type: string) { return isTextual(type as never); }
export { toast };
