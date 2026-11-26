import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as sp from './spotify';
import { Engine, type Suggestion, type TrackInfo } from './engine';
import type { Features } from './rhythm';
import ConnectPlayer from './ConnectPlayer';
import { unlockBrowserAudio } from './connect';

type Phase = 'setup' | 'login' | 'loading' | 'ready' | 'error';
type Tab = 'discover' | 'favorites' | 'search';

export default function App() {
  const [phase, setPhase] = useState<Phase>(() => (!sp.getClientId() ? 'setup' : 'loading'));
  const [error, setError] = useState('');
  const engineRef = useRef<Engine | null>(null);
  const [tab, setTab] = useState<Tab>('discover');
  const [version, setVersion] = useState(0); // erzwingt Neuzeichnen nach Änderungen
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const boot = useCallback(async () => {
    setPhase('loading');
    try {
      await sp.handleRedirect();
      if (sp.isLoggedIn() && !sp.hasRequiredScopes()) {
        sp.logout();
        setError('Neue Funktionen (Lieblingssongs, ganze Titel abspielen) brauchen zusätzliche Rechte. Bitte einmal neu anmelden.');
      }
      if (!sp.isLoggedIn()) { setPhase('login'); return; }
      const engine = new Engine();
      engine.onProgress = bump;
      engineRef.current = engine;
      await engine.init();
      setPhase('ready');
    } catch (e) {
      engineRef.current = null;
      setError((e as Error).message);
      setPhase(sp.isLoggedIn() ? 'error' : 'login');
    }
  }, [bump]);

  // Nur einmal starten (React StrictMode ruft Effekte in der Entwicklung doppelt auf)
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (phase === 'loading') void boot();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'setup') return <Setup onDone={() => setPhase('login')} />;
  if (phase === 'login') {
    return (
      <Shell>
        <div className="panel center">
          <h2>Anmelden</h2>
          <p className="muted">Die App braucht Zugriff auf deine Playlists, um Favoriten und Ablehnungen zu speichern.</p>
          {error && <p className="error">{error}</p>}
          <button className="primary big" onClick={() => void sp.startLogin().catch((e: Error) => setError(e.message))}>
            Mit Spotify anmelden
          </button>
          <button className="link" onClick={() => setPhase('setup')}>Client-ID ändern</button>
        </div>
      </Shell>
    );
  }
  if (phase === 'loading') {
    const p = engineRef.current?.progress;
    return (
      <Shell>
        <div className="panel center">
          <Spinner />
          <p className="muted">{p?.phase ? `${p.phase} … ${p.total ? `${p.done} / ${p.total}` : ''}` : 'Verbinde mit Spotify …'}</p>
        </div>
      </Shell>
    );
  }
  if (phase === 'error' || !engineRef.current) {
    return (
      <Shell>
        <div className="panel center">
          <p className="error">{error || 'Unbekannter Fehler'}</p>
          <button className="primary" onClick={() => void boot()}>Nochmal versuchen</button>
          <button className="link" onClick={() => { sp.logout(); setPhase('login'); }}>Abmelden</button>
        </div>
      </Shell>
    );
  }

  const engine = engineRef.current;
  return (
    <Shell
      right={<button className="link small" onClick={() => { sp.logout(); setPhase('login'); }}>Abmelden</button>}
    >
      <nav className="tabs">
        <button className={tab === 'discover' ? 'on' : ''} onClick={() => setTab('discover')}>Entdecken</button>
        <button className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>Favoriten ({engine.likes.size})</button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Suchen</button>
      </nav>
      {/* Entdecken bleibt montiert, damit der aktuelle Vorschlag beim Tab-Wechsel erhalten bleibt */}
      <div hidden={tab !== 'discover'}><Discover engine={engine} onChange={bump} goSearch={() => setTab('search')} /></div>
      {tab === 'favorites' && <Favorites engine={engine} onChange={bump} version={version} />}
      {tab === 'search' && <Search engine={engine} onChange={bump} />}
    </Shell>
  );
}

function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="app">
      <header>
        <h1><span className="logo">◉</span> Rhythmus</h1>
        {right}
      </header>
      <main>{children}</main>
    </div>
  );
}

function Spinner() { return <span className="spinner" aria-label="lädt" />; }

// ---------------- Einrichtung ----------------
function Setup({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState(sp.getClientId() ?? '');
  const [copied, setCopied] = useState(false);
  const uri = sp.redirectUri();
  const valid = /^[0-9a-f]{32}$/i.test(id.trim());
  return (
    <Shell>
      <div className="panel">
        <h2>Einrichtung (einmalig)</h2>
        <ol className="steps">
          <li>Öffne <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">developer.spotify.com/dashboard</a> und melde dich mit deinem Spotify-Konto an (Premium nötig).</li>
          <li>Klicke auf <b>Create app</b>. Name und Beschreibung sind frei wählbar, bei den APIs <b>Web API</b> ankreuzen.</li>
          <li>Trage als <b>Redirect URI</b> genau diese Adresse ein:
            <div className="copy">
              <code>{uri}</code>
              <button className="small" onClick={() => { void navigator.clipboard?.writeText(uri); setCopied(true); }}>{copied ? 'Kopiert' : 'Kopieren'}</button>
            </div>
          </li>
          <li>Speichern, dann die <b>Client ID</b> der App hier einfügen:</li>
        </ol>
        <input
          className="input"
          placeholder="Client ID (32 Zeichen)"
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="primary big" disabled={!valid} onClick={() => { sp.setClientId(id); onDone(); }}>Weiter</button>
        <p className="muted small">Die Client-ID bleibt nur in diesem Browser gespeichert. Am Handy musst du sie einmal erneut eintragen, deine Favoriten sind dann trotzdem da.</p>
      </div>
    </Shell>
  );
}

// ---------------- Entdecken ----------------
function Discover({ engine, onChange, goSearch }: { engine: Engine; onChange: () => void; goSearch: () => void }) {
  const [current, setCurrent] = useState<Suggestion | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [hearted, setHearted] = useState('');
  const [note, setNote] = useState('');
  const [artistBusy, setArtistBusy] = useState('');
  const started = useRef(false);

  const load = useCallback(async (play: boolean) => {
    setLoading(true); setMsg(''); setHearted('');
    try {
      const s = await engine.next();
      setAutoplay(play);
      setCurrent(s);
      if (!s) setMsg('Gerade keine passenden Kandidaten gefunden. Probier es gleich nochmal.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setLoading(false); }
  }, [engine]);

  useEffect(() => { if (!started.current) { started.current = true; void load(false); } }, [load]);

  // Spotify ist selbst weitergesprungen (⏭ im Sperrbildschirm oder Titelende) → diesen Vorschlag anzeigen
  const currentRef = useRef<Suggestion | null>(null);
  currentRef.current = current;
  const onExternalTrack = useCallback(async (id: string) => {
    // Der bisher angezeigte Titel wurde nicht bewertet → später nochmal
    if (currentRef.current) engine.markUnrated(currentRef.current.id);
    const s = await engine.jumpTo(id);
    if (s) { setAutoplay(false); setCurrent(s); onChange(); }
  }, [engine, onChange]);

  // ♥ in Spotify (z. B. im Sperrbildschirm) zählt als Ja
  const recent = useRef<string[]>([]);
  useEffect(() => {
    if (current && !recent.current.includes(current.id)) recent.current = [current.id, ...recent.current].slice(0, 25);
  }, [current]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !recent.current.length) return;
      engine.syncExternalLikes(recent.current).then((ids) => {
        if (!ids.length) return;
        onChange();
        const info = engine.info.get(ids[0]);
        setHearted(info?.title ? `„${info.title}“` : 'Ein Titel');
      }).catch(() => undefined);
    };
    const t = setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [engine, onChange]);

  const rate = (yes: boolean) => {
    if (!current || loading) return;
    setNote('');
    unlockBrowserAudio();
    // Lernstand sofort anpassen, Speichern läuft im Hintergrund, nächster Titel startet direkt
    engine.rate(current, yes).catch((e: Error) => setMsg(`Speichern fehlgeschlagen: ${e.message}`));
    onChange();
    void load(true);
  };

  const noFavs = engine.likes.size === 0;
  const favorite = !!current && engine.likes.has(current.id);
  const toggleFavorite = () => {
    if (!current) return;
    // ♥: als Lieblingssong speichern, Lied läuft weiter (kein Titelwechsel)
    const p = favorite ? engine.unlike(current) : engine.rate(current, true);
    onChange();
    p.then(onChange).catch((e: Error) => setMsg(`Speichern fehlgeschlagen: ${e.message}`));
  };
  // Eine Zeile mit fester Höhe für Hinweise – wichtigste Meldung zuerst
  const toggleArtist = async (name: string) => {
    if (artistBusy) return;
    if (engine.isArtistLiked(name)) {
      engine.unlikeArtist(name);
      setNote(`☆ ${name} nicht mehr markiert – offene Titel entfernt.`);
      onChange();
      return;
    }
    setArtistBusy(name);
    setNote(`Suche Titel von und mit ${name} …`);
    try {
      const n = await engine.likeArtist(name);
      setNote(n ? `★ ${name}: ${n} Titel von und mit ${name} kommen jetzt in den Fluss (jeder 2. Vorschlag).`
        : `★ ${name} markiert – aber gerade keine neuen Titel gefunden.`);
    } catch (e) {
      setNote('');
      setMsg(`Künstler-Suche fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setArtistBusy('');
      onChange();
    }
  };
  const artistRow = current ? (
    <div className="artist-row">
      {(current.artistList?.length ? current.artistList : current.artists ? [current.artists] : []).slice(0, 3).map((a) => {
        const on = engine.isArtistLiked(a);
        return (
          <button key={a} className={`chip ${on ? 'on' : ''}`} disabled={artistBusy === a}
            title={on ? 'Markierung aufheben' : '20 Titel von/mit diesem Künstler einmischen'}
            onClick={() => void toggleArtist(a)}>
            {artistBusy === a ? '…' : on ? '★' : '☆'} {a}
          </button>
        );
      })}
    </div>
  ) : null;
  const topNotice = msg ? <span className="error">{msg}</span>
    : note ? <>{note}</>
    : hearted ? <>♥ {hearted} in Spotify gespeichert – zählt als „Ja“.</>
    : engine.progress.phase && engine.progress.total > 0 ? <>{engine.progress.phase}: {engine.progress.done} / {engine.progress.total} – Vorschläge werden laufend genauer.</>
    : noFavs ? <>Noch keine Favoriten – erst mal reiner Zufall. <button className="link inline" onClick={goSearch}>Lieblingstitel suchen</button></>
    : null;
  return (
    <section>
      <div className="top-slot">{topNotice}</div>
      {loading && !current && <div className="panel center"><Spinner /><p className="muted">Suche Titel mit passendem Rhythmus …</p></div>}
      {current && (
        <div className={`card ${loading ? 'dim' : ''}`}>
          <div className={`badge ${current.reason}`}>
            {current.reason === 'artist' && current.special ? <>⭐ Künstler-Spezial: <b>{current.special.artist}</b> ({current.special.n}/{current.special.total})</>
              : current.reason === 'later' ? `🔁 Nochmal zur Auswahl – noch nicht bewertet${current.offers && current.offers > 1 ? ` (${current.offers}. Mal)` : ''}`
              : current.reason === 'explore' ? '🎲 Ausreißer – mal was anderes'
              : current.nearest ? <>Ähnlicher Rhythmus wie <b>{current.nearest}</b></> : '🎲 Zufallsfund'}
          </div>
          <ConnectPlayer
            trackId={current.id} autoplay={autoplay} durationMs={current.durationMs}
            title={current.title} artists={current.artists} image={current.image}
            getUpcoming={() => engine.upcomingIds(25)} onExternalTrack={(id) => void onExternalTrack(id)}
            onEnded={() => { engine.markUnrated(current.id); void load(true); }}
            favorite={favorite} onToggleFavorite={toggleFavorite}
            below={artistRow}
          />
          <FeatureBars f={current.features} />
          <a className="link small" href={`https://open.spotify.com/track/${current.id}`} target="_blank" rel="noreferrer">In Spotify öffnen ↗</a>
          <div className="actions">
            <button className="no" disabled={loading} onClick={() => rate(false)}>👎 Nein</button>
            <button className="skip" disabled={loading} onClick={() => { unlockBrowserAudio(); engine.markUnrated(current.id); void load(true); }}>Später</button>
            <button className="yes" disabled={loading} onClick={() => rate(true)}>👍 Ja</button>
          </div>
        </div>
      )}
      {!current && !loading && <button className="primary" onClick={() => void load(true)}>Neuen Vorschlag holen</button>}
    </section>
  );
}

function FeatureBars({ f }: { f: Features }) {
  if (!f.tempo) return <div className="features"><div className="bpm muted">Keine Rhythmusdaten für diesen Titel</div></div>;
  const bar = (label: string, v: number) => (
    <div className="bar" key={label}>
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%` }} /></div>
    </div>
  );
  return (
    <div className="features">
      <div className="bpm"><b>{Math.round(f.tempo)}</b> BPM</div>
      {bar('Tanzbarkeit', f.danceability)}
      {bar('Energie', f.energy)}
      {bar('Akustisch', f.acousticness)}
      {bar('Stimmung', f.valence)}
    </div>
  );
}

// ---------------- Favoriten ----------------
function Favorites({ engine, onChange, version }: { engine: Engine; onChange: () => void; version: number }) {
  const [busyId, setBusyId] = useState('');
  const [limit, setLimit] = useState(100);
  const items = [...engine.likes.values()].sort((a, b) => b.at - a.at);
  void version;
  if (!items.length) return <p className="muted center">Noch keine Lieblingssongs. Sag bei Vorschlägen „Ja“ oder füge Titel über die Suche hinzu.</p>;
  const analyzed = items.filter(({ info }) => engine.features.has(info.id)).length;
  return (
    <section>
      {engine.artists.length > 0 && (
        <div className="artist-list">
          <div className="muted small">Markierte Künstler (ihre Titel werden in den Fluss gemischt):</div>
          {engine.artists.map((a) => (
            <span key={a.name} className="chip on">
              ★ {a.name} <span className="muted">· {engine.artistPending(a.name)} offen</span>
              <button className="x" aria-label={`${a.name} nicht mehr markieren`} onClick={() => { engine.unlikeArtist(a.name); onChange(); }}>×</button>
            </span>
          ))}
        </div>
      )}
      <p className="muted small">
        Deine Spotify-Lieblingssongs. Alle fließen ins Lernen ein, „Ja“ landet automatisch hier.
        {' '}Rhythmusdaten vorhanden für {analyzed} von {items.length}.
      </p>
      <ul className="list">
        {items.slice(0, limit).map(({ info }) => {
          const f = engine.features.get(info.id);
          return (
            <li key={info.id}>
              <TrackRow info={info} sub={f ? `${Math.round(f.tempo)} BPM · Tanzbarkeit ${Math.round(f.danceability * 100)} %` : 'keine Rhythmusdaten'} />
              <button className="small ghost" disabled={busyId === info.id} onClick={async () => {
                if (!window.confirm(`„${info.title}“ aus deinen Spotify-Lieblingssongs entfernen?`)) return;
                setBusyId(info.id);
                try { await engine.unlike(info); onChange(); } finally { setBusyId(''); }
              }}>Entfernen</button>
            </li>
          );
        })}
      </ul>
      {items.length > limit && <button className="ghost wide" onClick={() => setLimit(limit + 200)}>Mehr anzeigen ({items.length - limit} weitere)</button>}
    </section>
  );
}

function TrackRow({ info, sub }: { info: TrackInfo; sub?: string }) {
  return (
    <div className="row">
      {info.image ? <img src={info.image} alt="" width={44} height={44} /> : <div className="noimg" />}
      <div className="meta">
        <div className="title">{info.title}</div>
        <div className="artist">{info.artists}{sub ? ` · ${sub}` : ''}</div>
      </div>
    </div>
  );
}

// ---------------- Suche ----------------
function Search({ engine, onChange }: { engine: Engine; onChange: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TrackInfo[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState('');

  const run = async (fresh: boolean) => {
    if (!q.trim()) return;
    setLoading(true); setMsg('');
    try {
      const off = fresh ? 0 : offset + 10;
      const r = await engine.search(q.trim(), off);
      setResults(fresh ? r : [...results, ...r]);
      setOffset(off);
      if (fresh && !r.length) setMsg('Nichts gefunden.');
    } catch (e) { setMsg((e as Error).message); } finally { setLoading(false); }
  };

  return (
    <section>
      <form className="searchbar" onSubmit={(e) => { e.preventDefault(); void run(true); }}>
        <input className="input" placeholder="Titel oder Interpret" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" disabled={loading}>Suchen</button>
      </form>
      {msg && <p className="muted">{msg}</p>}
      <ul className="list">
        {results.map((info) => {
          const liked = engine.likes.has(info.id);
          return (
            <li key={info.id}>
              <TrackRow info={info} />
              <button className={`small ${liked ? 'ghost' : 'yes'}`} disabled={liked || busyId === info.id} onClick={async () => {
                setBusyId(info.id);
                try { await engine.like(info); onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusyId(''); }
              }}>{liked ? '✓ Favorit' : '+ Favorit'}</button>
            </li>
          );
        })}
      </ul>
      {results.length > 0 && results.length % 10 === 0 && (
        <button className="ghost wide" disabled={loading} onClick={() => void run(false)}>Mehr laden</button>
      )}
    </section>
  );
}
