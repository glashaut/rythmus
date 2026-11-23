// Nur in der Windows-Version (Rhythmus.exe) aktiv: hält die Eingaben zusätzlich in einer Datei
// auf dem PC (%APPDATA%\Rhythmus\daten.json), damit sie auch nach dem Leeren des Browsers erhalten bleiben.
// Im Browser bzw. auf GitHub Pages gibt es /api/store nicht – dann passiert hier nichts.

const PREFIX = 'rz.';
let lastSaved = '';

function snapshot(): string {
  const data: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        const v = localStorage.getItem(k);
        if (v !== null) data[k] = v;
      }
    }
  } catch { /* Speicher gesperrt */ }
  return JSON.stringify(data);
}

async function save(): Promise<void> {
  const body = snapshot();
  if (body === lastSaved) return;
  try {
    const r = await fetch('./api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.ok) lastSaved = body;
  } catch { /* Starter beendet */ }
}

/** Vor dem Start der App aufrufen. Gibt true zurück, wenn die Windows-Version läuft. */
export async function initDesktopStorage(): Promise<boolean> {
  if (!/^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) return false;
  let stored: Record<string, string>;
  try {
    const r = await fetch('./api/store', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false;
    stored = (await r.json()) as Record<string, string>;
  } catch {
    return false;
  }
  // Fehlende Werte aus der Datei wiederherstellen (der Browser-Stand hat Vorrang, er ist aktueller)
  try {
    for (const [k, v] of Object.entries(stored)) {
      if (k.startsWith(PREFIX) && typeof v === 'string' && localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch { /* egal */ }

  const ping = () => { void fetch('./api/ping', { method: 'POST' }).catch(() => undefined); };
  ping();
  setInterval(() => { ping(); void save(); }, 15_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void save(); });
  window.addEventListener('pagehide', () => { void save(); });
  setTimeout(() => void save(), 3000);
  return true;
}
