// Kern der App: Rhythmus-Fingerabdruck, Ähnlichkeit und Bewertung von Vorschlägen.
// Reine Funktionen ohne Netzwerk, damit sie leicht testbar sind.

export interface Features {
  spotifyId: string;
  tempo: number;            // BPM
  danceability: number;     // 0..1
  energy: number;           // 0..1
  valence: number;          // 0..1 (Stimmung)
  acousticness: number;     // 0..1
  instrumentalness: number; // 0..1
  speechiness: number;      // 0..1
  loudness: number;         // dB
}

export interface Rated { id: string; features: Features; ratedAt: number; label?: string }

/** Gewichte: Rhythmus zählt am meisten, Klangfarbe und Stimmung weniger. */
export const WEIGHTS = {
  tempo: 2,
  danceability: 2,
  energy: 1.5,
  acousticness: 0.75,
  instrumentalness: 0.5,
  speechiness: 0.5,
  valence: 0.5,
} as const;

export const SETTINGS = {
  halfLifeDays: 14,     // nach so vielen Tagen zählt ein "Nein" nur noch halb
  rejectWeight: 0.7,    // wie stark ein "Nein" abschreckt
  exploreRate: 0.15,    // Anteil bewusster Ausreißer
  similarityWidth: 0.18,
  knn: 3,               // Vergleich mit den 3 ähnlichsten Favoriten
};

/**
 * Tempo-Abstand in Oktaven. Halbes oder doppeltes Tempo gilt als fast gleich
 * (ein 90-BPM-Hip-Hop-Beat und ein 180-BPM-Drum-and-Bass-Track teilen den Puls).
 * Ergebnis 0..1, wobei 0.25 Oktaven (ca. 19 %) Abweichung schon als "weit weg" gilt.
 */
export function tempoDistance(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0.5;
  const r = Math.abs(Math.log2(a / b));
  const folded = Math.min(r, Math.abs(r - 1) + 0.05, Math.abs(r - 2) + 0.1);
  return Math.min(1, folded / 0.25);
}

export function distance(a: Features, b: Features): number {
  let sum = 0;
  let wsum = 0;
  const add = (w: number, d: number) => { sum += w * d * d; wsum += w; };
  add(WEIGHTS.tempo, tempoDistance(a.tempo, b.tempo));
  add(WEIGHTS.danceability, a.danceability - b.danceability);
  add(WEIGHTS.energy, a.energy - b.energy);
  add(WEIGHTS.acousticness, a.acousticness - b.acousticness);
  add(WEIGHTS.instrumentalness, a.instrumentalness - b.instrumentalness);
  add(WEIGHTS.speechiness, a.speechiness - b.speechiness);
  add(WEIGHTS.valence, a.valence - b.valence);
  return Math.sqrt(sum / wsum);
}

/** Ähnlichkeit 0..1 (1 = gleicher Rhythmus-Fingerabdruck). */
export function similarity(a: Features, b: Features): number {
  const d = distance(a, b);
  const w = SETTINGS.similarityWidth;
  return Math.exp(-(d * d) / (2 * w * w));
}

/** Gewicht eines "Nein" nach seinem Alter: halbiert sich alle halfLifeDays. */
export function decay(ratedAt: number, now: number): number {
  const days = Math.max(0, now - ratedAt) / 86_400_000;
  return Math.pow(0.5, days / SETTINGS.halfLifeDays);
}

export interface Scored { features: Features; score: number; likeSim: number; nearest?: Rated }

export function score(c: Features, likes: Rated[], dislikes: Rated[], now: number): Scored {
  // Vergleich mit den k ähnlichsten Favoriten statt mit dem Durchschnitt:
  // So bleiben sehr unterschiedliche Rhythmen, die du magst, jeweils eigene "Inseln".
  let likeSim = 0.4; // neutraler Startwert ohne Favoriten
  let nearest: Rated | undefined;
  if (likes.length) {
    const sims = likes.map((l) => ({ l, s: similarity(c, l.features) })).sort((x, y) => y.s - x.s);
    const top = sims.slice(0, Math.min(SETTINGS.knn, sims.length));
    // stärkster Treffer zählt doppelt
    likeSim = (top[0].s * 2 + top.slice(1).reduce((acc, x) => acc + x.s, 0)) / (top.length + 1);
    nearest = top[0].l;
  }
  let dislikeSim = 0;
  for (const d of dislikes) {
    const s = similarity(c, d.features) * decay(d.ratedAt, now);
    if (s > dislikeSim) dislikeSim = s;
  }
  return { features: c, score: likeSim - SETTINGS.rejectWeight * dislikeSim, likeSim, nearest };
}

/** Darf ein früher abgelehnter Titel wieder auftauchen? Erst wenn das "Nein" mindestens halb verblasst ist. */
/** Wiedervorlage: Abgelehnte und verschobene Titel ruhen so lange, danach gibt es eine neue Chance. */
export const REVISIT = {
  afterDays: 90,  // ca. 3 Monate Pause
  every: 8,       // höchstens jeder 8. Vorschlag ist eine Wiedervorlage
  quietDays: 14,  // nach einer Wiedervorlage ohne Reaktion frühestens nach 14 Tagen erneut
};
const DAY_MS = 86_400_000;

/** Darf ein abgelehnter/verschobener Titel wieder auftauchen? Erst nach der Pause (ca. 3 Monate). */
export function mayResuggest(rejectedAt: number, now: number): boolean {
  return now - rejectedAt >= REVISIT.afterDays * DAY_MS;
}

/** Ganze Monate seit einem Zeitpunkt (für den Hinweis "vor 3 Monaten"). */
export function monthsAgo(at: number, now: number): number {
  return Math.max(1, Math.round((now - at) / (30 * DAY_MS)));
}

/** Kommt an Flussposition pos eine Wiedervorlage dran? */
export function revisitTurn(pos: number, due: number): boolean {
  return due > 0 && pos % REVISIT.every === 0;
}

export type Pick = { item: Scored; reason: 'match' | 'explore' | 'later' | 'artist' | 'revisit'; artist?: string; revisit?: { kind: 'rejected' | 'postponed'; at: number } };

/**
 * Nächsten Vorschlag wählen. Meist der beste Treffer (mit etwas Zufall unter den besten 5),
 * in etwa 15 % der Fälle ein bewusster Ausreißer aus dem Rest.
 */
export function pickNext(pool: Scored[], rand: () => number = Math.random): Pick | null {
  if (!pool.length) return null;
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  if (sorted.length > 5 && rand() < SETTINGS.exploreRate) {
    const rest = sorted.slice(5);
    return { item: rest[Math.floor(rand() * rest.length)], reason: 'explore' };
  }
  const top = sorted.slice(0, Math.min(5, sorted.length));
  // stärker gewichtet zum Besten hin
  const idx = Math.min(top.length - 1, Math.floor(Math.pow(rand(), 2) * top.length));
  return { item: top[idx], reason: 'match' };
}

// ---------- "Später nochmal": unbewertete Titel ----------

export interface LaterEntry { id: string; dueAt: number; dueCount: number; offers: number }

export const LATER = {
  afterSuggestions: 10,      // frühestens nach so vielen anderen Vorschlägen wieder anbieten …
  afterMs: 30 * 60_000,      // … oder spätestens nach 30 Minuten
  maxOffers: 3,              // nach dem 3. Mal ohne Bewertung nicht mehr anbieten
  maxEntries: 200,
};

/** Unbewerteten Titel vormerken. Gibt die neue Liste zurück (unverändert, wenn er schon zu oft kam). */
/** Wurde der Titel schon so oft ohne Bewertung angeboten, dass er in die lange Pause soll? */
export function laterExhausted(previousOffers: number): boolean {
  return previousOffers + 1 >= LATER.maxOffers + 1;
}

export function addLater(list: LaterEntry[], id: string, now: number, counter: number, previousOffers = 0): LaterEntry[] {
  const offers = previousOffers + 1;
  const rest = list.filter((e) => e.id !== id);
  if (laterExhausted(previousOffers)) return rest;
  return [...rest, { id, dueAt: now + LATER.afterMs, dueCount: counter + LATER.afterSuggestions, offers }].slice(-LATER.maxEntries);
}

/** Erster fälliger Eintrag (nach Anzahl Vorschlägen oder Zeit). */
export function dueLater(list: LaterEntry[], now: number, counter: number): LaterEntry | null {
  return list.find((e) => counter >= e.dueCount || now >= e.dueAt) ?? null;
}

// ---------- Künstler-Spezial ----------

/** Jeder wievielte Vorschlag aus der Künstler-Auswahl kommt (2 = jeder zweite). */
export const ARTIST_EVERY = 2;
export const ARTIST_COUNT = 20;

/** Kommt an Position pos (1, 2, 3 …) ein Künstler-Titel dran? */
export function artistTurn(pos: number, queued: number): boolean {
  return queued > 0 && pos % ARTIST_EVERY === 0;
}
