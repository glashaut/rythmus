// Rhythmus-Daten von ReccoBeats (kostenlos, kein API-Schlüssel).
// Ersatz für Spotifys abgeschaltete Endpunkte /audio-features und /recommendations.
import type { Features } from './rhythm';

const BASE = 'https://api.reccobeats.com/v1';
const K_CACHE = 'rz.features';
const MAX_IDS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holt die Spotify-ID aus einem Eintrag (ReccoBeats liefert sie im Feld href als open.spotify.com-Link). */
export function spotifyIdOf(entry: { href?: string; spotifyId?: string; id?: string }): string | null {
  if (entry.spotifyId) return entry.spotifyId;
  const m = entry.href?.match(/track\/([A-Za-z0-9]{22})/);
  if (m) return m[1];
  if (entry.id && /^[A-Za-z0-9]{22}$/.test(entry.id)) return entry.id;
  return null;
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('Retry-After') ?? '2');
    await sleep(Math.min(30, Math.max(1, wait)) * 1000);
    return get<T>(path, attempt + 1);
  }
  if (res.status === 404) return { content: [] } as T;
  if (!res.ok) throw new Error(`Rhythmus-Dienst ${res.status}`);
  return (await res.json()) as T;
}

// ---------- Cache, damit jeder Titel nur einmal abgefragt wird ----------
type Cache = Record<string, Features | null>;
let cache: Cache | null = null;
function loadCache(): Cache {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(K_CACHE) ?? '{}') as Cache; } catch { cache = {}; }
  return cache;
}
function persistCache(): void {
  try { localStorage.setItem(K_CACHE, JSON.stringify(cache ?? {})); } catch { /* voll */ }
}

interface RawFeatures {
  href?: string; id?: string;
  tempo?: number; danceability?: number; energy?: number; valence?: number;
  acousticness?: number; instrumentalness?: number; speechiness?: number; loudness?: number;
}

function toFeatures(r: RawFeatures, spotifyId: string): Features {
  return {
    spotifyId,
    tempo: r.tempo ?? 0,
    danceability: r.danceability ?? 0.5,
    energy: r.energy ?? 0.5,
    valence: r.valence ?? 0.5,
    acousticness: r.acousticness ?? 0.5,
    instrumentalness: r.instrumentalness ?? 0,
    speechiness: r.speechiness ?? 0,
    loudness: r.loudness ?? -10,
  };
}

/** Rhythmus-Merkmale für mehrere Spotify-IDs. Titel ohne Daten fehlen im Ergebnis. */
export async function getFeatures(spotifyIds: string[]): Promise<Map<string, Features>> {
  const c = loadCache();
  const out = new Map<string, Features>();
  const missing: string[] = [];
  for (const id of new Set(spotifyIds)) {
    if (id in c) { const f = c[id]; if (f) out.set(id, f); } else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += MAX_IDS) {
    const chunk = missing.slice(i, i + MAX_IDS);
    const qs = chunk.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
    const data = await get<{ content?: RawFeatures[] }>(`/audio-features?${qs}`);
    const found = new Set<string>();
    for (const raw of data.content ?? []) {
      const sid = spotifyIdOf(raw);
      if (!sid || !raw.tempo) continue;
      const f = toFeatures(raw, sid);
      c[sid] = f; out.set(sid, f); found.add(sid);
    }
    // Unbekannte Titel merken, damit sie nicht ständig neu angefragt werden
    for (const id of chunk) if (!found.has(id)) c[id] = null;
  }
  if (missing.length) persistCache();
  return out;
}

export interface ReccoTrack { spotifyId: string; title: string; artists: string; durationMs?: number }

/** Empfehlungen ausgehend von bis zu 5 Spotify-IDs. */
export async function getRecommendations(seeds: string[], size = 40): Promise<ReccoTrack[]> {
  if (!seeds.length) return [];
  const qs = seeds.slice(0, 5).map((s) => `seeds=${encodeURIComponent(s)}`).join('&');
  const data = await get<{ content?: { href?: string; id?: string; trackTitle?: string; durationMs?: number; artists?: { name: string }[] }[] }>(
    `/track/recommendation?${qs}&size=${Math.min(100, size)}`,
  );
  const out: ReccoTrack[] = [];
  for (const t of data.content ?? []) {
    const sid = spotifyIdOf(t);
    if (sid) out.push({ spotifyId: sid, title: t.trackTitle ?? '', artists: (t.artists ?? []).map((a) => a.name).join(', '), durationMs: t.durationMs });
  }
  return out;
}
