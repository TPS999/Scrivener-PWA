import { useEffect, useRef, useState } from 'react';
import { type PMNode, type Project, DEFAULT_LABELS, DEFAULT_STATUSES, emptyDoc, nowIso, uuid } from '../model/types';
import { ensureSpecialFolders, importScriv, normaliseScrivFiles, unzipScriv } from '../scriv/scrivProject';
import * as store from '../store/db';
import { Session } from '../store/session';
import { openFromDropbox } from '../sync/actions';
import * as dbx from '../sync/dropbox';
import { Icon } from './icons';
import { ActionMenu, Sheet, confirm, fmtDate, prompt, toast } from './kit';
import { SettingsSheet, exportScrivZip } from './Panels';

const para = (t: string): PMNode => ({ type: 'doc', content: t.split('\n').map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })) });

async function createProject(title: string, template: 'blank' | 'novel' | 'short') {
  const id = uuid();
  const now = nowIso();
  const p: Project = { id, title, author: '', created: now, modified: now, rootIds: [], items: {}, labels: DEFAULT_LABELS, statuses: DEFAULT_STATUSES, keywords: [], targets: { draft: template === 'novel' ? 80000 : template === 'short' ? 5000 : 0, session: 0 } };
  ensureSpecialFolders(p);
  await store.putProject(p);
  const s = await Session.open(id);
  const draft = s.draftId;
  const research = s.researchId!;
  if (template === 'novel') {
    const ch = await s.addItem('Folder', draft, 'inside', 'Chapter 1');
    s.project.items[ch].labelId = 1;
    await s.addItem('Text', ch, 'inside', 'Scene 1');
    const chars = await s.addItem('Folder', research, 'inside', 'Characters');
    await s.addItem('Text', chars, 'inside', 'Character sketch', para('Name:\nRole in story:\nWants:\nNeeds:\nFlaw:\nArc:\nPhysical description:\nVoice / how they talk:'));
    const places = await s.addItem('Folder', research, 'inside', 'Places');
    await s.addItem('Text', places, 'inside', 'Setting sketch', para('Name:\nWhere it is:\nWhat it looks, sounds and smells like:\nWhy it matters to the story:'));
    for (const id2 of [chars, places]) s.project.items[id2].includeInCompile = false;
  } else if (template === 'short') {
    await s.addItem('Text', draft, 'inside', title);
  } else {
    await s.addItem('Text', draft, 'inside', 'Untitled', emptyDoc());
  }
  s.project.binderDirty = false;
  await s.flush();
  return id;
}

async function saveImported(files: Map<string, Uint8Array>, name: string) {
  const { project, docs } = importScriv(files, name);
  const d = await store.db();
  const tx = d.transaction(['projects', 'docs', 'raw'], 'readwrite');
  await tx.objectStore('projects').put(project);
  for (const doc of docs) await tx.objectStore('docs').put(doc);
  for (const [path, data] of files) await tx.objectStore('raw').put({ key: store.rawKey(project.id, path), projectId: project.id, path, data });
  await tx.done;
  const lossy = docs.filter((x) => x.lossy?.length).length;
  return { id: project.id, lossy };
}

export function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [menu, setMenu] = useState<Project | null>(null);
  const [newSheet, setNewSheet] = useState(false);
  const [settings, setSettings] = useState(false);
  const [dbxPick, setDbxPick] = useState(false);
  const [busy, setBusy] = useState('');
  const zipRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const reload = () => store.listProjects().then((ps) => setProjects(ps.sort((a, b) => b.modified.localeCompare(a.modified))));
  useEffect(() => { reload(); }, []);

  const importZip = async (f: File) => {
    setBusy('Importing…');
    try {
      const { files, name } = unzipScriv(new Uint8Array(await f.arrayBuffer()));
      const r = await saveImported(files, name);
      toast(`Imported “${name}”${r.lossy ? ` — ${r.lossy} document(s) with images/tables are protected from editing` : ''}`, 'ok', 6000);
      onOpen(r.id);
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(''); }
  };
  const importDir = async (list: FileList) => {
    setBusy('Importing…');
    try {
      const obj: Record<string, Uint8Array> = {};
      for (const f of Array.from(list)) obj[(f as File & { webkitRelativePath: string }).webkitRelativePath || f.name] = new Uint8Array(await f.arrayBuffer());
      const { files, name } = normaliseScrivFiles(obj);
      const r = await saveImported(files, name);
      toast(`Imported “${name}”`, 'ok');
      onOpen(r.id);
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(''); }
  };

  return (
    <div className="home">
      <header className="home-head">
        <h1><span className="logo" aria-hidden>✒︎</span> Inkwell</h1>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings"><Icon name="gear" /></button>
      </header>
      <div className="home-actions">
        <button className="btn primary" onClick={() => setNewSheet(true)}><Icon name="plus" size={18} /> New project</button>
        <button className="btn" onClick={() => setDbxPick(true)}><Icon name="cloud" size={18} /> Open from Dropbox</button>
        <button className="btn" onClick={() => zipRef.current?.click()}><Icon name="download" size={18} /> Import .scriv (zip)</button>
        <button className="btn ghost" onClick={() => dirRef.current?.click()}>Import .scriv folder</button>
        <input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importZip(f); }} />
        <input ref={dirRef} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={(e) => { const l = e.target.files; if (l?.length) importDir(l); e.target.value = ''; }} />
      </div>
      {import.meta.env.VITE_PREVIEW && (
        <p className="callout small">This is a preview for trying the writing tools. Dropbox sync, compile downloads and .scriv export need the app hosted at its own address (see the README); this preview’s frame blocks them.</p>
      )}
      {busy && <p className="muted" role="status">{busy}</p>}
      {projects && !projects.length && (
        <div className="empty welcome">
          <h2>Write anywhere. Lose nothing.</h2>
          <p>Create a project, import a Scrivener project (zip it in Files/Finder first), or open one straight from Dropbox to keep working with Scrivener on your computer.</p>
        </div>
      )}
      <ul className="project-grid">
        {projects?.map((p) => {
          const words = Object.values(p.items).reduce((s, i) => s + (i.wordCount || 0), 0);
          return (
            <li key={p.id} className="project-card">
              <button className="pc-main" onClick={() => onOpen(p.id)}>
                <strong>{p.title}</strong>
                <span className="muted small">{words.toLocaleString()} words · {fmtDate(p.modified)}</span>
                {p.scriv?.dropboxPath && <span className="badge sync" title={p.scriv.dropboxPath}>Dropbox</span>}
              </button>
              <button className="row-more" onClick={() => setMenu(p)} aria-label={`Actions for ${p.title}`}><Icon name="more" /></button>
            </li>
          );
        })}
      </ul>
      {menu && <ActionMenu title={menu.title} onClose={() => setMenu(null)} items={[
        { label: 'Open', onClick: () => onOpen(menu.id) },
        { label: 'Export as .scriv (zip)', onClick: async () => { const s = await Session.open(menu.id); await exportScrivZip(s); } },
        !menu.scriv?.dropboxPath ? { label: 'Rename', onClick: async () => { const t = await prompt('Rename project', menu.title); if (t) { await store.putProject({ ...menu, title: t }); reload(); } } } : null,
        { label: 'Delete from this device', danger: true, onClick: async () => {
          if (await confirm('Delete project?', menu.scriv?.dropboxPath
            ? `This removes “${menu.title}” from this device only. The copy in Dropbox is not touched. Unsynced changes on this device will be lost.`
            : `This permanently deletes “${menu.title}” and its snapshots from this device. Export it first if you might want it back.`, 'Delete', true)) {
            await store.deleteProject(menu.id); reload();
          }
        } },
      ]} />}
      {newSheet && <NewProject onClose={() => setNewSheet(false)} onCreated={(id) => { setNewSheet(false); onOpen(id); }} />}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      {dbxPick && <DropboxBrowser title="Open a Scrivener project" onClose={() => setDbxPick(false)} onPick={async (path) => {
        setDbxPick(false);
        setBusy('Downloading…');
        try { const id = await openFromDropbox(path, setBusy); onOpen(id); }
        catch (e) { toast((e as Error).message, 'error', 6000); }
        finally { setBusy(''); }
      }} />}
    </div>
  );
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [tpl, setTpl] = useState<'blank' | 'novel' | 'short'>('novel');
  return (
    <Sheet title="New project" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); onCreated(await createProject(title.trim() || 'Untitled Project', tpl)); }}>
        <label>Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled Project" /></label>
        <div className="tpl-grid" role="radiogroup" aria-label="Template">
          {([['novel', 'Novel', 'Chapters & scenes, character and setting sketches, 80k target'], ['short', 'Short story', 'One document, 5k target'], ['blank', 'Blank', 'Just an empty draft']] as const).map(([k, l, d]) => (
            <button type="button" key={k} role="radio" aria-checked={tpl === k} className={`tpl ${tpl === k ? 'on' : ''}`} onClick={() => setTpl(k)}><strong>{l}</strong><span className="muted small">{d}</span></button>
          ))}
        </div>
        <div className="row end"><button className="btn primary" type="submit">Create</button></div>
      </form>
    </Sheet>
  );
}

export function DropboxBrowser({ title, onPick, onClose, pickFolder }: { title: string; onPick: (path: string) => void; onClose: () => void; pickFolder?: boolean }) {
  const [path, setPath] = useState('/Apps/Scrivener');
  const [entries, setEntries] = useState<dbx.DbxEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => { dbx.getTokens().then((t) => setConnected(!!t)); }, []);
  useEffect(() => {
    if (!connected) return;
    setEntries(null); setErr(null);
    dbx.listFolder(path).then((es) => setEntries(es.filter((e) => e.tag === 'folder').sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => { if (path !== '' && path !== '/' && String(e.message).includes('not_found')) setPath(''); else setErr(e.message); });
  }, [path, connected]);
  const up = () => setPath(path.split('/').slice(0, -1).join('/'));
  return (
    <Sheet title={title} onClose={onClose}>
      {connected === false ? (
        <div className="stack"><p>Connect your Dropbox account first (Settings → Dropbox).</p>
          <button className="btn primary" onClick={() => dbx.startAuth().catch((e) => toast(e.message, 'error'))}>Connect Dropbox</button></div>
      ) : (
        <div className="stack">
          <div className="row"><button className="btn small" disabled={!path || path === '/'} onClick={up}>‹ Up</button><code className="path">{path || '/'}</code></div>
          {err && <p className="error">{err}</p>}
          {!entries && !err && <p className="muted">Loading…</p>}
          <ul className="pick-list">
            {entries?.map((e) => {
              const isScriv = /\.scriv$/i.test(e.name);
              return (
                <li key={e.path}><button onClick={() => (isScriv && !pickFolder ? onPick(e.path) : setPath(e.path))} disabled={isScriv && pickFolder}>
                  <Icon name={isScriv ? 'draft' : 'folder'} size={18} /> {e.name} {isScriv && !pickFolder && <span className="badge">open</span>}
                </button></li>
              );
            })}
            {entries && !entries.length && <li className="muted">Empty folder</li>}
          </ul>
          {pickFolder && <button className="btn primary" onClick={() => onPick(path || '')}>Use this folder</button>}
        </div>
      )}
    </Sheet>
  );
}
