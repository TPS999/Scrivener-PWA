import { useEffect, useMemo, useState } from 'react';
import { type CompileFormat, type CompileOptions, type CompilePreset, compile } from '../compile/compile';
import type { PMNode } from '../model/types';
import { isTextual } from '../model/types';
import { countWords, docPlainText } from '../scriv/rtf';
import { buildScrivPackage, zipScriv } from '../scriv/scrivProject';
import { type DayStat, listRaw, listStats } from '../store/db';
import { setPrefs, usePrefs } from '../store/prefs';
import { publishToDropbox, syncSession } from '../sync/actions';
import * as dbx from '../sync/dropbox';
import { useNav, useSession } from './ctx';
import { DropboxBrowser } from './ProjectList';
import { Sheet, confirm, fmtDate, saveBlob, toast } from './kit';

// ---------------------------------------------------------------- search & replace

interface Hit { id: string; where: 'title' | 'text' | 'synopsis' | 'notes'; snippets: string[]; count: number }

function makeRegex(q: string, caseSens: boolean, whole: boolean) {
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, caseSens ? 'gu' : 'giu');
}

function replaceInDoc(doc: PMNode, re: RegExp, rep: string): { doc: PMNode; n: number } {
  let n = 0;
  const walk = (node: PMNode): PMNode => {
    if (node.type === 'text' && node.text) {
      const t = node.text.replace(re, () => { n++; return rep; });
      return { ...node, text: t };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk).filter((c) => c.type !== 'text' || c.text) };
  };
  return { doc: walk(doc), n };
}

export function SearchSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const nav = useNav();
  const p = session.project;
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [caseSens, setCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!q.trim()) { setHits(null); return; }
    setBusy(true);
    window.dispatchEvent(new Event('inkwell:flush'));
    const re = makeRegex(q, caseSens, whole);
    const out: Hit[] = [];
    const order = p.rootIds.flatMap((r) => session.descendants(r, true)).filter((id) => !session.inTrash(id) || id === session.trashId);
    for (const id of order) {
      const it = p.items[id];
      const add = (where: Hit['where'], text: string) => {
        const ms = [...text.matchAll(re)];
        if (!ms.length) return;
        out.push({ id, where, count: ms.length, snippets: ms.slice(0, 3).map((m) => { const s = Math.max(0, m.index! - 40); return (s ? '…' : '') + text.slice(s, m.index! + m[0].length + 60).replace(/\n/g, ' ') + '…'; }) });
      };
      add('title', it.title);
      add('synopsis', it.synopsis);
      if (isTextual(it.type)) {
        const d = await session.loadDoc(id);
        if (d) { add('text', docPlainText(d.content)); add('notes', docPlainText(d.notes)); }
      }
    }
    setHits(out);
    setBusy(false);
  };

  const replaceAll = async () => {
    if (!hits) return;
    const re = makeRegex(q, caseSens, whole);
    const textHits = hits.filter((h) => h.where === 'text');
    const total = hits.reduce((s, h) => s + (h.where === 'text' || h.where === 'title' || h.where === 'synopsis' ? h.count : 0), 0);
    if (!(await confirm('Replace all?', `Replace ${total} occurrence(s) of “${q}” with “${rep}” in ${textHits.length} document(s) plus titles and synopses? Every changed document is snapshotted first.`, 'Replace all'))) return;
    let n = 0;
    for (const h of textHits) {
      await session.takeSnapshot(h.id, `Before replacing “${q}”`);
      const d = (await session.loadDoc(h.id))!;
      const r = replaceInDoc(d.content, re, rep);
      n += r.n;
      await session.saveContent(h.id, r.doc);
      await session.replaceDoc(d);
    }
    session.update((pp) => {
      for (const h of hits) {
        if (h.where === 'title') { pp.items[h.id].title = pp.items[h.id].title.replace(re, () => { n++; return rep; }); }
        if (h.where === 'synopsis') { pp.items[h.id].synopsis = pp.items[h.id].synopsis.replace(re, () => { n++; return rep; }); }
      }
    });
    toast(`Replaced ${n} occurrence(s)`, 'ok');
    run();
  };

  return (
    <Sheet title="Search project" onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="row"><input type="search" autoFocus placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find" /><button className="btn primary" type="submit" disabled={busy}>{busy ? '…' : 'Search'}</button></div>
        {showReplace && <div className="row"><input placeholder="Replace with…" value={rep} onChange={(e) => setRep(e.target.value)} aria-label="Replace with" /><button type="button" className="btn" disabled={!hits?.length} onClick={replaceAll}>Replace all</button></div>}
        <div className="row wrap small">
          <label className="check"><input type="checkbox" checked={caseSens} onChange={(e) => setCase(e.target.checked)} /> Match case</label>
          <label className="check"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Whole word</label>
          <button type="button" className="link" onClick={() => setShowReplace(!showReplace)}>{showReplace ? 'Hide replace' : 'Replace…'}</button>
        </div>
      </form>
      {hits && <p className="muted small">{hits.reduce((s, h) => s + h.count, 0)} matches in {new Set(hits.map((h) => h.id)).size} items</p>}
      <ul className="hits">
        {hits?.map((h, k) => (
          <li key={k}><button onClick={() => { nav.open(h.id); onClose(); if (h.where === 'text') setTimeout(() => window.dispatchEvent(new CustomEvent('inkwell:find', { detail: { itemId: h.id, q, caseSens } })), 300); else if (h.where === 'notes') nav.showInspector('notes'); else if (h.where === 'synopsis') nav.showInspector('synopsis'); }}>
            <strong>{p.items[h.id].title || 'Untitled'}</strong> <span className="badge">{h.where}</span> <span className="muted small">×{h.count}</span>
            {h.where !== 'title' && h.snippets.map((s, j) => <div key={j} className="snippet small">{s}</div>)}
          </button></li>
        ))}
      </ul>
    </Sheet>
  );
}

// ---------------------------------------------------------------- compile

export function CompileSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const p = session.project;
  const [o, setO] = useState<CompileOptions>(() => {
    let saved: Partial<CompileOptions> = {};
    try { saved = JSON.parse(localStorage.getItem(`inkwell.compile.${p.id}`) ?? '{}'); } catch { /* */ }
    return {
      format: 'docx', preset: 'manuscript', title: p.title, author: p.author, rootId: session.draftId, onlyIncluded: true,
      folderTitles: true, docTitles: false, sceneSeparator: '#', stripComments: true, stripAnnotations: true, titlePage: true, numberChapters: false,
      ...saved,
    };
  });
  const [busy, setBusy] = useState(false);
  const set = (x: Partial<CompileOptions>) => setO({ ...o, ...x });
  const folders = useMemo(() => [session.draftId, ...session.descendants(session.draftId).filter((id) => p.items[id].children.length || p.items[id].type === 'Folder')], [session, p]);

  const go = async () => {
    setBusy(true);
    try {
      window.dispatchEvent(new Event('inkwell:flush'));
      try { localStorage.setItem(`inkwell.compile.${p.id}`, JSON.stringify(o)); } catch { /* */ }
      const r = await compile(session, o);
      if ('printHtml' in r) {
        const ifr = document.createElement('iframe');
        ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
        document.body.appendChild(ifr);
        ifr.contentDocument!.open(); ifr.contentDocument!.write(r.printHtml); ifr.contentDocument!.close();
        setTimeout(() => { ifr.contentWindow!.focus(); ifr.contentWindow!.print(); setTimeout(() => ifr.remove(), 60000); }, 300);
        toast('Choose “Save as PDF” in the print dialog');
      } else await saveBlob(r.blob, r.filename);
    } catch (e) {
      toast('Compile failed: ' + (e as Error).message, 'error');
    } finally { setBusy(false); }
  };

  const formats: [CompileFormat, string][] = [['docx', 'Word (.docx)'], ['epub', 'ePub e-book'], ['pdf', 'PDF (print)'], ['html', 'Web page'], ['md', 'Markdown'], ['txt', 'Plain text']];
  return (
    <Sheet title="Compile" onClose={onClose} wide actions={<button className="btn primary" onClick={go} disabled={busy}>{busy ? 'Compiling…' : 'Compile'}</button>}>
      <div className="form grid2">
        <label>Format<select value={o.format} onChange={(e) => set({ format: e.target.value as CompileFormat })}>{formats.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Style<select value={o.preset} onChange={(e) => set({ preset: e.target.value as CompilePreset })}>
          <option value="manuscript">Standard manuscript (12pt, double-spaced)</option><option value="novel">Book / novel</option><option value="plain">Plain</option></select></label>
        <label>Title<input value={o.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <label>Author<input value={o.author} onChange={(e) => set({ author: e.target.value })} /></label>
        <label>Compile<select value={o.rootId} onChange={(e) => set({ rootId: e.target.value })}>{folders.map((id) => <option key={id} value={id}>{id === session.draftId ? `Whole ${p.items[id].title}` : p.items[id].title}</option>)}</select></label>
        <label>Scene separator<input value={o.sceneSeparator} onChange={(e) => set({ sceneSeparator: e.target.value })} placeholder="(none)" /></label>
        <label className="check"><input type="checkbox" checked={o.onlyIncluded} onChange={(e) => set({ onlyIncluded: e.target.checked })} /> Only items marked “Include in compile”</label>
        <label className="check"><input type="checkbox" checked={o.titlePage} onChange={(e) => set({ titlePage: e.target.checked })} /> Title page</label>
        <label className="check"><input type="checkbox" checked={o.folderTitles} onChange={(e) => set({ folderTitles: e.target.checked })} /> Folder titles as chapter headings</label>
        <label className="check"><input type="checkbox" checked={o.numberChapters} onChange={(e) => set({ numberChapters: e.target.checked })} /> Number chapters</label>
        <label className="check"><input type="checkbox" checked={o.docTitles} onChange={(e) => set({ docTitles: e.target.checked })} /> Document titles as headings</label>
        <label className="check"><input type="checkbox" checked={o.stripAnnotations} onChange={(e) => set({ stripAnnotations: e.target.checked })} /> Remove inline annotations</label>
      </div>
      <p className="muted small">Comments are never compiled. Footnotes become real footnotes in Word, linked notes in ePub/web, and numbered notes in Markdown/text.</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- statistics & targets

export function StatsSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const p = session.project;
  const [stats, setStats] = useState<DayStat[]>([]);
  useEffect(() => { listStats(p.id).then(setStats); }, [p.id]);
  const draftWords = session.descendants(session.draftId).reduce((s, id) => s + (p.items[id].includeInCompile ? p.items[id].wordCount : 0), 0);
  const allWords = Object.keys(p.items).filter((id) => !session.inTrash(id)).reduce((s, id) => s + p.items[id].wordCount, 0);
  const today = new Date().toLocaleDateString('en-CA');
  const todayWords = stats.find((s) => s.date === today)?.words ?? 0;
  const days: { date: string; words: number }[] = [];
  for (let k = 29; k >= 0; k--) { const d = new Date(); d.setDate(d.getDate() - k); const ds = d.toLocaleDateString('en-CA'); days.push({ date: ds, words: Math.max(0, stats.find((s) => s.date === ds)?.words ?? 0) }); }
  const max = Math.max(1, ...days.map((d) => d.words), p.targets.session || 0);
  let streak = 0;
  for (let k = days.length - 1; k >= 0; k--) { if (days[k].words > 0) streak++; else if (k !== days.length - 1) break; }
  const deadline = p.targets.deadline ? new Date(p.targets.deadline) : null;
  const daysLeft = deadline ? Math.max(1, Math.ceil((+deadline - Date.now()) / 86400000)) : 0;
  const perDay = deadline && p.targets.draft ? Math.max(0, Math.ceil((p.targets.draft - draftWords) / daysLeft)) : 0;
  const setT = (x: Partial<typeof p.targets>) => session.update((pp) => { pp.targets = { ...pp.targets, ...x }; });
  return (
    <Sheet title="Targets & statistics" onClose={onClose} wide>
      <div className="stat-tiles">
        <div className="tile"><div className="tile-n">{draftWords.toLocaleString()}</div><div className="tile-l">words in draft</div>{p.targets.draft > 0 && <progress max={p.targets.draft} value={Math.min(draftWords, p.targets.draft)} />}</div>
        <div className="tile"><div className="tile-n">{todayWords.toLocaleString()}</div><div className="tile-l">written today</div>{p.targets.session > 0 && <progress max={p.targets.session} value={Math.min(Math.max(0, todayWords), p.targets.session)} />}</div>
        <div className="tile"><div className="tile-n">{streak}</div><div className="tile-l">day streak</div></div>
        <div className="tile"><div className="tile-n">{allWords.toLocaleString()}</div><div className="tile-l">words in project</div></div>
      </div>
      <div className="chart" role="img" aria-label="Words written per day, last 30 days">
        {p.targets.session > 0 && <div className="chart-goal" style={{ bottom: `${(p.targets.session / max) * 100}%` }} title="Session target" />}
        {days.map((d) => <div key={d.date} className={`bar ${d.date === today ? 'today' : ''}`} style={{ height: `${(d.words / max) * 100}%` }} title={`${d.date}: ${d.words} words`} />)}
      </div>
      <div className="muted small row between"><span>30 days ago</span><span>today</span></div>
      <div className="form grid2">
        <label>Draft target (words)<input type="number" inputMode="numeric" min={0} value={p.targets.draft || ''} onChange={(e) => setT({ draft: Number(e.target.value) || 0 })} /></label>
        <label>Daily target (words)<input type="number" inputMode="numeric" min={0} value={p.targets.session || ''} onChange={(e) => setT({ session: Number(e.target.value) || 0 })} /></label>
        <label>Deadline<input type="date" value={p.targets.deadline?.slice(0, 10) ?? ''} onChange={(e) => setT({ deadline: e.target.value || undefined })} /></label>
        {perDay > 0 && <p className="callout">To finish by {deadline!.toLocaleDateString()}, write about <strong>{perDay.toLocaleString()}</strong> words a day ({daysLeft} days left).</p>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- project settings

export function ProjectSettingsSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const p = session.project;
  return (
    <Sheet title="Project settings" onClose={onClose} wide>
      <div className="form grid2">
        <label>Project title<input value={p.title} onChange={(e) => session.update((pp) => { pp.title = e.target.value; }, false)} disabled={!!p.scriv?.dropboxPath} title={p.scriv?.dropboxPath ? 'Rename linked projects in Dropbox/Scrivener' : ''} /></label>
        <label>Author<input value={p.author} onChange={(e) => session.update((pp) => { pp.author = e.target.value; }, false)} /></label>
      </div>
      <h3>Labels</h3>
      <ul className="edit-list">
        {p.labels.filter((l) => l.id >= 0).map((l) => (
          <li key={l.id} className="row">
            <input type="color" value={l.color || '#888888'} aria-label="Label colour" onChange={(e) => session.update((pp) => { pp.labels.find((x) => x.id === l.id)!.color = e.target.value; })} />
            <input value={l.title} aria-label="Label name" onChange={(e) => session.update((pp) => { pp.labels.find((x) => x.id === l.id)!.title = e.target.value; })} />
            <button className="btn small ghost danger" onClick={() => session.update((pp) => { pp.labels = pp.labels.filter((x) => x.id !== l.id); for (const it of Object.values(pp.items)) if (it.labelId === l.id) it.labelId = -1; })}>Remove</button>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => session.update((pp) => { pp.labels.push({ id: Math.max(0, ...pp.labels.map((l) => l.id)) + 1, title: 'New label', color: '#6b8afd' }); })}>Add label</button>
      <h3>Status</h3>
      <ul className="edit-list">
        {p.statuses.filter((s) => s.id >= 0).map((s) => (
          <li key={s.id} className="row">
            <input value={s.title} aria-label="Status name" onChange={(e) => session.update((pp) => { pp.statuses.find((x) => x.id === s.id)!.title = e.target.value; })} />
            <button className="btn small ghost danger" onClick={() => session.update((pp) => { pp.statuses = pp.statuses.filter((x) => x.id !== s.id); for (const it of Object.values(pp.items)) if (it.statusId === s.id) it.statusId = -1; })}>Remove</button>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => session.update((pp) => { pp.statuses.push({ id: Math.max(0, ...pp.statuses.map((s) => s.id)) + 1, title: 'New status' }); })}>Add status</button>
    </Sheet>
  );
}

// ---------------------------------------------------------------- sync

export function SyncSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const nav = useNav();
  const p = session.project;
  const [connected, setConnected] = useState<boolean | null>(null);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState('');
  useEffect(() => { dbx.getTokens().then((t) => setConnected(!!t)); }, []);
  const conflicts = Object.keys(p.items).filter((id) => session.cachedDoc(id)?.conflict);

  const doSync = async (ignoreLock = false) => {
    try {
      const r = await syncSession(session, { ignoreLock });
      if (r.status === 'locked') {
        if (await confirm('Project open elsewhere', `Scrivener seems to have this project open on another device (${r.lockFile}). Syncing while it’s open there can make it overwrite what you send. Close it there first, or sync anyway.`, 'Sync anyway')) return doSync(true);
        return;
      }
      toast(r.conflicts.length ? `Synced with ${r.conflicts.length} conflict(s) to review` : `Synced · ↓${r.downloaded} ↑${r.uploaded}`, r.conflicts.length ? 'error' : 'ok');
      r.notes.forEach((n) => toast(n));
    } catch (e) { toast((e as Error).message, 'error', 6000); }
  };

  return (
    <Sheet title="Dropbox sync" onClose={onClose}>
      {p.scriv?.dropboxPath ? (
        <div className="stack">
          <p>Linked to <code>{p.scriv.dropboxPath}</code></p>
          <p className="muted small">Last synced {fmtDate(p.scriv.lastSync)}</p>
          <button className="btn primary" disabled={session.syncing} onClick={() => doSync()}>{session.syncing ? session.syncMessage || 'Syncing…' : 'Sync now'}</button>
          {conflicts.length > 0 && <div className="callout warn"><strong>Needs your decision:</strong><ul>{conflicts.map((id) => <li key={id}><button className="link" onClick={() => { nav.open(id); onClose(); }}>{p.items[id].title}</button></li>)}</ul></div>}
          <details><summary>How sync keeps your work safe</summary>
            <ul className="small">
              <li>Everything is saved on this device first; sync never blocks writing.</li>
              <li>Before any document is changed by a sync, a snapshot of it is taken.</li>
              <li>If a document was edited on two devices, both versions are kept and you choose.</li>
              <li>Uploads only succeed if the file in Dropbox is the version we last saw, so a sync can’t overwrite a newer edit.</li>
              <li>Documents upload before the binder, so Scrivener never sees a half-synced project.</li>
            </ul>
          </details>
        </div>
      ) : connected === false ? (
        <div className="stack"><p>Connect Dropbox in Settings to sync this project with Scrivener.</p></div>
      ) : (
        <div className="stack">
          <p>This project lives only on this device. Upload it to Dropbox as a Scrivener project?</p>
          <button className="btn primary" onClick={() => setPick(true)}>Choose Dropbox folder…</button>
          {busy && <p className="muted">{busy}</p>}
        </div>
      )}
      {pick && <DropboxBrowser title="Upload into which folder?" pickFolder onPick={async (folder) => {
        setPick(false);
        try { const path = await publishToDropbox(session, folder, setBusy); setBusy(''); toast(`Uploaded to ${path}`, 'ok'); }
        catch (e) { setBusy(''); toast((e as Error).message, 'error', 6000); }
      }} onClose={() => setPick(false)} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const [appKey, setAppKeyState] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [usage, setUsage] = useState('');
  useEffect(() => {
    dbx.getAppKey().then(setAppKeyState);
    dbx.getTokens().then((t) => { if (t) dbx.currentAccountName().then(setAccount).catch(() => setAccount('connected')); });
    navigator.storage?.estimate?.().then((e) => setUsage(`${((e.usage ?? 0) / 1048576).toFixed(1)} MB used`));
  }, []);
  return (
    <Sheet title="Settings" onClose={onClose} wide>
      <h3>Appearance</h3>
      <div className="form grid2">
        <label>Theme<select value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value as never })}><option value="auto">Match device</option><option value="light">Light</option><option value="sepia">Sepia</option><option value="dark">Dark</option></select></label>
        <label>Font<select value={prefs.font} onChange={(e) => setPrefs({ font: e.target.value as never })}><option value="serif">Serif</option><option value="sans">Sans-serif</option><option value="mono">Typewriter</option></select></label>
        <label>Text size: {prefs.fontSize}px<input type="range" min={13} max={28} value={prefs.fontSize} onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })} /></label>
        <label>Line spacing: {prefs.lineHeight}<input type="range" min={1.2} max={2.4} step={0.1} value={prefs.lineHeight} onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })} /></label>
        <label>Page width: {prefs.textWidth}em<input type="range" min={24} max={60} value={prefs.textWidth} onChange={(e) => setPrefs({ textWidth: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={prefs.indent} onChange={(e) => setPrefs({ indent: e.target.checked })} /> Indent paragraphs</label>
        <label className="check"><input type="checkbox" checked={prefs.paraSpacing} onChange={(e) => setPrefs({ paraSpacing: e.target.checked })} /> Space between paragraphs</label>
        <label className="check"><input type="checkbox" checked={prefs.typewriter} onChange={(e) => setPrefs({ typewriter: e.target.checked })} /> Typewriter scrolling</label>
        <label className="check"><input type="checkbox" checked={prefs.showWordCount} onChange={(e) => setPrefs({ showWordCount: e.target.checked })} /> Show word count</label>
      </div>
      <h3>Dropbox</h3>
      <div className="form">
        <label>Dropbox app key
          <input value={appKey} onChange={(e) => setAppKeyState(e.target.value)} onBlur={() => dbx.setAppKey(appKey)} placeholder="from dropbox.com/developers/apps" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <details className="small"><summary>How to get an app key (2 minutes, once)</summary>
          <ol>
            <li>Go to <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">dropbox.com/developers/apps</a> → <em>Create app</em>.</li>
            <li>Choose <strong>Scoped access</strong> → <strong>Full Dropbox</strong> (Scrivener projects live in your normal Dropbox, e.g. <code>/Apps/Scrivener</code>).</li>
            <li>On the <em>Permissions</em> tab tick <code>files.metadata.read</code>, <code>files.content.read</code>, <code>files.content.write</code>, <code>account_info.read</code> → Submit.</li>
            <li>On <em>Settings</em>, add this redirect URI: <code>{dbx.redirectUri()}</code></li>
            <li>Copy the <strong>App key</strong> here.</li>
          </ol>
        </details>
        <label className="check"><input type="checkbox" checked={prefs.autoSync} onChange={(e) => setPrefs({ autoSync: e.target.checked })} /> Sync automatically when opening a project and when leaving the app</label>
        {account ? (
          <div className="row"><span>Connected: {account}</span><button className="btn small" onClick={async () => { await dbx.signOut(); setAccount(null); }}>Disconnect</button></div>
        ) : (
          <button className="btn primary" disabled={!appKey} onClick={async () => { await dbx.setAppKey(appKey); dbx.startAuth().catch((e) => toast(e.message, 'error')); }}>Connect Dropbox</button>
        )}
      </div>
      <h3>Storage</h3>
      <p className="muted small">{usage} · Everything is stored on this device, and the browser is asked to protect it from automatic clean-up. Use “Export .scriv” on the projects screen for an extra backup.</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- export .scriv zip

export async function exportScrivZip(session: ReturnType<typeof useSession>) {
  window.dispatchEvent(new Event('inkwell:flush'));
  await session.flush();
  const p = session.project;
  const docs = new Map();
  for (const id of Object.keys(p.items)) { const d = await session.loadDoc(id); if (d) docs.set(id, d); }
  const raw = new Map((await listRaw(p.id)).map((r) => [r.path, r.data]));
  const files = buildScrivPackage(p, docs, raw);
  await saveBlob(new Blob([zipScriv(p, files) as BlobPart], { type: 'application/zip' }), `${p.title}.scriv.zip`);
}

export { countWords };
