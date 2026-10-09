// Per-device preferences (theme, editor typography). localStorage is fine here:
// losing these only resets cosmetics.
import { useSyncExternalStore } from 'react';

export interface Prefs {
  theme: 'auto' | 'light' | 'dark' | 'sepia';
  font: 'serif' | 'sans' | 'mono';
  fontSize: number;
  lineHeight: number;
  indent: boolean;
  paraSpacing: boolean;
  typewriter: boolean;
  textWidth: number;   // max ch
  autoSync: boolean;   // sync on open and when leaving the app
  showWordCount: boolean;
}
const DEFAULTS: Prefs = { theme: 'auto', font: 'serif', fontSize: 18, lineHeight: 1.6, indent: true, paraSpacing: false, typewriter: false, textWidth: 42, autoSync: true, showWordCount: true };

let current: Prefs = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('inkwell.prefs') ?? '{}') }; } catch { return DEFAULTS; }
})();
const subs = new Set<() => void>();

export function getPrefs() { return current; }
export function setPrefs(p: Partial<Prefs>) {
  current = { ...current, ...p };
  try { localStorage.setItem('inkwell.prefs', JSON.stringify(current)); } catch { /* private mode */ }
  applyPrefs();
  subs.forEach((s) => s());
}
export function usePrefs() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
}
export function applyPrefs() {
  const r = document.documentElement;
  r.dataset.theme = current.theme === 'auto' ? '' : current.theme;
  if (current.theme === 'auto') delete r.dataset.theme;
  const fonts = { serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif", sans: "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif", mono: "'SF Mono', Menlo, Consolas, monospace" };
  r.style.setProperty('--ed-font', fonts[current.font]);
  r.style.setProperty('--ed-size', current.fontSize + 'px');
  r.style.setProperty('--ed-lh', String(current.lineHeight));
  r.style.setProperty('--ed-indent', current.indent ? '1.5em' : '0');
  r.style.setProperty('--ed-pspace', current.paraSpacing ? '0.8em' : '0');
  r.style.setProperty('--ed-width', current.textWidth + 'em');
}
