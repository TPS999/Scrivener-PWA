import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isFolderish, isTextual } from '../model/types';
import { getPrefs } from '../store/prefs';
import type { Session } from '../store/session';
import { syncSession } from '../sync/actions';
import { getTokens } from '../sync/dropbox';
import { type InspectorTab, type Nav, NavCtx, SessionCtx, type ViewMode, useSession } from './ctx';
import { DocEditor } from './DocEditor';
import { FormatBar } from './FormatBar';
import { Binder } from './Binder';
import { Icon } from './icons';
import { Inspector } from './Inspector';
import { ActionMenu, Sheet, toast, useMedia } from './kit';
import { CompileSheet, ProjectSettingsSheet, SearchSheet, SettingsSheet, StatsSheet, SyncSheet, exportScrivZip } from './Panels';
import { Corkboard, FolderPlaceholder, Outliner, ResearchView, Scrivenings } from './Views';

type SheetName = 'search' | 'compile' | 'stats' | 'settings' | 'project' | 'sync' | null;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

export function ProjectView({ session, onClose }: { session: Session; onClose: () => void }) {
  return <SessionCtx.Provider value={session}><Workspace onClose={onClose} /></SessionCtx.Provider>;
}

function Workspace({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const p = session.project;
  const wide = useMedia('(min-width: 900px)');
  const [current, setCurrent] = useState<string | null>(() => {
    const last = lsGet(`inkwell.last.${p.id}`);
    return last && p.items[last] ? last : null;
  });
  const [views, setViews] = useState<Record<string, ViewMode>>(() => { try { return JSON.parse(lsGet(`inkwell.views.${p.id}`) ?? '{}'); } catch { return {}; } });
  const [showBinder, setShowBinder] = useState(!current);
  const [inspector, setInspector] = useState<{ open: boolean; tab: InspectorTab }>({ open: wide && lsGet('inkwell.inspector') === '1', tab: 'synopsis' });
  const [sheet, setSheet] = useState<SheetName>(null);
  const [menu, setMenu] = useState(false);
  const [compose, setCompose] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);

  const it = current ? p.items[current] : undefined;
  const folderLike = !!it && (isFolderish(it.type) || it.children.length > 0);
  const defaultView: ViewMode = it?.type === 'DraftFolder' || it?.type === 'Folder' ? 'corkboard' : it && it.children.length ? 'scrivenings' : 'editor';
  const view: ViewMode = it ? (folderLike ? views[it.id] ?? defaultView : 'editor') : 'editor';

  const open = useCallback((id: string) => {
    window.dispatchEvent(new Event('inkwell:flush'));
    setCurrent(id);
    lsSet(`inkwell.last.${p.id}`, id);
    if (!wide) setShowBinder(false);
  }, [p.id, wide]);
  const setView = useCallback((v: ViewMode) => {
    if (!current) return;
    const next = { ...views, [current]: v };
    setViews(next);
    lsSet(`inkwell.views.${p.id}`, JSON.stringify(next));
  }, [current, views, p.id]);
  const nav: Nav = useMemo(() => ({
    open, current, view, setView,
    showInspector: (tab?: InspectorTab) => { setInspector((s) => ({ open: true, tab: tab ?? s.tab })); },
    compose: setCompose,
  }), [open, current, view, setView]);

  // keep "current" valid if the item disappears (trash emptied / sync)
  useEffect(() => { if (current && !p.items[current]) { setCurrent(null); setShowBinder(true); } });

  // auto-sync on open, and when the app goes to the background
  useEffect(() => {
    if (!p.scriv?.dropboxPath || !getPrefs().autoSync) return;
    let cancelled = false;
    const run = async (quiet: boolean) => {
      if (!(await getTokens())) return;
      try {
        const r = await syncSession(session);
        if (cancelled) return;
        if (r.status === 'locked') { if (!quiet) toast('Scrivener has this project open elsewhere — sync paused. Use Sync to override.', 'error', 6000); return; }
        if (r.conflicts.length) toast(`${r.conflicts.length} document(s) were edited on two devices — open them to choose.`, 'error', 8000);
        else if (!quiet && (r.downloaded || r.uploaded)) toast('Synced with Dropbox', 'ok');
      } catch (e) { if (!quiet) toast((e as Error).message, 'error', 6000); }
    };
    run(false);
    const vis = () => { if (document.visibilityState === 'hidden') run(true); };
    document.addEventListener('visibilitychange', vis);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', vis); };
  }, [session, p.scriv?.dropboxPath]);

  // comment clicks open the comments tab
  useEffect(() => {
    const f = () => setInspector({ open: true, tab: 'comments' });
    window.addEventListener('inkwell:comment', f);
    return () => window.removeEventListener('inkwell:comment', f);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSheet('search'); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); window.dispatchEvent(new Event('inkwell:flush')); if (p.scriv?.dropboxPath) setSheet('sync'); else toast('Saved on this device', 'ok', 1500); }
      else if (e.key === 'Escape' && compose) setCompose(false);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [compose, p.scriv?.dropboxPath]);

  useEffect(() => { if (wide) lsSet('inkwell.inspector', inspector.open ? '1' : '0'); }, [inspector.open, wide]);

  const conflicts = Object.keys(p.items).some((id) => session.cachedDoc(id)?.conflict);
  const showEditorBar = !!it && (view === 'editor' || view === 'scrivenings') && isTextual(it.type);

  let main: React.ReactNode;
  if (!it) main = <div className="empty"><p>Pick something from the binder{wide ? ' on the left' : ''}.</p></div>;
  else if (it.type === 'TrashFolder') main = <Outliner folderId={it.id} />;
  else if (!isTextual(it.type)) main = <ResearchView itemId={it.id} />;
  else if (view === 'corkboard') main = <Corkboard folderId={it.id} />;
  else if (view === 'outliner') main = <Outliner folderId={it.id} />;
  else if (view === 'scrivenings' && folderLike) main = <Scrivenings key={it.id} folderId={it.id} onEditor={setEditor} />;
  else if (it.type === 'DraftFolder' || it.type === 'ResearchFolder') main = <FolderPlaceholder id={it.id} />;
  else main = <div className="page"><DocEditor key={it.id} itemId={it.id} onEditor={setEditor} autoFocus /></div>;

  const binderEl = <Binder onPicked={() => { if (!wide) setShowBinder(false); }} />;
  const inspectorEl = current && it ? <Inspector itemId={current} tab={inspector.tab} setTab={(t) => setInspector({ open: true, tab: t })} editor={editor} /> : null;

  if (compose && it) return (
    <NavCtx.Provider value={nav}>
      <div className="compose">
        <button className="compose-exit" onClick={() => setCompose(false)} aria-label="Exit composition mode">Done</button>
        <div className="compose-scroll">{view === 'scrivenings' && folderLike ? <Scrivenings folderId={it.id} onEditor={setEditor} /> : <div className="page"><DocEditor itemId={it.id} onEditor={setEditor} autoFocus /></div>}</div>
        {!wide && <FormatBar editor={editor} itemId={view === 'editor' ? current : null} />}
      </div>
    </NavCtx.Provider>
  );

  return (
    <NavCtx.Provider value={nav}>
      <div className={`workspace ${wide ? 'wide' : 'narrow'} ${inspector.open && wide ? 'with-inspector' : ''}`}>
        {(wide || showBinder) && <div className="binder-pane">{!wide && <div className="topbar"><button className="icon-btn" onClick={onClose} aria-label="All projects"><Icon name="back" /> Projects</button><span className="grow" /><button className="icon-btn" onClick={() => setSheet('search')} aria-label="Search project"><Icon name="search" /></button>{p.scriv?.dropboxPath && <SyncButton onClick={() => setSheet('sync')} conflicts={conflicts} />}</div>}{binderEl}</div>}
        {(wide || !showBinder) && (
          <main className="main-pane">
            <div className="topbar">
              {wide ? <button className="icon-btn" onClick={onClose} aria-label="All projects" title="All projects"><Icon name="back" /></button>
                : <button className="icon-btn" onClick={() => setShowBinder(true)} aria-label="Show binder"><Icon name="binder" /></button>}
              <h1 className="doc-title" title={it?.title}>{it?.title || p.title}</h1>
              {folderLike && it?.type !== 'TrashFolder' && (
                <div className="seg small" role="tablist" aria-label="View">
                  {([['scrivenings', 'stack', 'Scrivenings (read & edit together)'], ['corkboard', 'cork', 'Corkboard'], ['outliner', 'outline', 'Outliner']] as const).map(([v, ic, l]) => (
                    <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={l} aria-label={l}><Icon name={ic} size={17} /></button>
                  ))}
                </div>
              )}
              {wide && <button className="icon-btn" onClick={() => setSheet('search')} aria-label="Search project" title="Search (⇧⌘F)"><Icon name="search" /></button>}
              {p.scriv?.dropboxPath && wide && <SyncButton onClick={() => setSheet('sync')} conflicts={conflicts} />}
              <button className={`icon-btn ${inspector.open ? 'on' : ''}`} onClick={() => setInspector((s) => ({ ...s, open: !s.open }))} aria-label="Inspector" aria-pressed={inspector.open} disabled={!it}><Icon name="info" /></button>
              <button className="icon-btn" onClick={() => setMenu(true)} aria-label="More"><Icon name="more" /></button>
            </div>
            {session.syncing && <div className="syncbar" role="status">{session.syncMessage || 'Syncing…'}</div>}
            <div className="content-scroll">{main}</div>
            {showEditorBar && <FormatBar editor={editor} itemId={view === 'editor' ? current : null} />}
          </main>
        )}
        {inspector.open && inspectorEl && (wide
          ? <div className="inspector-pane">{inspectorEl}</div>
          : <Sheet title={it?.title || 'Inspector'} onClose={() => setInspector((s) => ({ ...s, open: false }))}>{inspectorEl}</Sheet>)}
      </div>
      {menu && <ActionMenu onClose={() => setMenu(false)} items={[
        { label: 'Compile / export manuscript', icon: '📄', onClick: () => setSheet('compile') },
        { label: 'Targets & statistics', icon: '🎯', onClick: () => setSheet('stats') },
        { label: 'Composition mode', icon: '⛶', disabled: !it || !isTextual(it.type), onClick: () => setCompose(true) },
        { label: 'Search & replace', icon: '🔍', onClick: () => setSheet('search') },
        { label: p.scriv?.dropboxPath ? 'Dropbox sync' : 'Upload to Dropbox…', icon: '☁', onClick: () => setSheet('sync') },
        { label: 'Back up as .scriv (zip)', icon: '⇩', onClick: () => exportScrivZip(session) },
        { label: 'Labels, status & project info', icon: '🏷', onClick: () => setSheet('project') },
        { label: 'Settings', icon: '⚙', onClick: () => setSheet('settings') },
        { label: 'All projects', icon: '‹', onClick: onClose },
      ]} />}
      {sheet === 'search' && <SearchSheet onClose={() => setSheet(null)} />}
      {sheet === 'compile' && <CompileSheet onClose={() => setSheet(null)} />}
      {sheet === 'stats' && <StatsSheet onClose={() => setSheet(null)} />}
      {sheet === 'settings' && <SettingsSheet onClose={() => setSheet(null)} />}
      {sheet === 'project' && <ProjectSettingsSheet onClose={() => setSheet(null)} />}
      {sheet === 'sync' && <SyncSheet onClose={() => setSheet(null)} />}
    </NavCtx.Provider>
  );
}

function SyncButton({ onClick, conflicts }: { onClick: () => void; conflicts: boolean }) {
  const session = useSession();
  return (
    <button className={`icon-btn ${session.syncing ? 'spin' : ''} ${conflicts ? 'warn' : ''}`} onClick={onClick} aria-label={conflicts ? 'Sync (conflicts need review)' : 'Sync'} title={session.syncing ? session.syncMessage : 'Dropbox sync'}>
      <Icon name="sync" />{conflicts && <span className="dot" />}
    </button>
  );
}
