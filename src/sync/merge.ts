// Three-way merge of the binder (base = last synced, remote = Dropbox now,
// local = this device now). The rules are chosen so nothing is ever lost:
//  * per-field: whichever side changed a field wins (remote wins true clashes,
//    since the local edit is to metadata, not prose)
//  * per-folder ordering: the side that changed the order wins; additions
//    from the other side are appended rather than dropped
//  * an item deleted on one side but edited on the other is kept
//  * anything left without a home lands in the Draft folder's parent chain

import type { BinderItem, Keyword, Label, Status } from '../model/types';

export interface BinderState {
  rootIds: string[];
  items: Record<string, BinderItem>;
  labels: Label[];
  statuses: Status[];
  keywords: Keyword[];
}

const FIELDS = ['title', 'type', 'labelId', 'statusId', 'keywords', 'includeInCompile', 'pageBreakBefore', 'fileExt'] as const;
const ROOT = '__root__';

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function childLists(s: BinderState): Map<string, string[]> {
  const m = new Map<string, string[]>();
  m.set(ROOT, s.rootIds);
  for (const it of Object.values(s.items)) m.set(it.id, it.children);
  return m;
}

function fieldsChanged(a: BinderItem | undefined, b: BinderItem | undefined) {
  if (!a || !b) return false;
  return FIELDS.some((f) => !eq(a[f], b[f]));
}

export function mergeBinder(base: BinderState, remote: BinderState, local: BinderState): BinderState {
  const ids = new Set([...Object.keys(local.items), ...Object.keys(remote.items)]);
  const items: Record<string, BinderItem> = {};

  for (const id of ids) {
    const b = base.items[id], r = remote.items[id], l = local.items[id];
    if (b && !r && l) {
      // deleted remotely: keep only if edited locally
      if (!fieldsChanged(b, l)) continue;
    }
    if (b && r && !l) {
      // deleted locally (trash emptied): keep only if edited remotely
      if (!fieldsChanged(b, r)) continue;
    }
    const src = l ?? r!;
    const out: BinderItem = { ...src, children: [] };
    if (l && r) {
      for (const f of FIELDS) {
        const localChanged = b ? !eq(l[f], b[f]) : false;
        const remoteChanged = b ? !eq(r[f], b[f]) : true;
        (out as unknown as Record<string, unknown>)[f] = localChanged && !remoteChanged ? l[f] : r[f];
      }
      out.modified = l.modified > r.modified ? l.modified : r.modified;
      // synopsis/wordCount are per-device caches handled by the document sync
      out.synopsis = l.synopsis;
      out.wordCount = l.wordCount;
      out.expanded = l.expanded;
    }
    items[id] = out;
  }

  const bl = childLists(base), rl = childLists(remote), ll = childLists(local);
  const containers = new Set([ROOT, ...Object.keys(items)]);
  const decided = new Map<string, string[]>();
  for (const c of containers) {
    const b = bl.get(c) ?? [], r = rl.get(c), l = ll.get(c);
    let list: string[];
    if (!r) list = l ?? [];
    else if (!l) list = r;
    else {
      const localChanged = !eq(l, b);
      const remoteChanged = !eq(r, b);
      if (localChanged && !remoteChanged) list = l;
      else if (!localChanged) list = r;
      else {
        // both reordered: remote order, then local additions after their local predecessor
        list = [...r];
        for (let k = 0; k < l.length; k++) {
          const id = l[k];
          if (list.includes(id) || b.includes(id)) continue;
          const prev = l.slice(0, k).reverse().find((p) => list.includes(p));
          const at = prev ? list.indexOf(prev) + 1 : 0;
          list.splice(at, 0, id);
        }
      }
    }
    decided.set(c, list.filter((id) => items[id]));
  }

  // A moved item can be claimed by two containers. Prefer the side that moved it.
  const claim = new Map<string, string>();
  const parentOf = (s: BinderState, id: string) => (s.items[id] ? s.items[id].parent ?? ROOT : undefined);
  for (const [c, list] of decided) {
    for (const id of list) {
      const prev = claim.get(id);
      if (!prev) { claim.set(id, c); continue; }
      const bp = parentOf(base, id), lp = parentOf(local, id), rp = parentOf(remote, id);
      const preferred = lp !== bp ? lp : rp;
      if (c === preferred) claim.set(id, c);
    }
  }
  for (const [c, list] of decided) decided.set(c, list.filter((id) => claim.get(id) === c));

  // Walk from root; anything unreachable (orphaned or cyclic) is re-homed.
  const placed = new Set<string>();
  const finalLists = new Map<string, string[]>();
  const visit = (c: string) => {
    const list = (decided.get(c) ?? []).filter((id) => !placed.has(id));
    list.forEach((id) => placed.add(id));
    finalLists.set(c, list);
    list.forEach(visit);
  };
  visit(ROOT);
  const orphans = Object.keys(items).filter((id) => !placed.has(id));
  if (orphans.length) {
    const rootList = finalLists.get(ROOT)!;
    const draft = rootList.find((id) => items[id].type === 'DraftFolder');
    for (const id of orphans) {
      if (placed.has(id)) continue;
      const lp = parentOf(local, id);
      const home = lp && lp !== ROOT && placed.has(lp) ? lp : draft ?? ROOT;
      const list = finalLists.get(home) ?? [];
      list.push(id);
      finalLists.set(home, list);
      placed.add(id);
      // its own children may have been unreachable too
      const sub = decided.get(id) ?? [];
      finalLists.set(id, sub.filter((s) => !placed.has(s)));
      sub.forEach((s) => placed.add(s));
    }
  }
  for (const [c, list] of finalLists) {
    if (c !== ROOT && items[c]) items[c].children = list;
    for (const id of list) items[id].parent = c === ROOT ? null : c;
  }

  const pick = <T,>(b: T, r: T, l: T) => (!eq(l, b) ? l : r);
  return {
    rootIds: finalLists.get(ROOT) ?? [],
    items,
    labels: pick(base.labels, remote.labels, local.labels),
    statuses: pick(base.statuses, remote.statuses, local.statuses),
    keywords: pick(base.keywords, remote.keywords, local.keywords),
  };
}
