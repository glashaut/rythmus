// Tests der Bewertungslogik: npm test
import assert from 'node:assert/strict';
import { decay, mayResuggest, pickNext, score, similarity, tempoDistance, type Features, type Rated } from '../src/rhythm';

const f = (id: string, tempo: number, d: number, e: number, extra: Partial<Features> = {}): Features => ({
  spotifyId: id, tempo, danceability: d, energy: e, valence: 0.5, acousticness: 0.2,
  instrumentalness: 0.1, speechiness: 0.05, loudness: -7, ...extra,
});
const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 20);
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log('✓', name); };

test('gleiches Tempo hat Abstand 0', () => assert.equal(tempoDistance(120, 120), 0));
test('halbes/doppeltes Tempo gilt als nah', () => {
  assert.ok(tempoDistance(90, 180) < 0.25, `90/180 → ${tempoDistance(90, 180)}`);
  assert.ok(tempoDistance(90, 130) > 0.9, `90/130 → ${tempoDistance(90, 130)}`);
});
test('fehlendes Tempo ist neutral', () => assert.equal(tempoDistance(0, 120), 0.5));

test('ähnlicher Groove über Genregrenzen ist ähnlicher als gleiches Genre mit anderem Groove', () => {
  const funk = f('funk', 104, 0.85, 0.7);
  const afrobeat = f('afro', 106, 0.82, 0.72, { acousticness: 0.35 });
  const funkBallad = f('ballad', 68, 0.4, 0.3);
  assert.ok(similarity(funk, afrobeat) > 0.7, `afro ${similarity(funk, afrobeat)}`);
  assert.ok(similarity(funk, funkBallad) < 0.1, `ballad ${similarity(funk, funkBallad)}`);
});

test('mehrere verschiedene Vorlieben bleiben eigene Inseln (kein Durchschnitt)', () => {
  const likes: Rated[] = [
    { id: 'a', features: f('a', 174, 0.55, 0.9), ratedAt: now },   // Drum and Bass
    { id: 'b', features: f('b', 72, 0.6, 0.25, { acousticness: 0.8 }), ratedAt: now }, // ruhig, akustisch
  ];
  const nearDnb = score(f('x', 172, 0.57, 0.88), likes, [], now);
  const middle = score(f('y', 123, 0.58, 0.57, { acousticness: 0.5 }), likes, [], now);
  assert.ok(nearDnb.score > middle.score, `${nearDnb.score} vs ${middle.score}`);
  assert.equal(nearDnb.nearest?.id, 'a');
});

test('Ablehnung verblasst: Halbwertszeit 14 Tage', () => {
  assert.equal(decay(now, now), 1);
  assert.ok(Math.abs(decay(now - 14 * DAY, now) - 0.5) < 1e-9);
  assert.equal(mayResuggest(now - 3 * DAY, now), false);
  assert.equal(mayResuggest(now - 15 * DAY, now), true);
});

test('frische Ablehnung drückt ähnliche Titel stärker als alte', () => {
  const likes: Rated[] = [{ id: 'l', features: f('l', 120, 0.8, 0.7), ratedAt: now }];
  const c = f('c', 121, 0.79, 0.71);
  const fresh = score(c, likes, [{ id: 'd', features: f('d', 121, 0.8, 0.7), ratedAt: now }], now);
  const old = score(c, likes, [{ id: 'd', features: f('d', 121, 0.8, 0.7), ratedAt: now - 60 * DAY }], now);
  assert.ok(old.score > fresh.score);
});

test('Auswahl: ohne Zufall der Beste, mit Zufall < 15 % ein Ausreißer', () => {
  const pool = Array.from({ length: 10 }, (_, i) => ({ features: f(`t${i}`, 100, 0.5, 0.5), score: i / 10, likeSim: 0 }));
  const best = pickNext(pool, () => 0.99 * 0 + 0.5); // 0.5 > 0.15 → kein Ausreißer, idx floor(0.25*5)=1
  assert.equal(best?.reason, 'match');
  assert.ok(['t9', 't8'].includes(best!.item.features.spotifyId));
  const explore = pickNext(pool, (() => { const seq = [0.1, 0.0]; let i = 0; return () => seq[i++]; })());
  assert.equal(explore?.reason, 'explore');
  assert.equal(explore?.item.features.spotifyId, 't4');
  assert.equal(pickNext([]), null);
});

console.log(`\n${passed} Tests bestanden`);

// ---------- "Später nochmal" ----------
import { addLater, dueLater, LATER } from '../src/rhythm';
{
  const t0 = Date.UTC(2026, 10, 22);
  let list = addLater([], 'a', t0, 5);
  assert.equal(list.length, 1);
  assert.equal(dueLater(list, t0, 6), null, 'nicht sofort wieder');
  assert.equal(dueLater(list, t0, 5 + LATER.afterSuggestions)?.id, 'a', 'nach 10 Vorschlägen fällig');
  assert.equal(dueLater(list, t0 + LATER.afterMs, 6)?.id, 'a', 'nach 30 Minuten fällig');
  list = addLater(list, 'a', t0, 20, 1);
  assert.equal(list.length, 1, 'kein Doppeleintrag');
  assert.equal(list[0].offers, 2);
  list = addLater(list, 'a', t0, 30, 3);
  assert.equal(list.length, 0, 'nach dem 3. Mal ohne Bewertung Schluss');
  console.log('✓ Später-Liste: fällig nach Anzahl/Zeit, höchstens 3 Mal');
}
