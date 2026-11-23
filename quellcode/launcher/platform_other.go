//go:build !windows

package main

// Nur zum Testen unter Linux/macOS: keine Installation, Ausgaben auf der Konsole.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func showError(msg string) { fmt.Fprintln(os.Stderr, "FEHLER:", msg) }
func showInfo(msg string)  { fmt.Println(msg) }
func confirm(msg string) bool {
	fmt.Println(msg, "(automatisch: ja)")
	return true
}

func installDirectory() string { return "" } // keine Selbstinstallation

func dataDirectory() string {
	if d := os.Getenv("RHYTHMUS_DATA"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "Rhythmus")
}

func startDetached(path string) error { return exec.Command(path).Start() }
func openApp() error {
	if os.Getenv("RHYTHMUS_NO_BROWSER") != "" {
		return nil
	}
	return exec.Command("xdg-open", appURL).Start()
}
func createShortcuts(string, string) error { return nil }
func removeShortcuts()                     {}
func removeInstallDirLater(string)         {}
