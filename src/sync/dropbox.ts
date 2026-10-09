// Minimal Dropbox API v2 client for the browser (OAuth PKCE, no server needed).

import { kvGet, kvSet } from '../store/db';

export interface DbxTokens { access: string; refresh?: string; expiresAt: number; appKey: string; account?: string }
export interface DbxEntry { tag: 'file' | 'folder'; path: string; pathLower: string; name: string; rev?: string; hash?: string; size?: number; modified?: string }

export class DbxConflictError extends Error {
  constructor(public path: string) { super(`Dropbox file changed while syncing: ${path}`); }
}
export class DbxAuthError extends Error {}

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export const redirectUri = () => location.origin + location.pathname;

function b64url(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getAppKey() {
  return (await kvGet<string>('dropbox.appKey')) ?? (import.meta.env?.VITE_DROPBOX_APP_KEY as string | undefined) ?? '';
}
export async function setAppKey(k: string) { await kvSet('dropbox.appKey', k.trim()); }
export async function getTokens() { return kvGet<DbxTokens>('dropbox.tokens'); }
export async function signOut() { await kvSet('dropbox.tokens', undefined); }

export async function startAuth() {
  const appKey = await getAppKey();
  if (!appKey) throw new Error('Add your Dropbox app key in Settings first.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await kvSet('dropbox.pkce', { verifier, state });
  const q = new URLSearchParams({
    client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    token_access_type: 'offline', redirect_uri: redirectUri(), state,
  });
  location.assign(`${AUTH_URL}?${q}`);
}

/** Call on startup; completes the OAuth redirect if we're returning from Dropbox. */
export async function completeAuthIfReturning(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;
  const pk = await kvGet<{ verifier: string; state: string }>('dropbox.pkce');
  history.replaceState(null, '', redirectUri());
  if (!pk || pk.state !== params.get('state')) throw new Error('Dropbox sign-in could not be verified. Please try again.');
  const appKey = await getAppKey();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: pk.verifier, client_id: appKey, redirect_uri: redirectUri() }),
  });
  if (!res.ok) throw new Error('Dropbox sign-in failed: ' + (await res.text()));
  const j = await res.json();
  await kvSet('dropbox.tokens', { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in - 120) * 1000, appKey, account: j.account_id } satisfies DbxTokens);
  await kvSet('dropbox.pkce', undefined);
  return true;
}

async function accessToken(force = false): Promise<string> {
  const t = await getTokens();
  if (!t) throw new DbxAuthError('Not connected to Dropbox');
  if (!force && t.expiresAt > Date.now()) return t.access;
  if (!t.refresh) throw new DbxAuthError('Dropbox session expired. Please reconnect.');
  const res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.appKey }) });
  if (!res.ok) throw new DbxAuthError('Dropbox session expired. Please reconnect.');
  const j = await res.json();
  t.access = j.access_token;
  t.expiresAt = Date.now() + (j.expires_in - 120) * 1000;
  await kvSet('dropbox.tokens', t);
  return t.access;
}

/** Dropbox-API-Arg must be ASCII: escape everything else as \uXXXX. */
export function headerSafeJson(v: unknown) {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(url: string, init: RequestInit, attempt = 0, refreshed = false): Promise<Response> {
  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (attempt < 4) { await sleep(500 * 2 ** attempt); return call(url, init, attempt + 1, refreshed); }
    throw new Error('Network error talking to Dropbox. Your work is saved on this device; sync again when you are back online.');
  }
  if (res.status === 401 && !refreshed) { await accessToken(true); return call(url, init, attempt, true); }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get('Retry-After')) || 0;
    await sleep(Math.max(ra * 1000, 500 * 2 ** attempt));
    return call(url, init, attempt + 1, refreshed);
  }
  return res;
}

async function rpc<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await call(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Dropbox ${endpoint} failed: ${txt}`) as Error & { status: number; body: string };
    err.status = res.status; err.body = txt;
    throw err;
  }
  return res.json();
}

const toEntry = (e: Record<string, unknown>): DbxEntry => ({
  tag: e['.tag'] as 'file' | 'folder',
  path: e.path_display as string,
  pathLower: e.path_lower as string,
  name: e.name as string,
  rev: e.rev as string | undefined,
  hash: e.content_hash as string | undefined,
  size: e.size as number | undefined,
  modified: e.server_modified as string | undefined,
});

export async function listFolder(path: string, recursive = false): Promise<DbxEntry[]> {
  const out: DbxEntry[] = [];
  let r = await rpc<{ entries: Record<string, unknown>[]; cursor: string; has_more: boolean }>('files/list_folder', { path: path === '/' ? '' : path, recursive, limit: 2000 });
  out.push(...r.entries.filter((e) => e['.tag'] !== 'deleted').map(toEntry));
  while (r.has_more) {
    r = await rpc('files/list_folder/continue', { cursor: r.cursor });
    out.push(...r.entries.filter((e) => e['.tag'] !== 'deleted').map(toEntry));
  }
  return out;
}

export async function download(path: string): Promise<{ data: Uint8Array; meta: DbxEntry }> {
  const res = await call('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerSafeJson({ path }) } });
  if (!res.ok) throw new Error(`Download failed for ${path}: ${await res.text()}`);
  const meta = toEntry({ '.tag': 'file', ...JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') });
  return { data: new Uint8Array(await res.arrayBuffer()), meta };
}

/** Uploads; with `baseRev` the upload only succeeds if nobody changed the file meanwhile. */
export async function upload(path: string, data: Uint8Array, baseRev: string | null): Promise<DbxEntry> {
  const mode = baseRev ? { '.tag': 'update', update: baseRev } : { '.tag': 'add' };
  const res = await call('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { 'Dropbox-API-Arg': headerSafeJson({ path, mode, autorename: false, mute: true, strict_conflict: true }), 'Content-Type': 'application/octet-stream' },
    body: data as BodyInit,
  });
  if (res.status === 409) {
    const t = await res.text();
    if (t.includes('conflict')) throw new DbxConflictError(path);
    throw new Error(`Upload failed for ${path}: ${t}`);
  }
  if (!res.ok) throw new Error(`Upload failed for ${path}: ${await res.text()}`);
  return toEntry({ '.tag': 'file', ...(await res.json()) });
}

export async function remove(path: string, rev?: string) {
  try {
    await rpc('files/delete_v2', rev ? { path, parent_rev: rev } : { path });
  } catch (e) {
    const err = e as { status?: number; body?: string };
    if (err.status === 409 && err.body?.includes('not_found')) return;
    if (err.status === 409) throw new DbxConflictError(path);
    throw e;
  }
}

export async function currentAccountName(): Promise<string> {
  const r = await rpc<{ name: { display_name: string }; email: string }>('users/get_current_account', null);
  return `${r.name.display_name} (${r.email})`;
}

/** Dropbox content_hash: SHA-256 over the concatenated SHA-256 of each 4 MB block. */
export async function contentHash(data: Uint8Array): Promise<string> {
  const BLOCK = 4 * 1024 * 1024;
  const digests: Uint8Array[] = [];
  for (let off = 0; off < data.length || (off === 0 && digests.length === 0); off += BLOCK) {
    const slice = data.subarray(off, Math.min(off + BLOCK, data.length));
    if (!slice.length && data.length) break;
    if (!slice.length) break;
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', slice as BufferSource)));
  }
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, k) => all.set(d, k * 32));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('');
}
