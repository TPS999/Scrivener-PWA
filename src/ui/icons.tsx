const P: Record<string, string> = {
  doc: 'M6 3h8l4 4v14H6z M14 3v4h4',
  docText: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15h6 M9 18h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  draft: 'M4 4h12l4 4v12H4z M8 10h8 M8 14h8 M8 18h5',
  research: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12 M14.5 14.5L20 20',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9.5a1 1 0 1 0 0 .1',
  pdf: 'M6 3h8l4 4v14H6z M9 13h2a1.5 1.5 0 0 0 0-3H9v6',
  chevron: 'M9 6l6 6-6 6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  plus: 'M12 5v14 M5 12h14',
  back: 'M15 6l-6 6 6 6',
  binder: 'M4 5h16 M4 12h16 M4 19h16',
  info: 'M12 8h.01 M11 12h1v5h1 M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  search: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12 M14.5 14.5L20 20',
  sync: 'M4 12a8 8 0 0 1 14-5l2 2 M20 4v5h-5 M20 12a8 8 0 0 1-14 5l-2-2 M4 20v-5h5',
  cork: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  outline: 'M4 6h16 M8 12h12 M8 18h12 M4 12h.01 M4 18h.01',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  stack: 'M5 4h14v6H5z M5 14h14v6H5z',
  compose: 'M4 4h6 M4 4v6 M20 4h-6 M20 4v6 M4 20h6 M4 20v-6 M20 20h-6 M20 20v-6',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10 M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  comment: 'M4 5h16v11H9l-5 4z',
  footnote: 'M6 18h12 M9 6h2v8 M15 6l-2 4h4',
  annot: 'M4 6h16 M4 10h16 M4 14h9 M15 13l4 4-2 2-4-4z',
  split: 'M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4z M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  align: 'M4 6h16 M7 10h10 M4 14h16 M7 18h10',
  quote: 'M7 7h4v4c0 3-2 5-4 6 M15 7h4v4c0 3-2 5-4 6',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  highlight: 'M5 19h14 M8 15l8-8-3-3-8 8v3z',
  speak: 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a8 8 0 0 1 0 11',
  check: 'M5 12l5 5 9-10',
  stats: 'M5 20V10 M12 20V4 M19 20v-7',
  download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
  cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z',
};

export function Icon({ name, size = 20, label }: { name: keyof typeof P | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={!label} role={label ? 'img' : undefined} aria-label={label}>
      <path d={P[name] ?? P.doc} />
    </svg>
  );
}

export function itemIcon(type: string, hasText: boolean, hasChildren: boolean) {
  switch (type) {
    case 'DraftFolder': return 'draft';
    case 'ResearchFolder': return 'research';
    case 'TrashFolder': return 'trash';
    case 'Folder': return 'folder';
    case 'Image': return 'image';
    case 'PDF': return 'pdf';
    case 'Text': return hasChildren ? 'stack' : hasText ? 'docText' : 'doc';
    default: return 'doc';
  }
}
