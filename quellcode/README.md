# Rhythmus – Spotify-Vorschläge nach Groove statt Genre

Web-App (PWA) für Handy und PC. Schlägt Titel quer durch alle Genres vor, sortiert nach Rhythmus
(Tempo, Tanzbarkeit, Energie …), und lernt aus deinem Ja/Nein.

## Was gespeichert wird
- **Ja** → deine Spotify-**Lieblingssongs** (alle Lieblingssongs fließen ins Lernen ein)
- **Nein** → private Spotify-Playlist „Rhythmus-Abgelehnt“
- Titel aus der alten Playlist „Rhythmus-Favoriten“ (Version 0.1/0.2) werden beim Start einmalig in die Lieblingssongs übernommen

Dadurch ist der Lernstand auf allen Geräten gleich. Kein eigener Server, keine Datenbank.

## 1. Spotify-App anlegen (einmalig)
1. https://developer.spotify.com/dashboard öffnen (Spotify Premium nötig) → **Create app**
2. Bei den APIs **Web API** ankreuzen
3. **Redirect URIs** eintragen (genau so, mit Schrägstrich am Ende):
   - zum Testen am PC: `http://127.0.0.1:5173/`
   - später online, z. B.: `https://DEINNAME.github.io/rhythmus/`
4. Client ID kopieren. Die App fragt beim ersten Start danach.

Hinweis: Spotify erlaubt `http` nur mit `127.0.0.1`, nicht mit `localhost`.

## 2a. Starten mit Node.js (zum Weiterentwickeln)
```
npm install
npm run dev        # → http://127.0.0.1:5173/
npm test           # Tests der Rhythmus-Logik
npm run build      # fertige Dateien in dist/
```

## 2b. Ohne Node.js: fertigen Build nutzen
Der Ordner `dist/` ist bereits gebaut. Zum lokalen Testen:
```
cd dist
python3 -m http.server 5173 --bind 127.0.0.1
```
Für Handy + PC den Inhalt von `dist/` auf GitHub Pages oder Netlify hochladen (HTTPS),
die Adresse als Redirect URI eintragen, am Handy öffnen → „Zum Startbildschirm hinzufügen“.

## Aufbau
| Datei | Aufgabe |
|---|---|
| `src/spotify.ts` | Anmeldung (OAuth PKCE), Suche, Playlists (API-Stand Feb. 2026: `/me/playlists`, `/items`, max. 10 Suchtreffer) |
| `src/reccobeats.ts` | Rhythmusdaten + Empfehlungen von ReccoBeats (Ersatz für Spotifys abgeschaltete Endpunkte), mit Cache |
| `src/rhythm.ts` | Fingerabdruck, Ähnlichkeit, Bewertung – hier stellt man das „Gefühl“ der App ein |
| `src/engine.ts` | Kandidaten sammeln (Empfehlungen + Zufallsstichproben aus dem ganzen Katalog: zufällige Zeichen, Jahrgänge, Positionen), Ja/Nein speichern |
| `src/App.tsx` | Oberfläche |

### Wie die Bewertung funktioniert (`src/rhythm.ts`)
- Gewichte: Tempo 2 · Tanzbarkeit 2 · Energie 1,5 · Akustik 0,75 · Rest 0,5
- Halbes/doppeltes Tempo zählt als fast gleich (90 BPM Hip-Hop ≈ 180 BPM Drum and Bass)
- Vergleich mit den 3 ähnlichsten Favoriten statt mit dem Durchschnitt → verschiedene Vorlieben bleiben getrennt
- Ein „Nein“ verliert alle 14 Tage die Hälfte seines Gewichts; nach 14 Tagen darf der Titel wieder auftauchen
- ca. 15 % der Vorschläge sind bewusste Ausreißer

## Bekannte Grenzen
- Spotify Development Mode: max. 5 Nutzer, Besitzer braucht Premium
- Der Rhythmus-Dienst kennt nicht jeden Titel; solche Favoriten werden angezeigt, fließen aber nicht ins Lernen ein
- Falls der Browser Anfragen an `api.reccobeats.com` blockiert (CORS-Fehler in der Konsole), braucht es einen kleinen Vermittlungsdienst (Cloudflare Worker) – noch nicht eingebaut
