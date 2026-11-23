// Verbindet Spotify, Rhythmus-Dienst und Bewertungslogik.
// Lernstand = deine Spotify-Lieblingssongs (Ja) + private Playlist "Rhythmus-Abgelehnt" (Nein).
// Dadurch ist alles auf Handy und PC automatisch gleich.
import * as sp from './spotify';
import type { SpotifyTrack } from './spotify';
import { getFeatures, getRecommendations } from './reccobeats';
import { addLater, dueLater, mayResuggest, pickNext, score, type Features, type LaterEntry, type Pick, type Rated, type Scored } from './rhythm';

export const FAV_NAME = 'Rhythmus-Favoriten'; // ältere Version, wird einmalig in die Lieblingssongs übernommen
export const REJ_NAME = 'Rhythmus-Abgelehnt';

/**
 * Zufällige Suchanfrage über den ganzen Spotify-Katalog – ohne Genre.
 * Spotify bietet keine Liste "aller Titel"; zufällige Zeichen, Jahrgänge und Positionen
 * ergeben eine breite Stichprobe aus allen Stilen, Ländern und Jahrzehnten.
 */
const CHARS = 'abcdefghijklmnopqrstuvwxyzäöüéèáíóúñçå0123456789';
export function randomCatalogQuery(rand: () => number = Math.random): { q: string; maxOffset: number } {
  const ch = () => CHARS[Math.floor(rand() * CHARS.length)];
  const thisYear = new Date().getFullYear();
  const year = 1950 + Math.floor(Math.pow(rand(), 0.7) * (thisYear - 1950 + 1)); // etwas mehr neuere Jahrgänge
  const r = rand();
  if (r < 0.4) return { q: `${ch()} year:${year}`, maxOffset: 300 };
  if (r < 0.7) return { q: ch() + ch(), maxOffset: 990 };
  return { q: ch(), maxOffset: 990 };
}

export interface TrackInfo { id: string; uri: string; title: string; artists: string; image?: string; durationMs?: number }
export interface Suggestion extends TrackInfo { features: Features; reason: 'match' | 'explore' | 'later'; nearest?: string; score: number; offers?: number }

const infoFromTrack = (t: SpotifyTrack): TrackInfo => ({
  id: t.id,
  uri: t.uri,
  title: t.name,
  artists: t.artists.map((a) => a.name).join(', '),
  image: (t.album?.images ?? []).slice().sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 300) >= 200)?.url ?? t.album?.images?.[0]?.url,
  durationMs: t.duration_ms,
});

const pickRandom = <T,>(arr: T[], n: number): T[] => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

const K_LATER = 'rz.later';
function loadLater(): LaterEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(K_LATER) ?? '[]') as LaterEntry[];
    // Nach einem Neustart: Zähler beginnt bei 0 → fällig nach wenigen Vorschlägen, gestaffelt
    return Array.isArray(list) ? list.map((e, i) => ({ ...e, dueCount: 3 + i * 2 })) : [];
  } catch { return []; }
}

export class Engine {
  meId = '';
  rejId = '';
  likes = new Map<string, { info: TrackInfo; at: number }>();
  dislikes = new Map<string, { info: TrackInfo; at: number }>();
  features = new Map<string, Features>();
  info = new Map<string, TrackInfo>();
  private pool: Scored[] = [];
  private seen = new Set<string>();
  /** Bereits ausgewählte nächste Vorschläge – werden als Liste an Spotify geschickt (⏭ im Sperrbildschirm). */
  private upcoming: Pick[] = [];
  /** Unbewertete Titel, die später nochmal angeboten werden (bleibt über Neustarts erhalten). */
  private later: LaterEntry[] = loadLater();
  private offers = new Map<string, number>();
  private counter = 0;

  /** Fortschritt beim Laden/Analysieren, für die Anzeige. */
  progress = { phase: '', done: 0, total: 0 };
  onProgress: () => void = () => undefined;
  private setProgress(phase: string, done: number, total: number): void {
    this.progress = { phase, done, total };
    this.onProgress();
  }

  async init(): Promise<void> {
    const me = await sp.getMe();
    this.meId = me.id;
    const [rejId, oldFavId] = await Promise.all([
      sp.findOrCreatePlaylist(REJ_NAME, 'Abgelehnte Vorschläge, verblassen mit der Zeit (Rhythmus-App)', me.id),
      sp.findOrCreatePlaylist(FAV_NAME, '', me.id, false),
    ]);
    this.rejId = rejId;

    this.setProgress('Lieblingssongs laden', 0, 0);
    const [saved, rej, oldFav] = await Promise.all([
      sp.getSavedTracks((d, t) => this.setProgress('Lieblingssongs laden', d, t)),
      sp.getPlaylistEntries(this.rejId),
      oldFavId ? sp.getPlaylistEntries(oldFavId) : Promise.resolve([]),
    ]);
    for (const e of saved) {
      const i = infoFromTrack(e.track);
      this.info.set(i.id, i);
      this.likes.set(i.id, { info: i, at: e.addedAt });
    }
    // Titel aus der alten Playlist "Rhythmus-Favoriten" einmalig als Lieblingssongs speichern
    const missing = oldFav.filter((e) => !this.likes.has(e.track.id));
    if (missing.length) {
      try {
        await sp.saveToLibrary(missing.map((e) => e.track.uri));
        for (const e of missing) { const i = infoFromTrack(e.track); this.info.set(i.id, i); this.likes.set(i.id, { info: i, at: Date.now() }); }
      } catch { /* nicht kritisch, nächster Start versucht es erneut */ }
    }
    for (const e of rej) {
      const i = infoFromTrack(e.track);
      this.info.set(i.id, i);
      const prev = this.dislikes.get(i.id);
      if (!prev || prev.at < e.addedAt) this.dislikes.set(i.id, { info: i, at: e.addedAt });
    }

    // Erst Ablehnungen + die 200 neuesten Lieblingssongs analysieren, damit es schnell losgeht;
    // der Rest läuft im Hintergrund weiter (bereits analysierte Titel kommen aus dem Speicher).
    const likeIds = [...this.likes.entries()].sort((a, b) => b[1].at - a[1].at).map(([id]) => id);
    await this.loadFeatures([...this.dislikes.keys(), ...likeIds.slice(0, 200)]);
    this.analyzing = this.analyzeInBackground(likeIds.slice(200));
    void this.analyzing;
  }

  analyzing: Promise<void> | null = null;

  private async analyzeInBackground(ids: string[]): Promise<void> {
    const total = this.likes.size;
    for (let i = 0; i < ids.length; i += 120) {
      this.setProgress('Lieblingssongs analysieren', total - ids.length + i, total);
      try { await this.loadFeatures(ids.slice(i, i + 120)); } catch { /* weiter mit dem Rest */ }
      this.rescore();
    }
    this.setProgress('', total, total);
  }

  private async loadFeatures(ids: string[]): Promise<void> {
    const need = ids.filter((id) => !this.features.has(id));
    if (!need.length) return;
    const got = await getFeatures(need);
    got.forEach((f, id) => this.features.set(id, f));
  }

  private rated(map: Map<string, { info: TrackInfo; at: number }>): Rated[] {
    const out: Rated[] = [];
    map.forEach((v, id) => {
      const f = this.features.get(id);
      if (f) out.push({ id, features: f, ratedAt: v.at, label: `${v.info.title} – ${v.info.artists}` });
    });
    return out;
  }

  /** Favoriten ohne Rhythmusdaten (der Dienst kennt nicht jeden Titel). */
  likesWithoutData(): number {
    let n = 0;
    this.likes.forEach((_, id) => { if (!this.features.has(id)) n++; });
    return n;
  }

  private allowed(id: string, now: number): boolean {
    if (this.likes.has(id) || this.seen.has(id)) return false;
    const d = this.dislikes.get(id);
    return !d || mayResuggest(d.at, now);
  }

  private refilling: Promise<void> | null = null;

  /** Neue Kandidaten sammeln (läuft nie doppelt gleichzeitig). */
  refill(): Promise<void> {
    this.refilling ??= this.doRefill().finally(() => { this.refilling = null; });
    return this.refilling;
  }

  /** Empfehlungen ausgehend von Favoriten + Zufallssuchen quer durch alle Genres. */
  private async doRefill(): Promise<void> {
    const now = Date.now();
    const candidates = new Set<string>();
    const tasks: Promise<void>[] = [];

    const likeIds = [...this.likes.keys()].filter((id) => this.features.has(id));
    if (likeIds.length) {
      tasks.push(getRecommendations(pickRandom(likeIds, 5), 40).then((recs) => {
        for (const r of recs) {
          if (!this.info.has(r.spotifyId)) {
            this.info.set(r.spotifyId, { id: r.spotifyId, uri: `spotify:track:${r.spotifyId}`, title: r.title, artists: r.artists, durationMs: r.durationMs });
          }
          candidates.add(r.spotifyId);
        }
      }).catch(() => undefined));
    }

    // 4 Zufallsstichproben aus dem gesamten Katalog
    for (let k = 0; k < 4; k++) {
      const { q, maxOffset } = randomCatalogQuery();
      const offset = Math.floor(Math.random() * (maxOffset / 10)) * 10;
      tasks.push(sp.searchTracks(q, offset).then(async (tracks) => {
        if (!tracks.length && offset > 0) tracks = await sp.searchTracks(q, 0);
        for (const t of tracks) { this.info.set(t.id, infoFromTrack(t)); candidates.add(t.id); }
      }).catch(() => undefined));
    }
    await Promise.all(tasks);

    const fresh = [...candidates].filter((id) => this.allowed(id, now) && !this.pool.some((p) => p.features.spotifyId === id) && !this.upcoming.some((u) => u.item.features.spotifyId === id));
    await this.loadFeatures(fresh);
    const likes = this.rated(this.likes);
    const dislikes = this.rated(this.dislikes);
    for (const id of fresh) {
      const f = this.features.get(id);
      if (f) this.pool.push(score(f, likes, dislikes, now));
    }
  }

  /** Bewertungen im Vorrat neu berechnen, nachdem sich Favoriten/Ablehnungen geändert haben. */
  private rescore(): void {
    const now = Date.now();
    const likes = this.rated(this.likes);
    const dislikes = this.rated(this.dislikes);
    // Vorausgewählte zurück in den Vorrat, damit neue Bewertungen sofort wirken
    for (const u of this.upcoming) {
      if (u.reason === 'later') {
        const id = u.item.features.spotifyId;
        this.later = [{ id, dueAt: 0, dueCount: 0, offers: this.offers.get(id) ?? 1 }, ...this.later.filter((e) => e.id !== id)];
      } else this.pool.push(u.item);
    }
    this.saveLater();
    this.upcoming = [];
    this.pool = this.pool
      .filter((p) => this.allowed(p.features.spotifyId, now))
      .map((p) => score(p.features, likes, dislikes, now));
  }

  private takePick(): Pick | null {
    const pick = pickNext(this.pool);
    if (!pick) return null;
    const id = pick.item.features.spotifyId;
    this.pool = this.pool.filter((p) => p.features.spotifyId !== id);
    return pick;
  }

  private saveLater(): void {
    try { localStorage.setItem(K_LATER, JSON.stringify(this.later)); } catch { /* voll */ }
  }

  /** Titel lief ohne Ja/Nein (Ende, "Später", ⏭) → später nochmal anbieten. */
  markUnrated(id: string): void {
    if (this.likes.has(id) || this.dislikes.has(id)) return;
    const prev = this.offers.get(id) ?? this.later.find((e) => e.id === id)?.offers ?? 0;
    this.later = addLater(this.later, id, Date.now(), this.counter, prev);
    this.saveLater();
  }

  laterCount(): number { return this.later.length; }

  /** Fälligen "Später"-Titel als Vorschlag holen (oder null). */
  private async laterPick(): Promise<Pick | null> {
    const now = Date.now();
    for (let guard = 0; guard < 5; guard++) {
      const e = dueLater(this.later, now, this.counter);
      if (!e) return null;
      this.later = this.later.filter((x) => x.id !== e.id);
      this.saveLater();
      if (this.likes.has(e.id) || this.dislikes.has(e.id)) continue; // inzwischen bewertet
      if (!this.features.has(e.id)) { try { await this.loadFeatures([e.id]); } catch { /* ohne Daten */ } }
      const f = this.features.get(e.id);
      if (!f) continue;
      this.offers.set(e.id, e.offers);
      const sc = score(f, this.rated(this.likes), this.rated(this.dislikes), now);
      return { item: sc, reason: 'later' };
    }
    return null;
  }

  /** IDs der nächsten n Vorschläge (ohne sie schon als gesehen zu markieren). */
  upcomingIds(n = 15): string[] {
    while (this.upcoming.length < n) {
      const p = this.takePick();
      if (!p) break;
      this.upcoming.push(p);
    }
    // Fällige "Später"-Titel mit in die Liste, damit sie auch ohne App (Sperrbildschirm) wiederkommen
    const now = Date.now();
    const due = this.later.filter((e) => now >= e.dueAt && this.features.has(e.id) && !this.likes.has(e.id) && !this.dislikes.has(e.id)).slice(0, 3);
    due.forEach((e, k) => {
      this.later = this.later.filter((x) => x.id !== e.id);
      this.offers.set(e.id, e.offers);
      const sc = score(this.features.get(e.id)!, this.rated(this.likes), this.rated(this.dislikes), now);
      this.upcoming.splice(Math.min(this.upcoming.length, 2 + k * 4), 0, { item: sc, reason: 'later' });
    });
    if (due.length) this.saveLater();
    if (this.pool.length < 12) void this.refill().catch(() => undefined);
    return this.upcoming.slice(0, n).map((u) => u.item.features.spotifyId);
  }

  private async toSuggestion(pick: Pick): Promise<Suggestion> {
    const id = pick.item.features.spotifyId;
    this.seen.add(id);
    this.counter++;
    let info = this.info.get(id);
    if (!info || !info.title) {
      try { info = infoFromTrack(await sp.getTrack(id)); this.info.set(id, info); } catch { /* Anzeige ohne Titel */ }
    }
    return {
      ...(info ?? { id, uri: `spotify:track:${id}`, title: '', artists: '' }),
      features: pick.item.features,
      reason: pick.reason,
      nearest: pick.item.nearest?.label,
      score: pick.item.score,
      offers: pick.reason === 'later' ? this.offers.get(id) : undefined,
    };
  }

  /**
   * Spotify ist (z. B. per ⏭ im Sperrbildschirm oder am Titelende) zu einem der vorausgewählten Titel gesprungen:
   * diesen als aktuellen Vorschlag übernehmen, übersprungene gelten als gesehen.
   */
  async jumpTo(id: string): Promise<Suggestion | null> {
    const idx = this.upcoming.findIndex((u) => u.item.features.spotifyId === id);
    if (idx >= 0) {
      // Übersprungene (⏭) gelten als unbewertet → später nochmal
      for (const u of this.upcoming.slice(0, idx)) { this.seen.add(u.item.features.spotifyId); this.markUnrated(u.item.features.spotifyId); }
      const pick = this.upcoming[idx];
      this.upcoming = this.upcoming.slice(idx + 1);
      return this.toSuggestion(pick);
    }
    // Nicht mehr vorausgewählt (z. B. nach neuer Bewertung zurück im Vorrat)?
    const f = this.features.get(id);
    if (!f) return null;
    this.pool = this.pool.filter((p) => p.features.spotifyId !== id);
    const sc = score(f, this.rated(this.likes), this.rated(this.dislikes), Date.now());
    return this.toSuggestion({ item: sc, reason: 'match' });
  }

  /** In Spotify mit ♥ gespeichert? → zählt als Ja (nur lokal merken, gespeichert ist es ja schon). */
  async syncExternalLikes(ids: string[]): Promise<string[]> {
    const check = ids.filter((id) => !this.likes.has(id)).slice(0, 40);
    if (!check.length) return [];
    const saved = await sp.libraryContains(check.map((id) => `spotify:track:${id}`));
    const newly: string[] = [];
    check.forEach((id, i) => {
      if (!saved[i]) return;
      const info = this.info.get(id) ?? { id, uri: `spotify:track:${id}`, title: '', artists: '' };
      this.dislikes.delete(id);
      this.likes.set(id, { info, at: Date.now() });
      newly.push(id);
    });
    if (newly.length) this.rescore();
    return newly;
  }

  async next(): Promise<Suggestion | null> {
    // Nur warten, wenn der Vorrat fast leer ist – sonst kommt der nächste Titel sofort
    for (let tries = 0; this.pool.length + this.upcoming.length < 3 && tries < 3; tries++) await this.refill();
    const now = Date.now();
    let pick: Pick | null = await this.laterPick();
    while (this.upcoming.length && !pick) {
      const u = this.upcoming.shift()!;
      const uid = u.item.features.spotifyId;
      if (u.reason === 'later' ? !this.likes.has(uid) && !this.dislikes.has(uid) : this.allowed(uid, now)) pick = u;
    }
    pick ??= this.takePick();
    if (!pick) return null;
    // Vorrat im Hintergrund auffüllen, während du hörst
    if (this.pool.length < 12) void this.refill().catch(() => undefined);
    return this.toSuggestion(pick);
  }

  /**
   * Ja/Nein: Lernstand sofort lokal ändern (damit der nächste Vorschlag es schon berücksichtigt).
   * Ja → Spotify-Lieblingssongs, Nein → Playlist "Rhythmus-Abgelehnt". Das Speichern läuft im Hintergrund. Das zurückgegebene Promise meldet Speicherfehler.
   */
  rate(info: TrackInfo, yes: boolean): Promise<void> {
    const wasLiked = this.likes.has(info.id);
    const wasDisliked = this.dislikes.has(info.id);
    this.info.set(info.id, info);
    if (yes) {
      this.dislikes.delete(info.id);
      this.likes.set(info.id, { info, at: Date.now() });
    } else {
      this.likes.delete(info.id); // z. B. erst ♥, dann doch Nein
      this.dislikes.set(info.id, { info, at: Date.now() });
    }
    this.rescore();
    return (async () => {
      if (yes) {
        if (wasDisliked) await sp.removeFromPlaylist(this.rejId, [info.uri]);
        if (!wasLiked) await sp.saveToLibrary([info.uri]);
        if (!this.features.has(info.id)) { await this.loadFeatures([info.id]); this.rescore(); }
      } else {
        if (wasLiked) await sp.removeFromLibrary([info.uri]);
        // Erneutes "Nein": alten Eintrag ersetzen, damit das Datum aktuell ist
        if (wasDisliked) await sp.removeFromPlaylist(this.rejId, [info.uri]);
        await sp.addToPlaylist(this.rejId, [info.uri]);
      }
    })();
  }

  /** Für die Suche: als Favorit speichern und auf das Speichern warten. */
  async like(info: TrackInfo): Promise<void> {
    await this.rate(info, true);
  }

  async unlike(info: TrackInfo): Promise<void> {
    await sp.removeFromLibrary([info.uri]);
    this.likes.delete(info.id);
    this.rescore();
  }

  async search(q: string, offset = 0): Promise<TrackInfo[]> {
    const tracks = await sp.searchTracks(q, offset);
    return tracks.map((t) => { const i = infoFromTrack(t); this.info.set(i.id, i); return i; });
  }
}
