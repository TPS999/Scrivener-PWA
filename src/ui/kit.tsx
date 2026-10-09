import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

export function Sheet({ title, onClose, children, wide, actions }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <div className="row">{actions}<button className="btn ghost" onClick={onClose}>Done</button></div>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; icon?: string }

export function ActionMenu({ title, items, onClose }: { title?: string; items: (MenuItem | null)[]; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="action-menu" role="menu">
        {title && <div className="action-title">{title}</div>}
        {items.filter(Boolean).map((it, k) => (
          <button key={k} role="menuitem" className={`action-item ${it!.danger ? 'danger' : ''}`} disabled={it!.disabled}
            onClick={() => { onClose(); it!.onClick(); }}>
            {it!.icon && <span className="ai-icon" aria-hidden>{it!.icon}</span>}{it!.label}
          </button>
        ))}
        <button className="action-item cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function mount<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => { root.unmount(); host.remove(); resolve(v); };
    root.render(render(done));
  });
}

function PromptBox({ title, label, initial, multiline, done, okLabel }: { title: string; label?: string; initial: string; multiline?: boolean; okLabel?: string; done: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <Sheet title={title} onClose={() => done(null)}>
      <form onSubmit={(e) => { e.preventDefault(); done(v); }} className="stack">
        {label && <label className="muted">{label}</label>}
        {multiline
          ? <textarea ref={ref} rows={5} value={v} onChange={(e) => setV(e.target.value)} />
          : <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} />}
        <div className="row end"><button type="button" className="btn" onClick={() => done(null)}>Cancel</button><button className="btn primary" type="submit">{okLabel ?? 'OK'}</button></div>
      </form>
    </Sheet>
  );
}
export const prompt = (title: string, initial = '', opts: { label?: string; multiline?: boolean; okLabel?: string } = {}) =>
  mount<string | null>((done) => <PromptBox title={title} initial={initial} done={done} {...opts} />);

export const confirm = (title: string, message: string, okLabel = 'OK', danger = false) =>
  mount<boolean>((done) => (
    <Sheet title={title} onClose={() => done(false)}>
      <p>{message}</p>
      <div className="row end"><button className="btn" onClick={() => done(false)}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => done(true)} autoFocus>{okLabel}</button></div>
    </Sheet>
  ));

let toastHost: HTMLDivElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500) {
  if (!toastHost) { toastHost = document.createElement('div'); toastHost.className = 'toasts'; toastHost.setAttribute('role', 'status'); document.body.appendChild(toastHost); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

/** Keeps --kb set to the on-screen keyboard height (iOS Safari doesn't resize the layout viewport). */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const upd = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${inset}px`);
    };
    vv.addEventListener('resize', upd);
    vv.addEventListener('scroll', upd);
    upd();
    return () => { vv.removeEventListener('resize', upd); vv.removeEventListener('scroll', upd); };
  }, []);
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

export async function saveBlob(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  // On phones the share sheet is the way to "Save to Files"
  if (/iPhone|iPad|Android/i.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtNum = (n: number) => n.toLocaleString();
