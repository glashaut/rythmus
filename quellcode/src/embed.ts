// Spotify Embed iFrame API: steuerbarer Player (laden, abspielen, springen).
// Spielt ganze Titel, wenn man im selben Browser bei open.spotify.com angemeldet ist, sonst 30-s-Vorschauen.

export interface PlaybackUpdate { position: number; duration: number; isPaused: boolean; isBuffering?: boolean }

export interface EmbedController {
  loadUri(uri: string): void;
  play(): void;
  pause(): void;
  resume(): void;
  togglePlay(): void;
  seek(seconds: number): void;
  destroy(): void;
  addListener(event: 'ready', cb: () => void): void;
  addListener(event: 'playback_update', cb: (e: { data: PlaybackUpdate }) => void): void;
}

export interface IFrameAPI {
  createController(
    element: HTMLElement,
    options: { uri: string; width?: string | number; height?: string | number },
    callback: (controller: EmbedController) => void,
  ): void;
}

declare global {
  interface Window { onSpotifyIframeApiReady?: (api: IFrameAPI) => void }
}

const SCRIPT = 'https://open.spotify.com/embed/iframe-api/v1';
let apiPromise: Promise<IFrameAPI> | null = null;

/** Lädt das Player-Skript einmalig. Schlägt nach 10 s fehl, dann nutzt die App den einfachen Player. */
export function loadIframeApi(): Promise<IFrameAPI> {
  apiPromise ??= new Promise<IFrameAPI>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Player-Skript antwortet nicht')), 10_000);
    // Muss gesetzt sein, bevor das Skript lädt
    window.onSpotifyIframeApiReady = (api) => { clearTimeout(timer); resolve(api); };
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onerror = () => { clearTimeout(timer); reject(new Error('Player-Skript nicht geladen')); };
    document.body.appendChild(s);
  }).catch((e: unknown) => { apiPromise = null; throw e; });
  return apiPromise;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
