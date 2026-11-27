import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import * as cn from './connect';
import type { Device, PlayerState } from './connect';
import { formatTime } from './embed';
import Player from './Player';

/**
 * Spielt ganze Titel über Spotify Connect (Premium).
 * Am PC wird dieser Browser selbst zum Abspielgerät, am Handy wird die Spotify-App ferngesteuert.
 * Ohne erreichbares Gerät: 30-Sekunden-Vorschau als Notlösung.
 */
export default function ConnectPlayer({ trackId, autoplay, durationMs, title, artists, image, getUpcoming, onExternalTrack, onEnded, favorite, onToggleFavorite, below, positionRef, startAtMs }: {
  trackId: string; autoplay: boolean; durationMs?: number; title?: string; artists?: string; image?: string;
  /** IDs der nächsten Vorschläge – gehen als Liste an Spotify, damit ⏭ (auch im Sperrbildschirm) weiterführt */
  getUpcoming?: () => string[];
  /** Spotify spielt von selbst einen der nächsten Vorschläge (⏭ gedrückt oder Titel zu Ende) */
  onExternalTrack?: (id: string, endedNaturally: boolean) => void;
  /** Titel ist zu Ende gelaufen und Spotify spielt nicht von selbst den nächsten Vorschlag */
  onEnded?: () => void;
  /** Als Lieblingssong gespeichert? ♥-Knopf speichert, ohne den Titel zu wechseln */
  favorite?: boolean;
  onToggleFavorite?: () => void;
  /** Zeile unter dem Titel (Künstler markieren) */
  below?: ReactNode;
  /** Aktuelle Position (für "Zurück"), wird laufend aktualisiert */
  positionRef?: MutableRefObject<number>;
  /** Beim automatischen Start an dieser Stelle beginnen (z. B. nach "Zurück") */
  startAtMs?: number;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [device, setDevice] = useState<Device | null>(null);
  const [searching, setSearching] = useState(true);
  const [state, setState] = useState<PlayerState | null>(null);
  const [msg, setMsg] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const deviceRef = useRef<Device | null>(null);
  deviceRef.current = device;
  const handledTrack = useRef('');
  // Für die Erkennung, ob wirklich abgespielt wird
  const prevPoll = useRef<PlayerState | null>(null);
  const moving = useRef(false);          // hat Spotify echten Fortschritt gemeldet?
  const startedAt = useRef(0);           // Zeitpunkt unseres letzten Startbefehls
  const alias = useRef(new Map<string, string>()); // Spotify ersetzt manchmal die Titel-ID (Ländervarianten)
  const [stalled, setStalled] = useState(false);
  const trackRef = useRef(trackId);
  trackRef.current = trackId;
  const sentList = useRef<string[]>([]);      // zuletzt an Spotify geschickte Liste
  const known = useRef(new Set<string>());    // alle Titel, die wir schon gezeigt/geschickt haben
  const prevTrack = useRef('');               // Titel vor dem aktuellen Start
  const resent = useRef(false);               // Startbefehl schon einmal wiederholt?
  const externalTo = useRef('');              // Titel, zu dem Spotify selbst gesprungen ist
  const onExternalRef = useRef(onExternalTrack);
  onExternalRef.current = onExternalTrack;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const endedFor = useRef('');
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  known.current.add(trackId);

  const refreshDevices = useCallback(async () => {
    setSearching(true);
    try {
      const list = await cn.getDevices();
      setDevices(list);
      // Ohne eigene Auswahl jedes Mal das beste Gerät nehmen (z. B. sobald der Browser-Player bereit ist)
      const userChosen = cn.savedDeviceId();
      const keep = userChosen && deviceRef.current?.id === userChosen ? list.find((d) => d.id === userChosen) : undefined;
      setDevice(keep ?? cn.chooseDevice(list));
      setMsg('');
    } catch (e) {
      setMsg(cn.explain(e));
    } finally { setSearching(false); }
  }, []);

  const poll = useCallback(async () => {
    let st: PlayerState | null;
    try { st = await cn.getState(); } catch { return; }
    const want = trackRef.current;
    const now = Date.now();
    const sinceStart = now - startedAt.current;
    const dev = deviceRef.current;
    const ours = !!st && !!dev && st.deviceId === dev.id;

    // Ländervariante: Spotify spielt denselben Titel unter anderer ID. Nur direkt nach unserem Start,
    // nur für unbekannte IDs mit passender Länge – sonst würde der alte, noch laufende Titel verwechselt.
    const dur = durationRef.current;
    if (st?.trackId && st.trackId !== want && startedAt.current && sinceStart < 15_000 && ours
      && !known.current.has(st.trackId) && st.positionMs < sinceStart + 2000
      && (!dur || !st.durationMs || Math.abs(st.durationMs - dur) < 4000)) {
      alias.current.set(want, st.trackId);
    }
    const mine = !!st?.trackId && (st.trackId === want || st.trackId === alias.current.get(want));

    const prev = prevPoll.current;
    // Titel zu Ende? (steht am Ende still, steht wieder bei 0 oder Spotify spielt danach etwas Fremdes)
    const prevMine = !!prev?.trackId && (prev.trackId === want || prev.trackId === alias.current.get(want));
    const nearEnd = (p: PlayerState | null) => !!p && p.durationMs > 0 && p.positionMs >= p.durationMs - 8000;
    const endedNow =
      (mine && !st!.isPlaying && st!.durationMs > 0 && st!.positionMs >= st!.durationMs - 4000)
      || (mine && !st!.isPlaying && prevMine && prev!.isPlaying && nearEnd(prev))
      || (!mine && prevMine && prev!.isPlaying && nearEnd(prev) && (!st?.trackId || sentList.current.indexOf(st.trackId) < 0));
    if (endedNow && endedFor.current !== want && !startedAt.current) {
      endedFor.current = want;
      prevPoll.current = st;
      setState(st);
      onEndedRef.current?.();
      return;
    }
    if (st && prev && st.trackId === prev.trackId && st.isPlaying) {
      moving.current = st.positionMs > prev.positionMs + 300;
    } else if (st && !st.isPlaying) {
      moving.current = false;
    } else if (st && st.isPlaying && st.positionMs > 1500) {
      moving.current = true;
    }
    prevPoll.current = st;
    setState(st);

    if (st?.trackId && ours && !mine) {
      const idx = sentList.current.indexOf(st.trackId);
      const wantIdx = sentList.current.indexOf(want);
      // Spotify ist in unserer Liste weitergesprungen (⏭ oder Titelende) → App folgt
      if (idx > 0 && idx > wantIdx && (!startedAt.current || sinceStart > 3000)) {
        externalTo.current = st.trackId;
        // War der vorige Titel fast zu Ende? Dann lief er aus (unbewertet), sonst wurde mit ⏭ übersprungen
        const endedNaturally = !!prev && prev.trackId === want && prev.durationMs > 0 && prev.positionMs >= prev.durationMs - 10_000;
        onExternalRef.current?.(st.trackId, endedNaturally);
        return;
      }
      // Nach unserem Start läuft noch/wieder der alte oder ein fremder Titel → Startbefehl einmal wiederholen
      if (startedAt.current && sinceStart > 2500 && sinceStart < 10_000 && !resent.current && idx < 0) {
        resent.current = true;
        const list = sentList.current.length ? sentList.current : [want];
        void cn.playTrack(dev!.id, list[0], 0, list.slice(1)).catch(() => undefined);
        for (const ms of [1500, 3500]) setTimeout(() => void pollRef.current(), ms);
        return;
      }
    }

    // Hängt der Start? (Gerät meldet keinen Fortschritt)
    if (startedAt.current && sinceStart > 6500 && sinceStart < 60_000) {
      const ok = mine && st!.isPlaying && (moving.current || st!.positionMs > 1500);
      setStalled(!ok && (!st?.trackId || mine || st.trackId === prevTrack.current || !st.isPlaying));
      if (ok) startedAt.current = 0; // läuft – Prüfung beenden
    }
  }, []);
  const pollRef = useRef(poll);
  pollRef.current = poll;

  // Start: Geräte suchen, am PC zusätzlich den Browser als Gerät anmelden
  useEffect(() => {
    void refreshDevices();
    cn.startBrowserDevice()
      .then(() => setTimeout(() => void refreshDevices(), 800))
      .catch(() => undefined);
  }, [refreshDevices]);

  // Status regelmäßig abfragen (sparsam), Position dazwischen hochzählen
  useEffect(() => {
    // Auch im Hintergrund weiter nachsehen (seltener), damit die App am Titelende selbst weiterschaltet
    let n = 0;
    const p = setInterval(() => { n++; if (document.visibilityState === 'visible' || n % 3 === 0) void poll(); }, 4000);
    const t = setInterval(() => setTick((x) => x + 1), 500);
    // Zurück in der App (z. B. nach ⏭ im Sperrbildschirm): sofort nachsehen, was läuft
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(p); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [poll]);

  const cmdSeq = useRef(0);
  const run = async (fn: () => Promise<void>, optimistic?: Partial<PlayerState>, retry = true, mustSucceed = false) => {
    const d = deviceRef.current;
    if (!d) return;
    const seq = ++cmdSeq.current;
    setMsg('');
    if (optimistic) setState((s) => ({ positionMs: 0, durationMs: durationMs ?? 0, isPlaying: true, ...s, ...optimistic, at: Date.now() }));
    const pollSoon = () => { for (const ms of [1200, 3000, 5500, 7500]) setTimeout(() => void poll(), ms); };
    try {
      await fn();
      // Nach einem Befehl öfter nachsehen, damit ein hängender Start schnell auffällt
      pollSoon();
    } catch (e) {
      if (cn.isRestriction(e)) {
        // Befehl passte nicht zum tatsächlichen Zustand: echten Stand holen, einmal still wiederholen
        await poll();
        // Nur wiederholen, wenn inzwischen kein neuerer Befehl (z. B. Vorspulen) kam
        if (retry) {
          await new Promise((r) => setTimeout(r, 700));
          if (seq !== cmdSeq.current) return;
          try { await fn(); pollSoon(); return; } catch (e2) {
            if (cn.isRestriction(e2) && !mustSucceed) { void poll(); return; } // Zustand passt schon – nichts melden
            setMsg(cn.explain(e2)); return;
          }
        }
        return;
      }
      setMsg(cn.explain(e));
      void poll();
    }
  };

  const start = (positionMs = 0, d = deviceRef.current) => {
    if (!d) return;
    const cur = prevPoll.current?.trackId ?? state?.trackId ?? '';
    if (cur && cur !== trackId) prevTrack.current = cur;
    startedAt.current = Date.now();
    resent.current = false;
    moving.current = false;
    prevPoll.current = null;
    setStalled(false);
    const next = getUpcoming?.() ?? [];
    sentList.current = [trackId, ...next.filter((id) => id !== trackId)].slice(0, 30);
    sentList.current.forEach((id) => known.current.add(id));
    void run(() => cn.playTrack(d.id, trackId, positionMs, sentList.current.slice(1)), {
      trackId, positionMs, durationMs: durationMs ?? 0, isPlaying: true, deviceId: d.id,
    }, true, true);
  };

  // Neuer Vorschlag → automatisch abspielen (nach Ja/Nein/Später)
  useEffect(() => {
    if (handledTrack.current === trackId || !device) return;
    handledTrack.current = trackId;
    setDragging(null);
    if (externalTo.current === trackId) {
      // Spotify spielt diesen Titel schon (⏭ / Titelende) – nicht neu starten
      externalTo.current = '';
      startedAt.current = 0;
      setStalled(false);
      return;
    }
    if (autoplay) start(startAtMs ?? 0);
  }, [trackId, autoplay, device]); // eslint-disable-line react-hooks/exhaustive-deps

  const isThis = !!state?.trackId && (state.trackId === trackId || state.trackId === alias.current.get(trackId));
  const otherPlaying = !!state?.isPlaying && !!state.trackId && !isThis && state.deviceId === device?.id && !stalled;
  const dur = isThis && state?.durationMs ? state.durationMs : durationMs ?? 0;
  // Nur hochzählen, wenn Spotify echten Fortschritt bestätigt hat – sonst springt die Anzeige zurück
  const advancing = !!state?.isPlaying && moving.current;
  const livePos = isThis && state ? Math.min(dur || Infinity, state.positionMs + (advancing ? Date.now() - state.at : 0)) : 0;
  const shown = dragging ?? livePos;
  if (positionRef && isThis) positionRef.current = livePos;
  const playing = isThis && !!state?.isPlaying;

  const seekTo = (ms: number) => {
    const target = Math.max(0, dur ? Math.min(ms, dur - 1500) : ms);
    const d = deviceRef.current;
    if (!d) return;
    if (!isThis) { start(target); return; }
    void run(() => cn.seek(d.id, target), { positionMs: target });
  };
  const toggle = async () => {
    cn.unlockBrowserAudio();
    const d = deviceRef.current;
    if (!d) return;
    if (!isThis) { start(0); return; }
    // Vor Pause/Weiter den echten Zustand prüfen, damit kein unpassender Befehl rausgeht
    let fresh: PlayerState | null = null;
    try { fresh = await cn.getState(); } catch { /* dann mit bekanntem Stand */ }
    const nowPlaying = fresh ? fresh.isPlaying && fresh.deviceId === d.id : playing;
    const pos = fresh ? fresh.positionMs : livePos;
    if (fresh && !(fresh.trackId === trackId || fresh.trackId === alias.current.get(trackId))) { start(0); return; }
    if (nowPlaying) void run(() => cn.pause(d.id), { isPlaying: false, positionMs: pos });
    else void run(() => cn.resume(d.id), { isPlaying: true, positionMs: pos });
  };
  const changeDevice = (id: string) => {
    const d = devices.find((x) => x.id === id) ?? null;
    setDevice(d);
    if (d) cn.saveDeviceId(d.id);
    if (d && playing) start(livePos, d); // Wiedergabe mitnehmen
  };

  const label = (d: Device) => `${d.isBrowser ? '💻 ' : d.type.toLowerCase() === 'smartphone' ? '📱 ' : '🔊 '}${d.name}`;

  return (
    <div className="player">
      <div className="devices">
        <span className="muted small">Abspielen auf</span>
        <select value={device?.id ?? ''} onChange={(e) => changeDevice(e.target.value)} disabled={!devices.length}>
          {!devices.length && <option value="">{searching ? 'Suche Geräte …' : 'kein Gerät gefunden'}</option>}
          {devices.map((d) => <option key={d.id} value={d.id}>{label(d)}</option>)}
        </select>
        <button className="small ghost" onClick={() => void refreshDevices()} aria-label="Geräte neu suchen" disabled={searching}>⟳</button>
      </div>

      {device ? (
        <>
          <div className="nowplaying">
            {image ? <img src={image} alt="" /> : <div className="noimg big" />}
            <div className="meta">
              <div className="title">{title || 'Titel wird geladen …'}</div>
              <div className="artist">{artists}</div>
            </div>
            {onToggleFavorite && (
              <button
                className={`heart ${favorite ? 'on' : ''}`}
                onClick={onToggleFavorite}
                aria-label={favorite ? 'Aus Lieblingssongs entfernen' : 'Als Lieblingssong speichern (spielt weiter)'}
                title={favorite ? 'Gespeichert – nochmal tippen zum Entfernen' : 'Als Favorit speichern, Lied spielt weiter'}
              >{favorite ? '♥' : '♡'}</button>
            )}
          </div>
          {below}
          <div className="progress">
            <span>{formatTime(shown)}</span>
            <input
              type="range" min={0} max={Math.max(1, dur)} step={1000}
              value={Math.min(shown, Math.max(1, dur))}
              onChange={(e) => setDragging(Number(e.target.value))}
              onPointerUp={() => { if (dragging !== null) { seekTo(dragging); setDragging(null); } }}
              onKeyUp={() => { if (dragging !== null) { seekTo(dragging); setDragging(null); } }}
              aria-label="Position im Titel"
            />
            <span>{formatTime(dur)}</span>
          </div>
          <div className="controls">
            <button onClick={() => seekTo(shown - 15_000)} aria-label="15 Sekunden zurück">−15 s</button>
            <button className="play" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Abspielen'}>{playing ? '❚❚' : '▶'}</button>
            <button onClick={() => seekTo(shown + 15_000)} aria-label="15 Sekunden vor">+15 s</button>
            <button onClick={() => seekTo(shown + 60_000)} aria-label="1 Minute vor">+1 min</button>
          </div>
        </>
      ) : (
        !searching && (
          <>
            <div className="hint subtle small">
              Kein Spotify-Gerät gefunden. Öffne Spotify auf deinem Handy oder PC, spiel kurz irgendeinen Titel an
              und tippe dann auf ⟳. Bis dahin läuft nur die 30-Sekunden-Vorschau.{' '}
              <a href="https://open.spotify.com" target="_blank" rel="noreferrer">Spotify öffnen</a>
            </div>
            <Player trackId={trackId} autoplay={autoplay} durationMs={durationMs} />
          </>
        )
      )}
      {/* Hinweis-Platz mit fester Höhe: Meldungen erscheinen hier, ohne dass etwas springt */}
      <div className="notice-slot">
        {device && stalled ? (
          <div className="notice stall">
            <span>
              {device.type.toLowerCase() === 'smartphone'
                ? <><b>Spotify am Handy startet nicht.</b> Spotify kurz öffnen, zurückwechseln, „Nochmal“.</>
                : <><b>„{device.name}“ spielt nicht ab.</b> Spotify dort kurz öffnen oder anderes Gerät wählen.</>}
            </span>
            <span className="notice-actions">
              <a className="btnlink" href={`spotify:track:${trackId}`}>Spotify öffnen</a>
              <button className="small primary" onClick={() => { cn.unlockBrowserAudio(); void refreshDevices(); start(0); }}>Nochmal</button>
            </span>
          </div>
        ) : device && otherPlaying ? (
          <div className="notice other">
            <span>Spotify spielt gerade: <b>{state?.trackName || 'anderen Titel'}</b>{state?.trackArtists ? ` – ${state.trackArtists}` : ''}</span>
            <span className="notice-actions">
              <button className="small primary" onClick={() => { cn.unlockBrowserAudio(); start(0); }}>Vorschlag spielen</button>
            </span>
          </div>
        ) : msg ? (
          <div className="notice"><span className="error">{msg}</span></div>
        ) : device && playing && !advancing ? (
          <div className="notice"><span className="muted">Startet auf „{device.name}“ …</span></div>
        ) : null}
      </div>
    </div>
  );
}
