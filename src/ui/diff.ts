// Word-level diff (LCS) used to compare snapshots / conflict versions.
export type DiffPart = { t: 'same' | 'add' | 'del'; s: string };

function lcsDiff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): { t: 'same' | 'add' | 'del'; v: T; w?: T }[] {
  const n = a.length, m = b.length;
  // trim common prefix/suffix to keep the table small
  let pre = 0;
  while (pre < n && pre < m && eq(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && eq(a[n - 1 - suf], b[m - 1 - suf])) suf++;
  const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
  const out: { t: 'same' | 'add' | 'del'; v: T; w?: T }[] = a.slice(0, pre).map((v, k) => ({ t: 'same' as const, v, w: b[k] }));
  if (A.length * B.length > 4_000_000) {
    A.forEach((v) => out.push({ t: 'del', v }));
    B.forEach((v) => out.push({ t: 'add', v }));
  } else {
    const W = B.length + 1;
    const L = new Uint32Array((A.length + 1) * W);
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
      L[i * W + j] = eq(A[i], B[j]) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (eq(A[i], B[j])) { out.push({ t: 'same', v: A[i], w: B[j] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) out.push({ t: 'del', v: A[i++] });
      else out.push({ t: 'add', v: B[j++] });
    }
    while (i < A.length) out.push({ t: 'del', v: A[i++] });
    while (j < B.length) out.push({ t: 'add', v: B[j++] });
  }
  a.slice(n - suf).forEach((v, k) => out.push({ t: 'same', v, w: b[m - suf + k] }));
  return out;
}

/** Diff old → new text, returning paragraphs of parts. */
export function diffText(oldText: string, newText: string): DiffPart[][] {
  const pa = oldText.split('\n'), pb = newText.split('\n');
  const paras = lcsDiff(pa, pb, (x, y) => x === y);
  const result: DiffPart[][] = [];
  // pair adjacent del/add paragraphs for word-level diffs
  for (let k = 0; k < paras.length; k++) {
    const p = paras[k];
    if (p.t === 'same') { result.push([{ t: 'same', s: p.v }]); continue; }
    if (p.t === 'del' && paras[k + 1]?.t === 'add') {
      const wa = p.v.split(/(\s+)/), wb = paras[k + 1].v.split(/(\s+)/);
      result.push(lcsDiff(wa, wb, (x, y) => x === y).map((d) => ({ t: d.t, s: d.v })));
      k++;
      continue;
    }
    result.push([{ t: p.t, s: p.v || ' ' }]);
  }
  return result;
}
