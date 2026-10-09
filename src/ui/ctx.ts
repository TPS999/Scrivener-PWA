import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Session } from '../store/session';

export const SessionCtx = createContext<Session | null>(null);

/** Returns the session and re-renders whenever the project changes. */
export function useSession() {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('No session');
  useSyncExternalStore(s.subscribe, s.getVersion);
  return s;
}

export interface Nav {
  open: (id: string) => void;
  current: string | null;
  setView: (v: ViewMode) => void;
  view: ViewMode;
  showInspector: (tab?: InspectorTab) => void;
  compose: (on: boolean) => void;
}
export type ViewMode = 'editor' | 'scrivenings' | 'corkboard' | 'outliner';
export type InspectorTab = 'synopsis' | 'meta' | 'notes' | 'snapshots' | 'comments';
export const NavCtx = createContext<Nav | null>(null);
export const useNav = () => useContext(NavCtx)!;
