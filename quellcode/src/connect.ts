// Ganze Titel abspielen (Premium): Fernsteuerung über Spotify Connect.
// Spielt auf jedem Spotify-Gerät: Spotify-App am Handy, Spotify-Programm am PC,
// open.spotify.com im Browser, Lautsprecher – oder direkt in diesem Browser (Web Playback SDK, nur PC).
import { api, getAccessToken } from './spotify';

export interface Device { id: string; name: string; type: string; isActive: boolean; isBrowser?: boolean }
export interface PlayerState { deviceId?: string; trackId?: string; trackName?: string; trackArtists?: string; positionMs: number; durationMs: number; isPlaying: boolean; at: number }

const K_DEVICE = 'rz.device';
export const savedDeviceId = (): string | null => { try { return localStorage.getItem(K_DEVICE); } catch { return null; } };
export const saveDeviceId = (id: string): void => { try { localStorage.setItem(K_DEVICE, id); } catch { /* egal */ } };

let browserDeviceId: string | null = null;

export async function getDevices(): Promise<Device[]> {
  const r = await api<{ devices?: { id: string | null; name: string; type: string; is_active: boolean; is_restricted?: boolean }[] } | null>('/me/player/devices');
  return (r?.devices ?? [])
    .filter((d) => d.id && !d.is_restricted)
    .map((d) => ({ id: d.id as string, name: d.name, type: d.type, isActive: d.is_active, isBrowser: d.id === browserDeviceId }));
}

/** Bestes Gerät: zuletzt gewähltes → dieser Browser → gerade aktives → Smartphone → erstes. */
export function chooseDevice(devices: Device[]): Device | null {
  const saved = savedDeviceId();
  return devices.find((d) => d.id === saved)
    ?? devices.find((d) => d.isBrowser)
    ?? devices.find((d) => d.isActive)
    ?? devices.find((d) => d.type.toLowerCase() === 'smartphone')
    ?? devices[0]
    ?? null;
}

export async function getState(): Promise<PlayerState | null> {
  const r = await api<{
    device?: { id?: string }; is_playing?: boolean; progress_ms?: number | null;
    item?: { id?: string; duration_ms?: number; name?: string; artists?: { name: string }[]; linked_from?: { id?: string } | null } | null;
  } | null>('/me/player');
  if (!r) return null;
  return {
    deviceId: r.device?.id,
    // Spotify spielt oft eine Ländervariante mit anderer ID; linked_from enthält die ID, die wir geschickt haben
    trackId: r.item?.linked_from?.id ?? r.item?.id,
    trackName: r.item?.name,
    trackArtists: (r.item?.artists ?? []).map((a) => a.name).join(', '),
    positionMs: r.progress_ms ?? 0,
    durationMs: r.item?.duration_ms ?? 0,
    isPlaying: !!r.is_playing,
    at: Date.now(),
  };
}

const dev = (id: string) => `device_id=${encodeURIComponent(id)}`;

/**
 * Spielt trackId und hängt die nächsten Vorschläge als Liste an.
 * So springt ⏭ in Spotify (auch im Sperrbildschirm) zum nächsten Vorschlag, und am Titelende geht es weiter.
 */
export async function playTrack(deviceId: string, trackId: string, positionMs = 0, next: string[] = []): Promise<void> {
  const ids = [trackId, ...next.filter((id) => id !== trackId)].slice(0, 30);
  await api(`/me/player/play?${dev(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: ids.map((id) => `spotify:track:${id}`), position_ms: Math.max(0, Math.round(positionMs)) }),
  });
}
export async function resume(deviceId: string): Promise<void> { await api(`/me/player/play?${dev(deviceId)}`, { method: 'PUT' }); }
export async function pause(deviceId: string): Promise<void> { await api(`/me/player/pause?${dev(deviceId)}`, { method: 'PUT' }); }
export async function seek(deviceId: string, positionMs: number): Promise<void> {
  await api(`/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}&${dev(deviceId)}`, { method: 'PUT' });
}

/**
 * "Restriction violated": Spotify lehnt einen Befehl ab, der zum aktuellen Zustand nicht passt
 * (z. B. Weiterspielen, obwohl schon läuft; Pause, obwohl schon pausiert). Harmlos.
 */
export function isRestriction(e: unknown): boolean {
  const m = (e as Error)?.message ?? '';
  return /403/.test(m) && !/premium/i.test(m);
}

/** Verständliche Meldung für typische Connect-Fehler. */
export function explain(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/404/.test(m)) return 'Das Gerät ist nicht mehr erreichbar. Öffne Spotify dort kurz und tippe auf ⟳.';
  if (/403/.test(m) && /premium/i.test(m)) return 'Spotify meldet: Für die Steuerung ist Premium nötig. Bitte mit dem Premium-Konto anmelden.';
  if (/403/.test(m)) return 'Spotify hat den Befehl gerade abgelehnt. Tippe bitte nochmal.';
  return m;
}

// ---------- Dieser Browser als Abspielgerät (Web Playback SDK) ----------

interface SdkPlayer {
  connect(): Promise<boolean>;
  activateElement?(): Promise<void>;
  addListener(ev: string, cb: (e: { device_id?: string; message?: string }) => void): void;
}
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
  }
}

let sdkPromise: Promise<string> | null = null;
let sdkPlayer: SdkPlayer | null = null;

export const isMobile = (): boolean => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/** Startet den Browser-Player (nur am PC). Gibt die Geräte-ID zurück oder schlägt nach 12 s fehl. */
export function startBrowserDevice(): Promise<string> {
  if (isMobile()) return Promise.reject(new Error('Am Handy steuert die App deine Spotify-App.'));
  sdkPromise ??= new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser-Player antwortet nicht')), 12_000);
    const fail = (e: { message?: string }) => { clearTimeout(timer); reject(new Error(e.message ?? 'Browser-Player-Fehler')); };
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (!window.Spotify) { fail({ message: 'SDK fehlt' }); return; }
      const player = new window.Spotify.Player({
        name: 'Rhythmus-App (dieser Browser)',
        getOAuthToken: (cb) => { void getAccessToken().then(cb); },
        volume: 0.8,
      });
      sdkPlayer = player;
      player.addListener('ready', (e) => { clearTimeout(timer); browserDeviceId = e.device_id ?? null; if (browserDeviceId) resolve(browserDeviceId); });
      player.addListener('initialization_error', fail);
      player.addListener('authentication_error', fail);
      player.addListener('account_error', fail);
      void player.connect();
    };
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    s.onerror = () => fail({ message: 'Browser-Player nicht geladen' });
    document.body.appendChild(s);
  });
  return sdkPromise;
}

/** Browser erlauben Ton erst nach einem Klick – bei jedem Klick auf Play/Ja/Nein aufrufen. */
export function unlockBrowserAudio(): void {
  void sdkPlayer?.activateElement?.().catch(() => undefined);
}
