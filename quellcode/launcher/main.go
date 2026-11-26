// Rhythmus.exe – Windows-Starter für die Rhythmus-App.
//
// Beim ersten Start: installiert sich nach %LOCALAPPDATA%\Programs\Rhythmus,
// legt Verknüpfungen auf dem Desktop und im Startmenü an.
// Danach: startet einen kleinen Webserver nur für diesen PC (127.0.0.1:5173),
// öffnet die App in einem eigenen Fenster (Microsoft Edge im App-Modus)
// und speichert die Eingaben dauerhaft in %APPDATA%\Rhythmus\daten.json.
// Wird das App-Fenster geschlossen, beendet sich der Starter nach einigen Minuten selbst.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	version = "0.11.0"
	addr    = "127.0.0.1:5173"
	appURL  = "http://127.0.0.1:5173/"
	// Ohne Lebenszeichen der App beendet sich der Starter nach dieser Zeit
	idleTimeout  = 10 * time.Minute
	firstTimeout = 5 * time.Minute
	maxStoreSize = 30 << 20
)

//go:embed dist
var distFS embed.FS

//go:embed rhythmus.ico
var iconData []byte

var (
	mu       sync.Mutex
	lastPing = time.Now()
	pinged   = false
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		uninstall()
		return
	}
	if err := run(); err != nil {
		showError("Rhythmus konnte nicht starten:\n\n" + err.Error())
		os.Exit(1)
	}
}

func run() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	installDir := installDirectory()
	target := filepath.Join(installDir, "Rhythmus.exe")

	// Nicht aus dem Installationsordner gestartet → installieren bzw. aktualisieren
	if installDir != "" && !samePath(self, target) && !portableMode() {
		if err := install(self, installDir, target); err != nil {
			return fmt.Errorf("Installation fehlgeschlagen: %w", err)
		}
		return startDetached(target)
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Läuft schon? Dann nur das Fenster öffnen.
		if running, _ := pingRunning(); running {
			return openApp()
		}
		return fmt.Errorf("Port 5173 ist von einem anderen Programm belegt (z. B. dem Python-Server aus der Anleitung). Bitte dieses Programm beenden und Rhythmus erneut starten")
	}

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", handlePing)
	mux.HandleFunc("/api/store", handleStore)
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "nur POST", http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
	})
	files := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// App-Dateien nie veralten lassen, damit Updates sofort greifen
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))

	go watchdog()
	go func() {
		time.Sleep(300 * time.Millisecond)
		_ = openApp()
	}()
	srv := &http.Server{Handler: localOnly(mux), ReadHeaderTimeout: 10 * time.Second}
	return srv.Serve(ln)
}

// Nur Anfragen von diesem PC und von der eigenen Seite zulassen.
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if host != "127.0.0.1" && host != "::1" {
			http.Error(w, "nur lokal", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			if o := r.Header.Get("Origin"); o != "" && o != "http://127.0.0.1:5173" {
				http.Error(w, "fremde Seite", http.StatusForbidden)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

func handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		mu.Lock()
		lastPing, pinged = time.Now(), true
		mu.Unlock()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"app": "rhythmus", "version": version})
}

func storePath() string { return filepath.Join(dataDirectory(), "daten.json") }

func handleStore(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		b, err := os.ReadFile(storePath())
		if err != nil || !json.Valid(b) {
			_, _ = w.Write([]byte("{}"))
			return
		}
		_, _ = w.Write(b)
	case http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, maxStoreSize+1))
		if err != nil || len(b) > maxStoreSize {
			http.Error(w, "zu groß", http.StatusRequestEntityTooLarge)
			return
		}
		var m map[string]string
		if json.Unmarshal(b, &m) != nil {
			http.Error(w, "ungültig", http.StatusBadRequest)
			return
		}
		if err := writeAtomic(storePath(), b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		mu.Lock()
		lastPing, pinged = time.Now(), true
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Methode nicht erlaubt", http.StatusMethodNotAllowed)
	}
}

func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func watchdog() {
	for {
		time.Sleep(30 * time.Second)
		mu.Lock()
		idle, was := time.Since(lastPing), pinged
		mu.Unlock()
		if (was && idle > idleTimeout) || (!was && idle > firstTimeout) {
			os.Exit(0)
		}
	}
}

func pingRunning() (bool, string) {
	c := http.Client{Timeout: 2 * time.Second}
	res, err := c.Get(appURL + "api/ping")
	if err != nil {
		return false, ""
	}
	defer res.Body.Close()
	var v struct{ App, Version string }
	if json.NewDecoder(res.Body).Decode(&v) != nil || v.App != "rhythmus" {
		return false, ""
	}
	return true, v.Version
}

func stopRunning() {
	if ok, _ := pingRunning(); !ok {
		return
	}
	req, _ := http.NewRequest(http.MethodPost, appURL+"api/quit", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	c := http.Client{Timeout: 2 * time.Second}
	if res, err := c.Do(req); err == nil {
		res.Body.Close()
	}
	for i := 0; i < 30; i++ {
		if ok, _ := pingRunning(); !ok {
			time.Sleep(300 * time.Millisecond) // Datei-Sperre freigeben lassen
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func install(self, dir, target string) error {
	stopRunning() // eine laufende ältere Version beenden, damit sie ersetzt werden kann
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var lastErr error
	for i := 0; i < 10; i++ {
		if lastErr = copyFile(self, target); lastErr == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if lastErr != nil {
		return lastErr
	}
	icon := filepath.Join(dir, "rhythmus.ico")
	_ = os.WriteFile(icon, iconData, 0o644)
	// Verknüpfungen sind Komfort: Falls PowerShell gesperrt ist, läuft die App trotzdem
	if err := createShortcuts(target, icon); err != nil {
		showInfo("Rhythmus ist installiert, aber die Verknüpfungen konnten nicht angelegt werden.\n\nDu findest das Programm hier:\n" + target)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".neu"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Remove(dst)
	return os.Rename(tmp, dst)
}

func samePath(a, b string) bool {
	ca, err1 := filepath.Abs(a)
	cb, err2 := filepath.Abs(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(ca), filepath.Clean(cb))
}

// Mit einer Datei "portable.txt" neben der exe wird nichts installiert (z. B. für einen USB-Stick).
func portableMode() bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(filepath.Dir(self), "portable.txt"))
	return !errors.Is(err, os.ErrNotExist)
}

func uninstall() {
	if !confirm("Rhythmus deinstallieren?\n\nDeine Lieblingssongs und Bewertungen bleiben bei Spotify erhalten.") {
		return
	}
	stopRunning()
	removeShortcuts()
	if confirm("Auch die auf diesem PC gespeicherten Daten löschen (Client ID, Anmeldung, Zwischenspeicher)?") {
		_ = os.RemoveAll(dataDirectory())
	}
	removeInstallDirLater(installDirectory())
	showInfo("Rhythmus wurde deinstalliert.")
}
