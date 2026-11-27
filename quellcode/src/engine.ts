// Verbindet Spotify, Rhythmus-Dienst und Bewertungslogik.
// Lernstand = deine Spotify-Lieblingssongs (Ja) + private Playlist "Rhythmus-Abgelehnt" (Nein).
// Dadurch ist alles auf Handy und PC automatisch gleich.
import * as sp from './spotify';
import type { SpotifyTrack } from './spotify';
import { getFeatures, getRecommendations } from './reccobeats';
import { addLater, ARTIST_COUNT, artistTurn, dueLater, laterExhausted, mayResuggest, monthsAgo, pickNext, REVISIT, revisitTurn, score, type Features, type LaterEntry, type Pick, type Rated, type Scored } from './rhythm';

export const FAV_NAME = 'Rhythmus-Favoriten'; // ältere Version, wird einmalig in die Lieblingssongs übernommen
export const REJ_NAME = 'Rhythmus-Abgelehnt';
export const POSTPONE_NAME = 'Rhythmus-Später';

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

export type ActionKind = 'yes' | 'no' | 'later' | 'skip';
interface StateSnap {
  liked?: { info: TrackInfo; at: number };
  disliked?: { info: TrackInfo; at: number };
  postponed?: { info: TrackInfo; at: number };
  laterEntry?: LaterEntry;
}
export interface UndoEntry { s: Suggestion; kind: ActionKind; positionMs: number; prev: StateSnap }

export interface TrackInfo { id: string; uri: string; title: string; artists: string; artistList?: string[]; image?: string; durationMs?: number }
export interface Suggestion extends TrackInfo {
  features: Features; reason: 'match' | 'explore' | 'later' | 'artist' | 'revisit'; nearest?: string; score: number; offers?: number;
  /** Wiedervorlage: früher abgelehnt oder verschoben, vor wie vielen Monaten */
  revisit?: { kind: 'rejected' | 'postponed'; months: number };
  /** Künstler-Spezial: von welchem Künstler, der wievielte von wie vielen */
  special?: { artist: string; n: number; total: number };
}

const infoFromTrack = (t: SpotifyTrack): TrackInfo => ({
  id: t.id,
  uri: t.uri,
  title: t.name,
  artists: t.artists.map((a) => a.name).join(', '),
  artistList: t.artists.map((a) => a.name),
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

const K_ARTISTS = 'rz.artists';
const K_ARTIST_QUEUE = 'rz.artistQueue';
interface ArtistEntry { name: string; addedAt: number; total: number; served: number }
interface ArtistQueued { id: string; artist: string }
function loadJson<T>(key: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; return v ?? fallback; } catch { return fallback; }
}
function saveJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* voll */ }
}
const norm = (s: string) => s.trim().toLowerCase();

const K_REVISIT_SHOWN = 'rz.revisitShown';
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
  /** Künstler, die du markiert hast, und die noch offenen Titel von/mit ihnen. */
  artists: ArtistEntry[] = loadJson<ArtistEntry[]>(K_ARTISTS, []);
  private artistQueue: ArtistQueued[] = loadJson<ArtistQueued[]>(K_ARTIST_QUEUE, []);
  /** Mit "Später" verschobene Titel (private Playlist, Datum = wann verschoben) */
  postponed = new Map<string, { info: TrackInfo; at: number }>();
  postId = '';
  private revisitShown: Record<string, number> = loadJson<Record<string, number>>(K_REVISIT_SHOWN, {});
  /** Spotify-Schreibvorgänge nacheinander ausführen (wichtig für "Zurück") */
  private net: Promise<void> = Promise.resolve();
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const p = this.net.then(fn);
    this.net = p.catch(() => undefined);
    return p;
  }
  /** Letzte Aktionen für den Zurück-Knopf */
  private undoStack: UndoEntry[] = [];
  /** Nach "Zurück": der verdrängte Titel kommt als nächster (überlebt Neubewertungen) */
  private front: Pick[] = [];

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
    const [rejId, oldFavId, postId] = await Promise.all([
      sp.findOrCreatePlaylist(REJ_NAME, 'Abgelehnte Vorschläge, kommen nach ca. 3 Monaten wieder (Rhythmus-App)', me.id),
      sp.findOrCreatePlaylist(FAV_NAME, '', me.id, false),
      sp.findOrCreatePlaylist(POSTPONE_NAME, 'Mit "Später" verschobene Vorschläge, kommen nach ca. 3 Monaten wieder (Rhythmus-App)', me.id),
    ]);
    this.rejId = rejId;
    this.postId = postId;

    this.setProgress('Lieblingssongs laden', 0, 0);
    const [saved, rej, oldFav, post] = await Promise.all([
      sp.getSavedTracks((d, t) => this.setProgress('Lieblingssongs laden', d, t)),
      sp.getPlaylistEntries(this.rejId),
      oldFavId ? sp.getPlaylistEntries(oldFavId) : Promise.resolve([]),
      sp.getPlaylistEntries(this.postId),
    ]);
    for (const e of post) {
      const i = infoFromTrack(e.track);
      this.info.set(i.id, i);
      const prev = this.postponed.get(i.id);
      if (!prev || prev.at < e.addedAt) this.postponed.set(i.id, { info: i, at: e.addedAt });
    }
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
    await this.loadFeatures([...this.dislikes.keys(), ...this.postponed.keys(), ...likeIds.slice(0, 200)]);
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
    // Abgelehnte und verschobene Titel kommen nur über die Wiedervorlage zurück (nach ca. 3 Monaten, dosiert)
    void now;
    return !this.dislikes.has(id) && !this.postponed.has(id);
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
            this.info.set(r.spotifyId, { id: r.spotifyId, uri: `spotify:track:${r.spotifyId}`, title: r.title, artists: r.artists, artistList: r.artists ? r.artists.split(', ') : [], durationMs: r.durationMs });
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
    const backToArtist: ArtistQueued[] = [];
    for (const u of this.upcoming) {
      if (u.reason === 'revisit') {
        delete this.revisitShown[u.item.features.spotifyId]; // noch nicht gezeigt → bleibt fällig
      } else if (u.reason === 'artist') {
        backToArtist.push({ id: u.item.features.spotifyId, artist: u.artist ?? '' });
      } else if (u.reason === 'later') {
        const id = u.item.features.spotifyId;
        this.later = [{ id, dueAt: 0, dueCount: 0, offers: this.offers.get(id) ?? 1 }, ...this.later.filter((e) => e.id !== id)];
      } else this.pool.push(u.item);
    }
    this.artistQueue.unshift(...backToArtist);
    this.saveLater();
    this.saveArtists();
    this.upcoming = [];
    this.pool = this.pool
      .filter((p) => this.allowed(p.features.spotifyId, now))
      .map((p) => score(p.features, likes, dislikes, now));
  }

  private saveArtists(): void {
    saveJson(K_ARTISTS, this.artists);
    saveJson(K_ARTIST_QUEUE, this.artistQueue);
  }

  isArtistLiked(name: string): boolean {
    return this.artists.some((a) => norm(a.name) === norm(name));
  }

  /** Noch offene Künstler-Spezial-Titel je Künstler. */
  artistPending(name: string): number {
    const n = norm(name);
    return this.artistQueue.filter((q) => norm(q.artist) === n).length
      + this.upcoming.filter((u) => u.reason === 'artist' && norm(u.artist ?? '') === n).length;
  }

  /**
   * Künstler markieren: bis zu 20 zufällige Titel von oder mit ihm suchen und in den Fluss einreihen.
   * Gibt die Anzahl gefundener Titel zurück.
   */
  async likeArtist(name: string): Promise<number> {
    if (this.isArtistLiked(name)) return this.artistPending(name);
    const now = Date.now();
    // Suche nach dem Künstlernamen findet auch Titel, bei denen er nur mitwirkt (feat.)
    // Bis zu 100 Treffer einsammeln (Seiten à 10), danach zufällig 20 auswählen
    const found = new Map<string, TrackInfo>();
    const want = norm(name);
    for (let off = 0; off < 100; off += 10) {
      let tracks: SpotifyTrack[] = [];
      try { tracks = await sp.searchTracks(`artist:"${name}"`, off); } catch { break; }
      for (const t of tracks) {
        if (!t.artists.some((a) => norm(a.name) === want)) continue; // nur echte Treffer (von oder mit)
        const id = t.id;
        if (this.likes.has(id) || this.seen.has(id) || found.has(id)) continue;
        if (this.dislikes.has(id) || this.postponed.has(id)) continue;
        const info = infoFromTrack(t);
        this.info.set(id, info);
        found.set(id, info);
      }
      if (tracks.length < 10) break; // letzte Seite erreicht
    }
    const ids = pickRandom([...found.keys()], found.size);
    await this.loadFeatures(ids);
    const chosen = ids.filter((id) => this.features.has(id)).slice(0, ARTIST_COUNT);
    // Fehlen Rhythmusdaten, notfalls trotzdem nehmen (Anzeige ohne Balken)
    if (chosen.length < ARTIST_COUNT) {
      for (const id of ids) {
        if (chosen.length >= ARTIST_COUNT) break;
        if (!chosen.includes(id)) chosen.push(id);
      }
    }
    this.artists.push({ name, addedAt: now, total: chosen.length, served: 0 });
    this.artistQueue.push(...chosen.map((id) => ({ id, artist: name })));
    // Neu eingereiht → Vorauswahl neu mischen, damit die Titel bald kommen
    this.rescore();
    return chosen.length;
  }

  /** Markierung aufheben: noch offene Titel dieses Künstlers verschwinden wieder. */
  unlikeArtist(name: string): void {
    const n = norm(name);
    this.artists = this.artists.filter((a) => norm(a.name) !== n);
    this.upcoming = this.upcoming.filter((u) => !(u.reason === 'artist' && norm(u.artist ?? '') === n));
    this.artistQueue = this.artistQueue.filter((q) => norm(q.artist) !== n);
    this.saveArtists();
  }

  private artistPick(): Pick | null {
    while (this.artistQueue.length) {
      const q = this.artistQueue.shift()!;
      if (this.likes.has(q.id)) continue;
      const f: Features = this.features.get(q.id) ?? {
        spotifyId: q.id, tempo: 0, danceability: 0, energy: 0, valence: 0, acousticness: 0, instrumentalness: 0, speechiness: 0, loudness: 0,
      };
      const sc = score(f, this.rated(this.likes), this.rated(this.dislikes), Date.now());
      this.saveArtists();
      return { item: sc, reason: 'artist', artist: q.artist };
    }
    return null;
  }

  /** Nächster Titel im Fluss: abwechselnd normal und (falls markiert) Künstler-Spezial. */
  private takeFlowPick(): Pick | null {
    // Position, an der dieser Titel angezeigt wird (zählt nur wirklich gezeigte Vorschläge,
    // damit Neuberechnungen der Vorauswahl die Abstände nicht verkürzen)
    const pos = this.counter + 1 + this.front.length + this.upcoming.length;
    if (revisitTurn(pos, this.dislikes.size + this.postponed.size)) {
      const r = this.revisitPick();
      if (r) return r;
    }
    if (artistTurn(pos, this.artistQueue.length)) {
      const a = this.artistPick();
      if (a) return a;
    }
    return this.takePick() ?? this.artistPick();
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
    if (laterExhausted(prev)) {
      // Schon mehrfach ohne Bewertung gelaufen → in die lange Pause (ca. 3 Monate)
      const info = this.info.get(id);
      if (info) void this.postpone(info).catch(() => undefined);
      this.later = this.later.filter((e) => e.id !== id);
      this.saveLater();
      return;
    }
    this.later = addLater(this.later, id, Date.now(), this.counter, prev);
    this.saveLater();
  }

  /**
   * "Später": Titel ruht ca. 3 Monate und kommt dann als Wiedervorlage zurück.
   * Gespeichert in der privaten Playlist "Rhythmus-Später" (gilt auf allen Geräten).
   * Ein früher abgelehnter Titel wechselt dabei von "Abgelehnt" nach "Später".
   */
  postpone(info: TrackInfo): Promise<void> {
    if (this.likes.has(info.id)) return Promise.resolve();
    const wasPostponed = this.postponed.has(info.id);
    const wasDisliked = this.dislikes.has(info.id);
    this.info.set(info.id, info);
    this.dislikes.delete(info.id);
    this.postponed.set(info.id, { info, at: Date.now() });
    this.later = this.later.filter((e) => e.id !== info.id);
    this.saveLater();
    this.rescore();
    return this.enqueue(async () => {
      if (wasDisliked) await sp.removeFromPlaylist(this.rejId, [info.uri]);
      if (wasPostponed) await sp.removeFromPlaylist(this.postId, [info.uri]); // Datum erneuern
      await sp.addToPlaylist(this.postId, [info.uri]);
    });
  }

  // ---------- Zurück ----------

  /** Vor einer Aktion aufrufen: merkt sich den Zustand, damit "Zurück" ihn wiederherstellen kann. */
  record(kind: ActionKind, s: Suggestion, positionMs: number): void {
    const id = s.id;
    const prev: StateSnap = {
      liked: this.likes.get(id),
      disliked: this.dislikes.get(id),
      postponed: this.postponed.get(id),
      laterEntry: this.later.find((e) => e.id === id),
    };
    this.undoStack.push({ s, kind, positionMs, prev });
    if (this.undoStack.length > 10) this.undoStack.shift();
  }

  canUndo(): boolean { return this.undoStack.length > 0; }

  /**
   * Letzte Aktion rückgängig machen. Der zuletzt angezeigte Titel (shown) kommt als nächster wieder dran.
   * Gibt den wiederhergestellten Vorschlag samt Position zurück.
   */
  undo(shown: Suggestion | null): UndoEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    const { s, prev } = e;
    const id = s.id;
    const uri = s.uri || `spotify:track:${id}`;
    const ops: (() => Promise<void>)[] = [];

    const nowLiked = this.likes.has(id);
    if (nowLiked && !prev.liked) { this.likes.delete(id); ops.push(() => sp.removeFromLibrary([uri])); }
    if (!nowLiked && prev.liked) { this.likes.set(id, prev.liked); ops.push(() => sp.saveToLibrary([uri])); }

    const nowDis = this.dislikes.has(id);
    if (nowDis && !prev.disliked) { this.dislikes.delete(id); ops.push(() => sp.removeFromPlaylist(this.rejId, [uri])); }
    else if (!nowDis && prev.disliked) { this.dislikes.set(id, prev.disliked); ops.push(() => sp.addToPlaylist(this.rejId, [uri])); }
    else if (prev.disliked) this.dislikes.set(id, prev.disliked);

    const nowPost = this.postponed.has(id);
    if (nowPost && !prev.postponed) { this.postponed.delete(id); ops.push(() => sp.removeFromPlaylist(this.postId, [uri])); }
    else if (!nowPost && prev.postponed) { this.postponed.set(id, prev.postponed); ops.push(() => sp.addToPlaylist(this.postId, [uri])); }
    else if (prev.postponed) this.postponed.set(id, prev.postponed);

    this.later = this.later.filter((x) => x.id !== id);
    if (prev.laterEntry) this.later.push(prev.laterEntry);
    this.saveLater();

    if (ops.length) void this.enqueue(async () => { for (const op of ops) await op(); }).catch(() => undefined);

    this.rescore();
    // Der inzwischen gezeigte Titel kommt direkt danach wieder dran
    this.front = this.front.filter((p) => p.item.features.spotifyId !== id);
    if (shown && shown.id !== id) {
      const sc = score(shown.features, this.rated(this.likes), this.rated(this.dislikes), Date.now());
      if (shown.reason === 'artist' && shown.special) this.front.unshift({ item: sc, reason: 'artist', artist: shown.special.artist });
      else this.front.unshift({ item: sc, reason: shown.reason === 'explore' ? 'explore' : 'match' });
    }
    return e;
  }

  /** Fällige Wiedervorlagen (abgelehnt/verschoben vor mehr als ca. 3 Monaten), älteste zuerst. */
  dueRevisits(now = Date.now()): { id: string; kind: 'rejected' | 'postponed'; at: number }[] {
    const quiet = REVISIT.quietDays * 86_400_000;
    const out: { id: string; kind: 'rejected' | 'postponed'; at: number }[] = [];
    const add = (id: string, at: number, kind: 'rejected' | 'postponed') => {
      if (!mayResuggest(at, now) || this.likes.has(id) || this.seen.has(id)) return;
      if (now - (this.revisitShown[id] ?? 0) < quiet) return;
      if (this.upcoming.some((u) => u.item.features.spotifyId === id)) return;
      out.push({ id, kind, at });
    };
    this.dislikes.forEach((v, id) => add(id, v.at, 'rejected'));
    this.postponed.forEach((v, id) => add(id, v.at, 'postponed'));
    return out.sort((a, b) => a.at - b.at);
  }

  private revisitPick(): Pick | null {
    const now = Date.now();
    for (const r of this.dueRevisits(now)) {
      const f = this.features.get(r.id);
      if (!f) continue;
      this.revisitShown[r.id] = now;
      saveJson(K_REVISIT_SHOWN, this.revisitShown);
      const sc = score(f, this.rated(this.likes), this.rated(this.dislikes.size ? new Map([...this.dislikes].filter(([id]) => id !== r.id)) : this.dislikes), now);
      return { item: sc, reason: 'revisit', revisit: { kind: r.kind, at: r.at } };
    }
    return null;
  }

  laterCount(): number { return this.later.length; }

  private servedArtist(name: string): { artist: string; n: number; total: number } {
    const e = this.artists.find((a) => norm(a.name) === norm(name));
    if (!e) return { artist: name, n: 1, total: 1 };
    e.served = Math.min(e.total, e.served + 1);
    this.saveArtists();
    return { artist: e.name, n: e.served, total: e.total };
  }

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
      const p = this.takeFlowPick();
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
    return [...this.front, ...this.upcoming].slice(0, n).map((u) => u.item.features.spotifyId);
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
      special: pick.reason === 'artist' ? this.servedArtist(pick.artist ?? '') : undefined,
      revisit: pick.revisit ? { kind: pick.revisit.kind, months: monthsAgo(pick.revisit.at, Date.now()) } : undefined,
    };
  }

  /**
   * Spotify ist (z. B. per ⏭ im Sperrbildschirm oder am Titelende) zu einem der vorausgewählten Titel gesprungen:
   * diesen als aktuellen Vorschlag übernehmen, übersprungene gelten als gesehen.
   */
  async jumpTo(id: string): Promise<Suggestion | null> {
    const fi = this.front.findIndex((u) => u.item.features.spotifyId === id);
    if (fi >= 0) {
      const pick = this.front[fi];
      this.front.splice(fi, 1);
      return this.toSuggestion(pick);
    }
    const idx = this.upcoming.findIndex((u) => u.item.features.spotifyId === id);
    if (idx >= 0) {
      // Übersprungene (⏭ in Spotify) gelten wie "Später" → ca. 3 Monate Pause
      for (const u of this.upcoming.slice(0, idx)) {
        const uid = u.item.features.spotifyId;
        this.seen.add(uid);
        const info = this.info.get(uid);
        if (info) void this.postpone(info).catch(() => undefined);
      }
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
    for (let tries = 0; this.pool.length + this.upcoming.length + this.artistQueue.length < 3 && tries < 3; tries++) await this.refill();
    const now = Date.now();
    let pick: Pick | null = null;
    while (this.front.length && !pick) {
      const f = this.front.shift()!;
      if (!this.likes.has(f.item.features.spotifyId)) pick = f;
    }
    pick ??= await this.laterPick();
    while (this.upcoming.length && !pick) {
      const u = this.upcoming.shift()!;
      const uid = u.item.features.spotifyId;
      const ok = u.reason === 'revisit' ? !this.likes.has(uid)
        : u.reason === 'later' || u.reason === 'artist' ? !this.likes.has(uid) && !this.dislikes.has(uid)
        : this.allowed(uid, now);
      if (ok) pick = u;
    }
    pick ??= this.takeFlowPick();
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
    const wasPostponed = this.postponed.has(info.id);
    this.postponed.delete(info.id);
    this.later = this.later.filter((e) => e.id !== info.id);
    this.saveLater();
    this.info.set(info.id, info);
    if (yes) {
      this.dislikes.delete(info.id);
      this.likes.set(info.id, { info, at: Date.now() });
    } else {
      this.likes.delete(info.id); // z. B. erst ♥, dann doch Nein
      this.dislikes.set(info.id, { info, at: Date.now() });
    }
    this.rescore();
    return this.enqueue(async () => {
      if (wasPostponed) await sp.removeFromPlaylist(this.postId, [info.uri]);
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
    });
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
