import { Component, type ReactNode, useEffect, useState } from 'react';
import { Session } from './store/session';
import { completeAuthIfReturning } from './sync/dropbox';
import { toast, useKeyboardInset } from './ui/kit';
import { ProjectList } from './ui/ProjectList';
import { ProjectView } from './ui/ProjectView';

/** Any render crash shows a recovery screen; data is already on disk, so nothing is lost. */
class Boundary extends Component<{ children: ReactNode; onReset: () => void }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error(err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>Your writing is safe — every change is saved on this device as you type.</p>
        <pre>{String(this.state.err.message)}</pre>
        <button className="btn primary" onClick={() => { this.setState({ err: null }); this.props.onReset(); }}>Back to projects</button>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

export default function App() {
  useKeyboardInset();
  const [session, setSession] = useState<Session | null>(null);
  const [openId, setOpenId] = useState<string | null>(() => { try { return sessionStorage.getItem('inkwell.open'); } catch { return null; } });

  useEffect(() => {
    completeAuthIfReturning().then((ok) => { if (ok) toast('Dropbox connected', 'ok'); }).catch((e) => toast(e.message, 'error', 6000));
  }, []);

  useEffect(() => {
    try { if (openId) sessionStorage.setItem('inkwell.open', openId); else sessionStorage.removeItem('inkwell.open'); } catch { /* */ }
    if (!openId) { setSession(null); return; }
    let alive = true;
    Session.open(openId).then((s) => { if (alive) setSession(s); }).catch(() => { if (alive) setOpenId(null); });
    return () => { alive = false; };
  }, [openId]);

  useEffect(() => {
    const f = () => { window.dispatchEvent(new Event('inkwell:flush')); session?.flush(); };
    window.addEventListener('pagehide', f);
    return () => window.removeEventListener('pagehide', f);
  }, [session]);

  const close = async () => { window.dispatchEvent(new Event('inkwell:flush')); await session?.flush(); setOpenId(null); };

  return (
    <Boundary onReset={() => setOpenId(null)}>
      {openId && session ? <ProjectView key={session.project.id} session={session} onClose={close} /> : openId ? <div className="splash" aria-busy="true" /> : <ProjectList onOpen={setOpenId} />}
    </Boundary>
  );
}
