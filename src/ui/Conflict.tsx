import { useEffect, useState } from 'react';
import type { PMNode, Snapshot } from '../model/types';
import { docPlainText } from '../scriv/rtf';
import { addSnapshot, listSnapshots } from '../store/db';
import { useSession } from './ctx';
import { diffText } from './diff';
import { Sheet, toast } from './kit';

export function DiffView({ oldText, newText, oldLabel, newLabel }: { oldText: string; newText: string; oldLabel: string; newLabel: string }) {
  const parts = diffText(oldText, newText);
  const changed = parts.some((p) => p.some((x) => x.t !== 'same'));
  return (
    <div className="diff">
      <div className="diff-legend"><span className="del">{oldLabel}</span> <span className="add">{newLabel}</span></div>
      {!changed && <p className="muted">The text is identical.</p>}
      {parts.map((p, k) => (
        <p key={k}>{p.map((x, j) => x.t === 'same' ? <span key={j}>{x.s}</span> : x.t === 'add' ? <ins key={j}>{x.s}</ins> : <del key={j}>{x.s}</del>)}</p>
      ))}
    </div>
  );
}

export function ConflictBanner({ itemId, onResolved }: { itemId: string; onResolved: () => void }) {
  const session = useSession();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [compare, setCompare] = useState(false);
  const docKey = `${session.project.id}:${itemId}`;
  useEffect(() => { listSnapshots(docKey).then((s) => setSnap(s.find((x) => x.kind === 'conflict') ?? null)); }, [docKey]);

  const finish = async (content: PMNode | null, dirty: boolean) => {
    const d = await session.loadDoc(itemId);
    if (!d) return;
    if (content) {
      await addSnapshot({ docKey, title: 'This device’s version (before resolving conflict)', date: new Date().toISOString(), content: d.content, kind: 'manual', words: 0 });
      d.content = content;
    }
    d.conflict = false;
    d.contentDirty = dirty;
    await session.replaceDoc(d);
    onResolved();
  };

  const keepMine = async () => { await finish(null, true); toast('Keeping this device’s version. It will be uploaded on the next sync.', 'ok'); };
  const useTheirs = async () => { if (snap) { await finish(snap.content, false); toast('Switched to the other device’s version. Yours is saved in Snapshots.', 'ok'); } };
  const keepBoth = async () => {
    if (!snap) return;
    const it = session.item(itemId)!;
    await session.addItem('Text', itemId, 'after', `${it.title} (other device)`, snap.content);
    await finish(null, true);
    toast('Kept both versions side by side in the binder.', 'ok');
  };

  return (
    <div className="banner conflict" role="alert">
      <div><strong>Edited on two devices.</strong> This document changed here and in Dropbox since the last sync. Nothing has been lost — choose which to keep.</div>
      <div className="row wrap">
        <button className="btn" onClick={() => setCompare(true)} disabled={!snap}>Compare</button>
        <button className="btn primary" onClick={keepMine}>Keep mine</button>
        <button className="btn" onClick={useTheirs} disabled={!snap}>Use other device’s</button>
        <button className="btn" onClick={keepBoth} disabled={!snap}>Keep both</button>
      </div>
      {compare && snap && (
        <CompareSheet itemId={itemId} other={snap.content} onClose={() => setCompare(false)} />
      )}
    </div>
  );
}

function CompareSheet({ itemId, other, onClose }: { itemId: string; other: PMNode; onClose: () => void }) {
  const session = useSession();
  const d = session.cachedDoc(itemId);
  return (
    <Sheet title="Compare versions" onClose={onClose} wide>
      <DiffView oldText={docPlainText(other)} newText={docPlainText(d?.content ?? other)} oldLabel="Other device (removed here)" newLabel="This device (added here)" />
    </Sheet>
  );
}
