import { useEffect, useRef, useState } from 'react';
import { formatTime, loadIframeApi, type EmbedController } from './embed';

/**
 * Steuerbarer Spotify-Player. Bleibt dauerhaft dieselbe Instanz, neue Titel werden nur hineingeladen.
 * So darf er nach deinem ersten Klick auf Play auch die folgenden Titel automatisch starten.
 */
export default function Player({ trackId, autoplay, durationMs }: { trackId: string; autoplay: boolean; durationMs?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const ctrl = useRef<EmbedController | null>(null);
  const loadedId = useRef('');
  const wantPlay = useRef(false);
  const started = useRef(false);
  const [mode, setMode] = useState<'loading' | 'api' | 'fallback'>('loading');
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  const [dragging, setDragging] = useState<number | null>(null);

  // Player einmalig erzeugen
  useEffect(() => {
    let cancelled = false;
    loadIframeApi()
      .then((api) => {
        if (cancelled || !holder.current) return;
        // Eigenes Kind-Element, weil die API es durch ein iframe ersetzt (React verwaltet nur den Rahmen)
        const el = document.createElement('div');
        holder.current.appendChild(el);
        loadedId.current = trackId;
        wantPlay.current = autoplay;
        api.createController(el, { uri: `spotify:track:${trackId}`, width: '100%', height: 152 }, (c) => {
          if (cancelled) { c.destroy(); return; }
          ctrl.current = c;
          c.addListener('ready', () => {
            if (wantPlay.current) { wantPlay.current = false; c.play(); }
          });
          c.addListener('playback_update', (e) => {
            const d = e.data;
            setPos(d.position);
            setDur(d.duration);
            setPaused(d.isPaused);
            if (!d.isPaused && d.position > 0) started.current = true;
          });
          setMode('api');
        });
      })
      .catch(() => { if (!cancelled) setMode('fallback'); });
    return () => {
      cancelled = true;
      ctrl.current?.destroy();
      ctrl.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Neuer Titel → in denselben Player laden und ggf. sofort starten
  useEffect(() => {
    const c = ctrl.current;
    if (!c || loadedId.current === trackId) return;
    loadedId.current = trackId;
    started.current = false;
    setPos(0); setDur(0); setDragging(null);
    wantPlay.current = autoplay;
    c.loadUri(`spotify:track:${trackId}`);
    if (!autoplay) return;
    // Falls das "ready"-Ereignis nach dem Laden ausbleibt: nach kurzer Zeit trotzdem starten
    const t = setTimeout(() => {
      if (wantPlay.current && !started.current) { wantPlay.current = false; c.play(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [trackId, autoplay, mode]);

  const seekTo = (ms: number) => {
    const c = ctrl.current;
    if (!c) return;
    const max = dur || durationMs || 0;
    const target = Math.max(0, max ? Math.min(ms, max - 1000) : ms);
    c.seek(target / 1000);
    setPos(target);
  };
  const jump = (deltaSec: number) => seekTo(pos + deltaSec * 1000);

  if (mode === 'fallback') {
    return (
      <div>
        <iframe
          key={trackId}
          title="Spotify-Player"
          src={`https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`}
          height="152"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        />
        <p className="muted small">Einfacher Player aktiv (Steuerung nicht verfügbar).</p>
      </div>
    );
  }

  const shown = dragging ?? pos;
  const isPreview = dur > 0 && dur <= 31_000 && (!durationMs || durationMs > 40_000);
  return (
    <div className="player">
      <div ref={holder} className="embed-holder" />
      {mode === 'api' && (
        <>
          <div className="progress">
            <span>{formatTime(shown)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, dur)}
              step={1000}
              value={Math.min(shown, Math.max(1, dur))}
              onChange={(e) => setDragging(Number(e.target.value))}
              onPointerUp={() => { if (dragging !== null) { seekTo(dragging); setDragging(null); } }}
              onKeyUp={() => { if (dragging !== null) { seekTo(dragging); setDragging(null); } }}
              aria-label="Position im Titel"
            />
            <span>{formatTime(dur)}</span>
          </div>
          <div className="controls">
            <button onClick={() => jump(-15)} aria-label="15 Sekunden zurück">−15 s</button>
            <button className="play" onClick={() => ctrl.current?.togglePlay()} aria-label={paused ? 'Abspielen' : 'Pause'}>
              {paused ? '▶' : '❚❚'}
            </button>
            <button onClick={() => jump(15)} aria-label="15 Sekunden vor">+15 s</button>
            <button onClick={() => jump(60)} aria-label="1 Minute vor">+1 min</button>
          </div>
          {isPreview && (
            <p className="hint subtle small">
              Nur 30-Sekunden-Vorschau. Für ganze Titel melde dich in diesem Browser einmal bei{' '}
              <a href="https://open.spotify.com" target="_blank" rel="noreferrer">open.spotify.com</a> an und lade die App neu.
            </p>
          )}
        </>
      )}
      {mode === 'loading' && <p className="muted small">Player wird geladen …</p>}
    </div>
  );
}
