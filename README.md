# Rhythmus

Spotify-Vorschläge nach **Rhythmus statt Genre**. Die App lernt aus deinen Lieblingssongs und aus deinem Ja/Nein und schlägt Titel aus dem ganzen Spotify-Katalog vor.

- **Handy / Browser:** https://glashaut.github.io/rythmus/ öffnen. Unter Android „App installieren“ wählen, auf dem iPhone „Zum Home-Bildschirm“.
- **Windows:** `Rhythmus.exe` aus den [Releases](https://github.com/glashaut/rythmus/releases) bzw. dem Ordner `download/` herunterladen und doppelklicken.
- **Anleitung:** [ANLEITUNG.txt](ANLEITUNG.txt), mit Einrichtung, Bedienung und Fehlerhilfe.

## Aufbau dieses Repositorys

| Ort | Inhalt |
|---|---|
| oben (`index.html`, `assets/`, Icons, `sw.js`) | fertige App, wird über GitHub Pages ausgeliefert |
| `quellcode/` | Quellcode (TypeScript/React), Windows-Starter (Go), Tests, Build-Skripte |

Für Änderungen siehe `quellcode/README.md`. Kurz zusammengefasst:
1. `cd quellcode && npm install && npm run build`
2. Den Inhalt von `quellcode/dist/` nach oben kopieren.
3. Für die Windows-Version zusätzlich `./build-exe.sh` ausführen (Go 1.24+ nötig).

Version: 0.10
