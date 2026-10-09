// RTF <-> ProseMirror JSON.
//
// Scrivener stores every document as Cocoa-flavoured RTF. We parse the subset
// that matters for prose (bold/italic/underline/strike, highlights, alignment,
// Scrivener comments & linked footnotes, RTF footnotes) and *detect* what we
// can't represent (images, tables). Documents containing those are flagged as
// lossy so the UI can protect them instead of silently stripping content.

import type { PMMark, PMNode, RtfStyle } from '../model/types';

const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

const SKIP_DESTS = new Set([
  'stylesheet', 'info', 'pict', 'listtable', 'listoverridetable', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'xmlnstbl', 'rsidtbl', 'generator', 'expandedcolortbl', 'object', 'nonshppict', 'shp', 'NeXTGraphic',
  'listtext', 'pntext', 'filetbl', 'revtbl', 'pgdsctbl', 'userprops', 'mmathPr', 'fldinst_skip',
]);

interface CommentInfo { text: string; footnote: boolean }

interface FieldRef { inst: string }
interface St {
  b: boolean; i: boolean; u: boolean; s: boolean;
  hl: number; // background colour index, 0 = none
  uc: number;
  skip: boolean;
  dest: '' | 'fonttbl' | 'colortbl' | 'fldinst' | 'footnote';
  field: FieldRef | null;
  rslt: boolean;
  align: string;
  annot: boolean; // Scrivener inline annotation
}

export interface RtfParseResult { doc: PMNode; style: RtfStyle; lossy: string[] }

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return s;
}

export function decodeRtfBytes(bytes: Uint8Array) {
  return bytesToLatin1(bytes);
}

export function rtfToDoc(rtfInput: string | Uint8Array, comments: Map<string, CommentInfo> = new Map()): RtfParseResult {
  const rtf = typeof rtfInput === 'string' ? rtfInput : bytesToLatin1(rtfInput);
  const lossy = new Set<string>();
  const style: RtfStyle = { fonttbl: '', colors: [], paraProps: '', charProps: '' };
  let macRoman = false;

  const paras: PMNode[] = [];
  let cur: { align: string; inl: PMNode[] } = { align: 'left', inl: [] };
  let sawText = false;
  let capturingPara = false;
  let paraPropsBuf = '';

  let st: St = { b: false, i: false, u: false, s: false, hl: 0, uc: 1, skip: false, dest: '', field: null, rslt: false, align: 'left', annot: false };
  const stack: { st: St; start: number; footBuf?: PMNode[]; footOuter?: typeof cur }[] = [];
  let colorParts = { r: 0, g: 0, b: 0, any: false };
  let skipChars = 0;
  let groupFirst = false; // next token is first in a new group
  let starPending = false;
  const footnoteStack: { outer: typeof cur; collected: string }[] = [];
  let skipNextAttachmentChar = false;

  const marksFor = (s: St): PMMark[] => {
    const m: PMMark[] = [];
    if (s.b) m.push({ type: 'bold' });
    if (s.i) m.push({ type: 'italic' });
    if (s.u) m.push({ type: 'underline' });
    if (s.s) m.push({ type: 'strike' });
    if (s.hl > 0 && style.colors[s.hl] && !/^#?f{6}$/i.test(style.colors[s.hl].replace('#', ''))) {
      m.push({ type: 'highlight', attrs: { color: style.colors[s.hl] } });
    }
    if (s.annot) m.push({ type: 'annotation' });
    if (s.rslt && s.field) {
      const mm = /scrivcmt:\/\/([^"\s]+)/i.exec(s.field.inst);
      if (mm) {
        const c = comments.get(mm[1]) ?? comments.get(mm[1].toUpperCase());
        m.push({ type: 'scrivComment', attrs: { id: mm[1], kind: c?.footnote ? 'footnote' : 'comment', text: c?.text ?? '' } });
      } else {
        const lm = /HYPERLINK\s+"([^"]+)"/i.exec(s.field.inst);
        if (lm && !/^scriv/i.test(lm[1])) m.push({ type: 'link', attrs: { href: lm[1] } });
      }
    }
    return m;
  };

  const sameMarks = (a?: PMMark[], b?: PMMark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

  const emit = (text: string) => {
    if (!text) return;
    if (st.skip) return;
    if (st.dest === 'fonttbl') return;
    if (st.dest === 'colortbl') {
      for (const ch of text) {
        if (ch === ';') {
          style.colors.push(colorParts.any ? rgbHex(colorParts.r, colorParts.g, colorParts.b) : '');
          colorParts = { r: 0, g: 0, b: 0, any: false };
        }
      }
      return;
    }
    if (st.dest === 'fldinst') {
      if (st.field) st.field.inst += text;
      return;
    }
    if (st.dest === 'footnote') {
      footnoteStack[footnoteStack.length - 1].collected += text;
      return;
    }
    sawText = true;
    capturingPara = false;
    const marks = marksFor(st);
    const last = cur.inl[cur.inl.length - 1];
    if (last && last.type === 'text' && sameMarks(last.marks, marks)) last.text += text;
    else cur.inl.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
  };

  const endPara = () => {
    const p: PMNode = { type: 'paragraph' };
    if (cur.align !== 'left') p.attrs = { textAlign: cur.align };
    if (cur.inl.length) p.content = cur.inl;
    paras.push(p);
    cur = { align: st.align, inl: [] };
  };

  const pushChar = (code: number) => {
    if (skipChars > 0) { skipChars--; return; }
    if (skipNextAttachmentChar && (code === 0xac || code === 0xfffc)) { skipNextAttachmentChar = false; return; }
    emit(String.fromCharCode(code));
  };

  let i = 0;
  const n = rtf.length;
  let textBuf = '';
  const flush = () => { if (textBuf) { emit(textBuf); textBuf = ''; } };

  while (i < n) {
    const c = rtf[i];
    if (c === '{') {
      flush();
      stack.push({ st: { ...st }, start: i });
      groupFirst = true;
      starPending = false;
      i++;
      continue;
    }
    if (c === '}') {
      flush();
      const fr = stack.pop();
      if (!fr) { i++; continue; }
      if (st.dest === 'fonttbl' && !fr.st.skip && fr.st.dest !== 'fonttbl') style.fonttbl = rtf.slice(fr.start, i + 1);
      if (st.dest === 'colortbl' && fr.st.dest !== 'colortbl') { /* done */ }
      if (st.dest === 'footnote' && fr.st.dest !== 'footnote') {
        const fn = footnoteStack.pop()!;
        attachFootnote(cur, fn.collected.trim());
      }
      // paragraph alignment survives group end only if set at the outer level
      const keepAlign = cur.align;
      st = fr.st;
      cur.align = keepAlign;
      groupFirst = false;
      i++;
      continue;
    }
    if (c === '\\') {
      const nx = rtf[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { if (skipChars > 0) skipChars--; else textBuf += nx; i += 2; groupFirst = false; continue; }
      if (nx === '\n' || nx === '\r') { flush(); if (!st.skip && !st.dest) endPara(); i += 2; continue; }
      if (nx === "'") {
        const hex = parseInt(rtf.substr(i + 2, 2), 16);
        i += 4;
        flush();
        if (skipChars > 0) { skipChars--; continue; }
        let code = hex;
        if (hex >= 0x80) code = macRoman ? MAC_ROMAN_HIGH.charCodeAt(hex - 0x80) : (CP1252[hex] ?? hex);
        pushChar(code);
        groupFirst = false;
        continue;
      }
      if (nx === '*') { starPending = true; i += 2; continue; }
      if (nx === '~') { textBuf += '\u00a0'; i += 2; continue; }
      if (nx === '-') { i += 2; continue; }
      if (nx === '_') { textBuf += '\u2011'; i += 2; continue; }
      if (nx === '|' || nx === ':') { i += 2; continue; }
      // control word
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(rtf[j])) j++;
      const word = rtf.slice(i + 1, j);
      let k = j;
      if (rtf[k] === '-' || /[0-9]/.test(rtf[k] ?? '')) {
        k++;
        while (k < n && /[0-9]/.test(rtf[k])) k++;
      }
      const paramStr = rtf.slice(j, k);
      const param = paramStr ? parseInt(paramStr, 10) : null;
      if (rtf[k] === ' ') k++;
      const raw = rtf.slice(i, k).trimEnd();
      i = k;
      flush();
      const first = groupFirst;
      groupFirst = false;

      if (capturingPara && !sawText && !st.dest && !st.skip) {
        if (!/^(q[lcrj]|b|i|ul|ulnone|strike|par|pard|plain|cb\d*|highlight)$/.test(word)) paraPropsBuf += raw;
      }

      if (starPending) {
        starPending = false;
        if (word === 'fldinst') { st.dest = 'fldinst'; continue; }
        if (word === 'Scrv_annot' || word === 'Scrv_fn') { /* fallthrough handled below */ }
        else { st.skip = true; continue; }
      }
      if (st.skip) continue;

      switch (word) {
        case 'fonttbl': st.dest = 'fonttbl'; break;
        case 'colortbl': st.dest = 'colortbl'; break;
        case 'red': colorParts.r = param ?? 0; colorParts.any = true; break;
        case 'green': colorParts.g = param ?? 0; colorParts.any = true; break;
        case 'blue': colorParts.b = param ?? 0; colorParts.any = true; break;
        case 'mac': macRoman = true; break;
        case 'ansi': case 'ansicpg': macRoman = false; break;
        case 'field': st.field = { inst: '' }; break;
        case 'fldinst': st.dest = 'fldinst'; break;
        case 'fldrslt': st.rslt = true; if (st.dest === 'fldinst') st.dest = ''; break;
        case 'footnote':
          st.dest = 'footnote';
          footnoteStack.push({ outer: cur, collected: '' });
          break;
        case 'Scrv_annot': st.annot = true; break;
        case 'end_Scrv_annot': st.annot = false; break;
        case 'pict': case 'NeXTGraphic': case 'object': case 'shppict':
          lossy.add('images'); st.skip = true; skipNextAttachmentChar = true; break;
        case 'trowd': lossy.add('tables'); break;
        case 'cell': emit('\t'); break;
        case 'row': endPara(); break;
        case 'par': if (!st.dest) endPara(); else if (st.dest === 'footnote') footnoteStack[footnoteStack.length - 1].collected += '\n'; break;
        case 'sect': case 'page': if (!st.dest) endPara(); break;
        case 'line': if (!st.dest) cur.inl.push({ type: 'hardBreak' }); break;
        case 'tab': emit('\t'); break;
        case 'emdash': emit('\u2014'); break;
        case 'endash': emit('\u2013'); break;
        case 'lquote': emit('\u2018'); break;
        case 'rquote': emit('\u2019'); break;
        case 'ldblquote': emit('\u201c'); break;
        case 'rdblquote': emit('\u201d'); break;
        case 'bullet': emit('\u2022'); break;
        case 'uc': st.uc = param ?? 1; break;
        case 'u': {
          let code = param ?? 0;
          if (code < 0) code += 65536;
          if (skipChars > 0) { skipChars = 0; }
          emit(String.fromCharCode(code));
          skipChars = st.uc;
          // swallow the fallback characters right here
          while (skipChars > 0 && i < n) {
            if (rtf[i] === '\\' && rtf[i + 1] === "'") { i += 4; skipChars--; }
            else if (rtf[i] === '{' || rtf[i] === '}' || rtf[i] === '\\') break;
            else if (rtf[i] === '\n' || rtf[i] === '\r') { i++; }
            else { i++; skipChars--; }
          }
          skipChars = 0;
          break;
        }
        case 'pard':
          st.align = 'left';
          cur.align = 'left';
          if (!sawText && !style.paraProps) { capturingPara = true; paraPropsBuf = ''; }
          break;
        case 'qc': st.align = 'center'; cur.align = 'center'; break;
        case 'qr': st.align = 'right'; cur.align = 'right'; break;
        case 'qj': st.align = 'justify'; cur.align = 'justify'; break;
        case 'ql': st.align = 'left'; cur.align = 'left'; break;
        case 'plain': st.b = st.i = st.u = st.s = false; st.hl = 0; break;
        case 'b': st.b = param !== 0; break;
        case 'i': st.i = param !== 0; break;
        case 'ul': st.u = param !== 0; break;
        case 'ulnone': st.u = false; break;
        case 'strike': st.s = param !== 0; break;
        case 'striked': st.s = param !== 0; break;
        case 'cb': case 'highlight': st.hl = param ?? 0; break;
        default:
          if (first && SKIP_DESTS.has(word)) st.skip = true;
      }
      if (!capturingPara && paraPropsBuf && !style.paraProps) style.paraProps = paraPropsBuf;
      continue;
    }
    if (c === '\n' || c === '\r') { i++; continue; }
    if (skipNextAttachmentChar && (c === '\u00ac' || c === '\ufffc')) { skipNextAttachmentChar = false; i++; continue; }
    if (!st.skip) skipNextAttachmentChar = false;
    groupFirst = false;
    if (skipChars > 0) { skipChars--; i++; continue; }
    textBuf += c;
    i++;
  }
  flush();
  if (cur.inl.length) endPara();
  if (!style.paraProps && paraPropsBuf) style.paraProps = paraPropsBuf;
  if (!style.colors.length) style.colors.push('');
  // Drop the trailing empty paragraph Cocoa often leaves, keep at least one
  while (paras.length > 1 && !paras[paras.length - 1].content) paras.pop();
  if (!paras.length) paras.push({ type: 'paragraph' });
  return { doc: { type: 'doc', content: paras }, style, lossy: [...lossy] };
}
function attachFootnote(cur: { inl: PMNode[] }, text: string) {
  // Anchor a classic RTF footnote to the word right before it.
  const id = crypto.randomUUID().toUpperCase();
  const mark: PMMark = { type: 'scrivComment', attrs: { id, kind: 'footnote', text } };
  for (let k = cur.inl.length - 1; k >= 0; k--) {
    const node = cur.inl[k];
    if (node.type !== 'text' || !node.text) continue;
    const t = node.text;
    const m = /(\S+)(\s*)$/.exec(t);
    if (!m) continue;
    const start = m.index;
    const before = t.slice(0, start);
    const word = m[1];
    const after = m[2];
    const parts: PMNode[] = [];
    if (before) parts.push({ ...node, text: before });
    parts.push({ ...node, text: word, marks: [...(node.marks ?? []), mark] });
    if (after) parts.push({ ...node, text: after });
    cur.inl.splice(k, 1, ...parts);
    return;
  }
  cur.inl.push({ type: 'text', text: '*', marks: [mark] });
}

function rgbHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- writer

export interface CommentOut { id: string; kind: 'comment' | 'footnote'; text: string }

function esc(text: string) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (ch === '\t') out += '\\tab ';
    else if (ch === '\n') out += '\\line ';
    else if (code < 128) out += ch;
    else if (code > 0xffff) {
      const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const lo = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi - 65536} \\u${lo - 65536} `;
    } else out += `\\u${code > 32767 ? code - 65536 : code} `;
  }
  return out;
}

export function docToRtf(doc: PMNode, style?: RtfStyle): { rtf: string; comments: CommentOut[] } {
  const colors = style?.colors?.length ? [...style.colors] : [''];
  const colorIdx = (hex: string) => {
    let k = colors.findIndex((c, idx) => idx > 0 && c.toLowerCase() === hex.toLowerCase());
    if (k < 0) { colors.push(hex); k = colors.length - 1; }
    return k;
  };
  const fonttbl = style?.fonttbl || '{\\fonttbl\\f0\\fnil\\fcharset0 Palatino-Roman;}';
  const paraProps = (style?.paraProps || '\\pard\\tx560\\pardirnatural\\partightenfactor0\\f0\\fs26 \\cf0').replace(/^\\pard/, '');
  const comments: CommentOut[] = [];
  const seen = new Set<string>();
  const body: string[] = [];

  const blocks: { node: PMNode; prefix?: string; quote?: boolean; heading?: number }[] = [];
  const walk = (nodes: PMNode[] | undefined, ctx: { quote?: boolean; listType?: string }) => {
    for (const nd of nodes ?? []) {
      if (nd.type === 'paragraph') blocks.push({ node: nd, quote: ctx.quote });
      else if (nd.type === 'heading') blocks.push({ node: nd, heading: Number(nd.attrs?.level ?? 1), quote: ctx.quote });
      else if (nd.type === 'blockquote') walk(nd.content, { ...ctx, quote: true });
      else if (nd.type === 'bulletList' || nd.type === 'orderedList') {
        let num = Number(nd.attrs?.start ?? 1);
        for (const li of nd.content ?? []) {
          const firstPara = li.content?.[0];
          if (firstPara) blocks.push({ node: firstPara, prefix: nd.type === 'bulletList' ? '\u2022\t' : `${num++}.\t`, quote: ctx.quote });
          walk(li.content?.slice(1), ctx);
        }
      } else if (nd.type === 'horizontalRule') blocks.push({ node: { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '#' }] } });
    }
  };
  walk(doc.content, {});

  blocks.forEach((blk, bi) => {
    const al = String(blk.node.attrs?.textAlign ?? 'left');
    let s = '\\pard' + paraProps + (al === 'center' ? '\\qc' : al === 'right' ? '\\qr' : al === 'justify' ? '\\qj' : '');
    if (blk.quote) s += '\\li720\\ri720';
    s += ' ';
    if (blk.heading) s += `{\\b\\fs${blk.heading === 1 ? 36 : blk.heading === 2 ? 30 : 26} `;
    if (blk.prefix) s += esc(blk.prefix);
    let state = { b: false, i: false, u: false, s: false, hl: 0 };
    let openCommentId: string | null = null;
    const closeComment = () => { if (openCommentId) { s += '}}'; openCommentId = null; } };
    for (const nd of blk.node.content ?? []) {
      if (nd.type === 'hardBreak') { s += '\\line '; continue; }
      if (nd.type !== 'text') continue;
      const ms = nd.marks ?? [];
      const has = (t: string) => ms.find((m) => m.type === t);
      const want = {
        b: !!has('bold'), i: !!has('italic'), u: !!has('underline'), s: !!has('strike'),
        hl: has('highlight') ? colorIdx(String(has('highlight')!.attrs?.color || '#fff59d')) : has('annotation') ? colorIdx('#ffd6d6') : 0,
      };
      const cm = has('scrivComment');
      const cid = cm ? String(cm.attrs?.id) : null;
      if (cid !== openCommentId) {
        closeComment();
        if (cid) {
          s += `{\\field{\\*\\fldinst{HYPERLINK "scrivcmt://${cid}"}}{\\fldrslt `;
          openCommentId = cid;
          if (!seen.has(cid)) {
            seen.add(cid);
            comments.push({ id: cid, kind: cm!.attrs?.kind === 'footnote' ? 'footnote' : 'comment', text: String(cm!.attrs?.text ?? '') });
          }
        }
      }
      if (want.b !== state.b) s += want.b ? '\\b ' : '\\b0 ';
      if (want.i !== state.i) s += want.i ? '\\i ' : '\\i0 ';
      if (want.u !== state.u) s += want.u ? '\\ul ' : '\\ulnone ';
      if (want.s !== state.s) s += want.s ? '\\strike\\strikec0 ' : '\\strike0\\striked0 ';
      if (want.hl !== state.hl) s += `\\cb${want.hl} `;
      state = want;
      s += esc(nd.text ?? '');
    }
    closeComment();
    if (state.b) s += '\\b0 ';
    if (state.i) s += '\\i0 ';
    if (state.u) s += '\\ulnone ';
    if (state.s) s += '\\strike0\\striked0 ';
    if (state.hl) s += '\\cb0 ';
    if (blk.heading) s += '}';
    if (bi < blocks.length - 1) s += '\\\n';
    body.push(s);
  });

  const colortbl = '{\\colortbl;' + colors.slice(1).map((h) => {
    if (!h) return ';';
    const v = parseInt(h.replace('#', ''), 16);
    return `\\red${(v >> 16) & 255}\\green${(v >> 8) & 255}\\blue${v & 255};`;
  }).join('') + '}';

  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n\\cocoatextscaling0\\cocoaplatform0${fonttbl}\n${colortbl}\n\\deftab720\n\\uc0${body.join('')}}`;
  return { rtf, comments };
}

export function textToRtf(text: string) {
  const doc: PMNode = { type: 'doc', content: text.split('\n').map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })) };
  return docToRtf(doc).rtf;
}

export function encodeLatin1(s: string): Uint8Array {
  // Our writer only emits ASCII (everything else is \u-escaped)
  const out = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k) & 0xff;
  return out;
}

// --- content.comments (Scrivener 3 linked comments / footnotes)

export function parseCommentsXml(xml: string): Map<string, CommentInfo> {
  const map = new Map<string, CommentInfo>();
  const re = /<Comment\b([^>]*)>([\s\S]*?)<\/Comment>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const id = /ID="([^"]+)"/.exec(attrs)?.[1];
    if (!id) continue;
    const footnote = /Footnote="Yes"/i.test(attrs);
    let inner = m[2].trim();
    const cd = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(inner);
    if (cd) inner = cd[1];
    else inner = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const text = inner.trim().startsWith('{\\rtf') ? docPlainText(rtfToDoc(inner).doc) : inner;
    map.set(id, { text, footnote });
  }
  return map;
}

export function buildCommentsXml(comments: CommentOut[]) {
  const items = comments.map((c) => {
    const rtf = textToRtf(c.text).replace(/]]>/g, ']]]]><![CDATA[>');
    return `    <Comment ID="${c.id}" Footnote="${c.kind === 'footnote' ? 'Yes' : 'No'}" Color="${c.kind === 'footnote' ? '0.8 0.8 0.8' : '1.0 0.97 0.6'}"><![CDATA[${rtf}]]></Comment>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Comments Version="1.0">\n${items.join('\n')}\n</Comments>\n`;
}

export function docPlainText(doc: PMNode): string {
  const out: string[] = [];
  const walk = (nd: PMNode, para: string[]) => {
    if (nd.type === 'text') para.push(nd.text ?? '');
    else if (nd.type === 'hardBreak') para.push('\n');
    else nd.content?.forEach((c) => walk(c, para));
  };
  const blocks = (nd: PMNode) => {
    for (const c of nd.content ?? []) {
      if (c.type === 'paragraph' || c.type === 'heading') { const p: string[] = []; walk(c, p); out.push(p.join('')); }
      else blocks(c);
    }
  };
  blocks(doc);
  return out.join('\n');
}

export function countWords(text: string) {
  const m = text.match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}
