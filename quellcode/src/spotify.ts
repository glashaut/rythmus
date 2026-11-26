// Spotify-Anbindung: Anmeldung (OAuth mit PKCE, ohne Server) und die Web-API-Aufrufe,
// die für Development-Mode-Apps seit Februar 2026 noch erlaubt sind.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',   // Lieblingssongs lesen
  'user-library-modify', // "Ja" als Lieblingssong speichern
  'user-read-playback-state',   // sehen, was wo läuft
  'user-modify-playback-state', // Spotify-App fernsteuern (Premium)
  'streaming',                  // Browser als Abspielgerät (Premium)
  'user-read-email',            // vom Browser-Player verlangt
].join(' ');
const REQUIRED_SCOPES = ['user-library-read', 'user-library-modify', 'user-read-playback-state', 'user-modify-playback-state', 'streaming'];

const K_CLIENT = 'rz.clientId';
const K_TOKEN = 'rz.token';
const K_VERIFIER = 'rz.verifier';

export interface SpotifyImage { url: string; width?: number | null; height?: number | null }
export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms?: number;
  artists: { name: string; id?: string }[];
  album?: { name: string; images?: SpotifyImage[] };
}
export interface PlaylistEntry { track: SpotifyTrack; addedAt: number }

interface Token { access: string; refresh: string; expiresAt: number; scope?: string }

// ---------- kleine Speicher-Helfer ----------
function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher voll/gesperrt */ }
}
function remove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* egal */ }
}

export function getClientId(): string | null { return load<string>(K_CLIENT); }
export function setClientId(id: string): void { save(K_CLIENT, id.trim()); }

/** Die Adresse, die im Spotify-Dashboard als Redirect URI eingetragen werden muss. */
export function redirectUri(): string {
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, '');
}

export function isLoggedIn(): boolean { return load<Token>(K_TOKEN) !== null; }

/** Hat die Anmeldung alle Rechte, die diese Version braucht? (Ältere Logins hatten noch keinen Zugriff auf Lieblingssongs.) */
export function hasRequiredScopes(): boolean {
  const scope = load<Token>(K_TOKEN)?.scope;
  if (!scope) return false;
  const granted = new Set(scope.split(' '));
  return REQUIRED_SCOPES.every((s) => granted.has(s));
}
export function logout(): void { remove(K_TOKEN); }

// ---------- PKCE ----------
function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function startLogin(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Keine Client-ID eingetragen.');
  const verifier = randomVerifier();
  sessionStorage.setItem(K_VERIFIER, verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES,
  });
  window.location.assign(`${AUTH_URL}?${params.toString()}`);
}

/** Nach der Rückkehr von Spotify: Code gegen Token tauschen. Gibt true zurück, wenn ein Login verarbeitet wurde. */
export async function handleRedirect(): Promise<boolean> {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (!error && !code) return false;
  window.history.replaceState({}, '', redirectUri());
  if (error) throw new Error(`Spotify-Anmeldung abgebrochen: ${error}`);
  const verifier = sessionStorage.getItem(K_VERIFIER);
  const clientId = getClientId();
  if (!verifier || !clientId) throw new Error('Anmeldung unvollständig, bitte erneut versuchen.');
  sessionStorage.removeItem(K_VERIFIER);
  await requestToken({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  });
  return true;
}

async function requestToken(body: Record<string, string>): Promise<Token> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    if (body.grant_type === 'refresh_token') logout();
    throw new Error(`Token-Anfrage fehlgeschlagen (${res.status}).`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  const old = load<Token>(K_TOKEN);
  const token: Token = {
    access: data.access_token,
    refresh: data.refresh_token ?? old?.refresh ?? '',
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? old?.scope,
  };
  save(K_TOKEN, token);
  return token;
}

let refreshing: Promise<Token> | null = null;
/** Gültiges Zugriffstoken (für den Browser-Player). */
export function getAccessToken(): Promise<string> { return accessToken(); }

async function accessToken(force = false): Promise<string> {
  const token = load<Token>(K_TOKEN);
  if (!token) throw new Error('Nicht bei Spotify angemeldet.');
  if (!force && token.expiresAt - 60_000 > Date.now()) return token.access;
  const clientId = getClientId();
  if (!clientId || !token.refresh) { logout(); throw new Error('Sitzung abgelaufen, bitte neu anmelden.'); }
  refreshing ??= requestToken({ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: clientId })
    .finally(() => { refreshing = null; });
  return (await refreshing).access;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Allgemeiner API-Aufruf mit Token-Erneuerung und Warten bei Ratenbegrenzung (429). */
export async function api<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const token = await accessToken();
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 401 && attempt === 0) {
    await accessToken(true);
    return api<T>(path, init, attempt + 1);
  }
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('Retry-After') ?? '2');
    await sleep(Math.min(30, Math.max(1, wait)) * 1000);
    return api<T>(path, init, attempt + 1);
  }
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''; } catch { /* kein JSON */ }
    throw new Error(`Spotify ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  // Spotify antwortet auf Player-Befehle teils mit leerem Body, teils mit kurzem Text (kein JSON) – beides ist Erfolg
  const text = await res.text();
  if (!text) return null as T;
  try { return JSON.parse(text) as T; } catch { return null as T; }
}

// ---------- Endpunkte ----------
export async function getMe(): Promise<{ id: string; display_name?: string; product?: string }> {
  return api('/me');
}

/** Suche. Seit Februar 2026 liefert Spotify höchstens 10 Treffer pro Anfrage. */
export async function searchTracks(q: string, offset = 0, limit = 10): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, type: 'track', limit: String(Math.min(10, limit)), offset: String(offset) });
  const data = await api<{ tracks?: { items: (SpotifyTrack | null)[] } }>(`/search?${params.toString()}`);
  return (data.tracks?.items ?? []).filter((t): t is SpotifyTrack => !!t && !!t.id);
}

export async function getTrack(id: string): Promise<SpotifyTrack> {
  return api(`/tracks/${id}`);
}

interface PlaylistSummary { id: string; name: string; owner?: { id: string } }

/** Sucht eine eigene Playlist mit diesem Namen oder legt sie (privat) an. Mit create=false: null, falls es sie nicht gibt. */
export async function findOrCreatePlaylist(name: string, description: string, meId: string, create?: true): Promise<string>;
export async function findOrCreatePlaylist(name: string, description: string, meId: string, create: false): Promise<string | null>;
export async function findOrCreatePlaylist(name: string, description: string, meId: string, create = true): Promise<string | null> {
  let next: string | null = '/me/playlists?limit=50';
  while (next) {
    const page: { items: (PlaylistSummary | null)[]; next: string | null } = await api(next);
    const hit = page.items.find((p) => p && p.name === name && (!p.owner || p.owner.id === meId));
    if (hit) return hit.id;
    next = page.next;
  }
  if (!create) return null;
  const created = await api<{ id: string }>('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  });
  return created.id;
}

/** Alle Titel einer eigenen Playlist samt Hinzufügedatum (neuer Endpunkt /items). */
export async function getPlaylistEntries(playlistId: string): Promise<PlaylistEntry[]> {
  const out: PlaylistEntry[] = [];
  let next: string | null = `/playlists/${playlistId}/items?limit=50`;
  while (next) {
    const page: { items: { added_at?: string; item?: SpotifyTrack | null; track?: SpotifyTrack | null }[]; next: string | null } =
      await api(next);
    for (const e of page.items) {
      const t = e.item ?? e.track;
      if (t && t.id && (t as { type?: string }).type !== 'episode') {
        out.push({ track: t, addedAt: e.added_at ? Date.parse(e.added_at) : Date.now() });
      }
    }
    next = page.next;
  }
  return out;
}

export async function addToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  if (!uris.length) return;
  await api(`/playlists/${playlistId}/items`, { method: 'POST', body: JSON.stringify({ uris }) });
}

export async function removeFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
  if (!uris.length) return;
  await api(`/playlists/${playlistId}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ items: uris.map((uri) => ({ uri })) }),
  });
}

// ---------- Lieblingssongs (Bibliothek) ----------

/** Alle Lieblingssongs, neueste zuerst. onProgress meldet (geladen, gesamt). */
export async function getSavedTracks(onProgress?: (done: number, total: number) => void): Promise<PlaylistEntry[]> {
  const out: PlaylistEntry[] = [];
  let next: string | null = '/me/tracks?limit=50';
  while (next) {
    const page: { items: { added_at?: string; track?: SpotifyTrack | null; item?: SpotifyTrack | null }[]; next: string | null; total?: number } =
      await api(next);
    for (const e of page.items) {
      const t = e.track ?? e.item;
      if (t && t.id) out.push({ track: t, addedAt: e.added_at ? Date.parse(e.added_at) : 0 });
    }
    onProgress?.(out.length, page.total ?? out.length);
    next = page.next;
  }
  return out;
}

/** Als Lieblingssong speichern (neuer Endpunkt PUT /me/library mit URIs, seit Feb. 2026). */
export async function saveToLibrary(uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 40) {
    const qs = encodeURIComponent(uris.slice(i, i + 40).join(','));
    await api(`/me/library?uris=${qs}`, { method: 'PUT' });
  }
}

export async function removeFromLibrary(uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 40) {
    const qs = encodeURIComponent(uris.slice(i, i + 40).join(','));
    await api(`/me/library?uris=${qs}`, { method: 'DELETE' });
  }
}

/** Sind diese Titel in den Lieblingssongs? (GET /me/library/contains mit URIs, seit Feb. 2026) */
export async function libraryContains(uris: string[]): Promise<boolean[]> {
  if (!uris.length) return [];
  const r = await api<boolean[] | null>(`/me/library/contains?uris=${encodeURIComponent(uris.join(','))}`);
  return Array.isArray(r) ? r : uris.map(() => false);
}
