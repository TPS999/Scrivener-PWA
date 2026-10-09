// Core data model. Binder items live flat in a map; documents (rich text) are
// stored separately and loaded lazily so huge projects open instantly.

export type ItemType =
  | 'DraftFolder' | 'ResearchFolder' | 'TrashFolder'
  | 'Folder' | 'Text' | 'Image' | 'PDF' | 'WebArchive' | 'Other';

export interface BinderItem {
  id: string;            // Scrivener-style uppercase UUID
  type: ItemType;
  title: string;
  parent: string | null; // null = top level
  children: string[];
  created: string;       // ISO
  modified: string;      // ISO
  labelId: number;       // -1 = none
  statusId: number;      // -1 = none
  keywords: number[];
  includeInCompile: boolean;
  synopsis: string;
  wordCount: number;     // cached so outliner/targets never need every doc loaded
  target?: number;       // per-document word target
  expanded?: boolean;
  fileExt?: string;      // for research files (Image/PDF/Other)
  pageBreakBefore?: boolean;
}

export interface Label { id: number; title: string; color: string }
export interface Status { id: number; title: string }
export interface Keyword { id: number; title: string; color: string }

export interface ScrivLink {
  scrivxName: string;          // e.g. "My Novel.scrivx"
  dropboxPath?: string;        // e.g. "/Apps/Scrivener/My Novel.scriv"
  lastSync?: string;
}

export interface Project {
  id: string;
  title: string;
  author: string;
  created: string;
  modified: string;
  rootIds: string[];
  items: Record<string, BinderItem>;
  labels: Label[];
  statuses: Status[];
  keywords: Keyword[];
  targets: { draft: number; session: number; deadline?: string };
  scriv?: ScrivLink;
  binderDirty?: boolean;       // binder changed since last sync
}

// ProseMirror JSON
export type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: PMMark[] };
export type PMMark = { type: string; attrs?: Record<string, unknown> };

export interface DocData {
  key: string;           // `${projectId}:${itemId}`
  projectId: string;
  itemId: string;
  content: PMNode;
  notes: PMNode;
  contentDirty: boolean; // edited since last sync/import (re-serialize on export)
  notesDirty: boolean;
  conflict?: boolean;    // a sync conflict awaits resolution
  lossy?: string[];      // original RTF had content the editor cannot show (images, tables)
  rtfPrefix?: RtfStyle;  // preserved font/colour tables from the original RTF
  modified: string;
  selection?: { from: number; to: number };
  scrollTop?: number;
}

export interface RtfStyle { fonttbl: string; colors: string[]; paraProps: string; charProps: string }

export interface Snapshot {
  id?: number;
  docKey: string;
  title: string;
  date: string;
  content: PMNode;
  kind: 'manual' | 'auto' | 'sync' | 'conflict';
  words: number;
}

export const emptyDoc = (): PMNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export const uuid = () => crypto.randomUUID().toUpperCase();
export const nowIso = () => new Date().toISOString();

export const DEFAULT_LABELS: Label[] = [
  { id: -1, title: 'No Label', color: '' },
  { id: 0, title: 'Concept', color: '#f59a23' },
  { id: 1, title: 'Chapter', color: '#3b82f6' },
  { id: 2, title: 'Scene', color: '#22c55e' },
  { id: 3, title: 'Idea', color: '#a855f7' },
  { id: 4, title: 'Research', color: '#ef4444' },
];
export const DEFAULT_STATUSES: Status[] = [
  { id: -1, title: 'No Status' },
  { id: 0, title: 'To Do' },
  { id: 1, title: 'In Progress' },
  { id: 2, title: 'First Draft' },
  { id: 3, title: 'Revised Draft' },
  { id: 4, title: 'Final Draft' },
  { id: 5, title: 'Done' },
];

export function isFolderish(t: ItemType) {
  return t === 'Folder' || t === 'DraftFolder' || t === 'ResearchFolder' || t === 'TrashFolder';
}
export function isTextual(t: ItemType) {
  return t === 'Text' || t === 'Folder' || t === 'DraftFolder' || t === 'ResearchFolder';
}
