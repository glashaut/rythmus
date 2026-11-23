//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const createNoWindow = 0x08000000

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	procMessageBox   = user32.NewProc("MessageBoxW")
	procEnumWindows  = user32.NewProc("EnumWindows")
	procGetWindowTxt = user32.NewProc("GetWindowTextW")
	procGetClassName = user32.NewProc("GetClassNameW")
	procSendMessage  = user32.NewProc("SendMessageW")
	procLoadImage    = user32.NewProc("LoadImageW")
	procIsVisible    = user32.NewProc("IsWindowVisible")
)

const (
	mbOK        = 0x0
	mbYesNo     = 0x4
	mbIconError = 0x10
	mbIconQuest = 0x20
	mbIconInfo  = 0x40
	mbSetFg     = 0x10000
	idYes       = 6
)

func messageBox(text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("Rhythmus")
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags|mbSetFg)
	return int(r)
}

func showError(msg string) { messageBox(msg, mbOK|mbIconError) }
func showInfo(msg string)  { messageBox(msg, mbOK|mbIconInfo) }
func confirm(msg string) bool {
	return messageBox(msg, mbYesNo|mbIconQuest) == idYes
}

func installDirectory() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return ""
	}
	return filepath.Join(base, "Programs", "Rhythmus")
}

func dataDirectory() string {
	base, err := os.UserConfigDir() // %APPDATA%
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "Rhythmus")
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func startDetached(path string) error {
	cmd := exec.Command(path)
	cmd.Dir = filepath.Dir(path)
	return cmd.Start()
}

// Öffnet die App in einem eigenen Fenster (Edge-App-Modus), sonst im Standardbrowser.
func openApp() error {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "Edge", "Application", "msedge.exe"),
	}
	for _, edge := range candidates {
		if _, err := os.Stat(edge); err == nil {
			if exec.Command(edge, "--app="+appURL, "--window-size=500,900").Start() == nil {
				go keepWindowIcon()
				return nil
			}
		}
	}
	return hidden(exec.Command("rundll32", "url.dll,FileProtocolHandler", appURL)).Start()
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func powershell(script string) error {
	return hidden(exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)).Run()
}

func createShortcuts(target, icon string) error {
	dir := filepath.Dir(target)
	script := `$W = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath('Desktop')
$prog = [Environment]::GetFolderPath('Programs')
function L($path, $a, $desc) {
  $s = $W.CreateShortcut($path)
  $s.TargetPath = ` + psQuote(target) + `
  $s.Arguments = $a
  $s.WorkingDirectory = ` + psQuote(dir) + `
  $s.IconLocation = ` + psQuote(icon) + `
  $s.Description = $desc
  $s.Save()
}
L (Join-Path $desk 'Rhythmus.lnk') '' 'Spotify-Vorschläge nach Rhythmus'
L (Join-Path $prog 'Rhythmus.lnk') '' 'Spotify-Vorschläge nach Rhythmus'
L (Join-Path $prog 'Rhythmus deinstallieren.lnk') '--uninstall' 'Rhythmus entfernen'`
	return powershell(script)
}

func removeShortcuts() {
	_ = powershell(`$desk = [Environment]::GetFolderPath('Desktop')
$prog = [Environment]::GetFolderPath('Programs')
Remove-Item -ErrorAction SilentlyContinue (Join-Path $desk 'Rhythmus.lnk'), (Join-Path $prog 'Rhythmus.lnk'), (Join-Path $prog 'Rhythmus deinstallieren.lnk')`)
}

// Die laufende exe kann sich nicht selbst löschen → kurz nach dem Beenden per cmd entfernen.
func removeInstallDirLater(dir string) {
	if dir == "" || !strings.Contains(strings.ToLower(dir), "rhythmus") {
		return
	}
	_ = hidden(exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dir+"\"")).Start()
}

// ---------- Logo am App-Fenster und in der Taskleiste ----------
//
// Das App-Fenster gehört technisch zu Edge. Windows gruppiert Taskleisten-Knöpfe über die
// "AppUserModelID" eines Fensters und nimmt dafür das Symbol der zugehörigen App (hier: Edge).
// Deshalb bekommt das Rhythmus-Fenster eine eigene ID plus Name/Symbol/Startbefehl für das
// Anheften, und zusätzlich das Logo als Fenstersymbol.

const (
	wmSetIcon      = 0x0080
	iconSmall      = 0
	iconBig        = 1
	imageIcon      = 1
	lrLoadFromFile = 0x0010
	vtLPWSTR       = 31
	appUserModelID = "Rhythmus.App"
)

var (
	shell32                = syscall.NewLazyDLL("shell32.dll")
	ole32                  = syscall.NewLazyDLL("ole32.dll")
	procSHGetPropertyStore = shell32.NewProc("SHGetPropertyStoreForWindow")
	procCoInitializeEx     = ole32.NewProc("CoInitializeEx")
	procGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	iidIPropertyStore      = guid{0x886D8EEB, 0x8CF2, 0x4446, [8]byte{0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99}}
	fmtidAppUserModel      = guid{0x9F4C2855, 0x9F79, 0x4B39, [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// COM-Objekt: erstes Feld ist der Zeiger auf die Methodentabelle (IUnknown + IPropertyStore = 8 Methoden)
type comObject struct {
	vtbl *[8]uintptr
}

type propertyKey struct {
	Fmtid guid
	Pid   uint32
}

// PROPVARIANT ist auf 64-Bit 24 Bytes groß: Typ (2) + 3x reserviert (6) + Wert (16)
type propVariant struct {
	Vt  uint16
	_   [3]uint16
	Val uintptr
	_   uintptr
}

func logf(format string, args ...any) {
	path := filepath.Join(dataDirectory(), "log.txt")
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	if st, err := os.Stat(path); err == nil && st.Size() > 200_000 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// Setzt eine Text-Eigenschaft im Eigenschaftsspeicher eines Fensters.
func setWindowProps(hwnd uintptr, props map[uint32]string) error {
	var obj *comObject
	hr, _, _ := procSHGetPropertyStore.Call(hwnd, uintptr(unsafe.Pointer(&iidIPropertyStore)), uintptr(unsafe.Pointer(&obj)))
	if int32(hr) < 0 || obj == nil {
		return fmt.Errorf("SHGetPropertyStoreForWindow 0x%08X", uint32(hr))
	}
	store := uintptr(unsafe.Pointer(obj))
	release, setValue, commit := obj.vtbl[2], obj.vtbl[6], obj.vtbl[7]
	defer syscall.SyscallN(release, store)
	// Reihenfolge wichtig: Relaunch-Angaben zuerst, die ID zuletzt
	for _, pid := range []uint32{2, 3, 4, 5} {
		val, ok := props[pid]
		if !ok {
			continue
		}
		str, _ := syscall.UTF16PtrFromString(val)
		key := propertyKey{Fmtid: fmtidAppUserModel, Pid: pid}
		pv := propVariant{Vt: vtLPWSTR, Val: uintptr(unsafe.Pointer(str))}
		r, _, _ := syscall.SyscallN(setValue, store, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv)))
		runtime.KeepAlive(str)
		if int32(r) < 0 {
			return fmt.Errorf("SetValue(%d) 0x%08X", pid, uint32(r))
		}
	}
	if r, _, _ := syscall.SyscallN(commit, store); int32(r) < 0 {
		return fmt.Errorf("Commit 0x%08X", uint32(r))
	}
	return nil
}

func iconFile() string {
	self, err := os.Executable()
	if err == nil {
		p := filepath.Join(filepath.Dir(self), "rhythmus.ico")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	p := filepath.Join(os.TempDir(), "rhythmus.ico")
	_ = os.WriteFile(p, iconData, 0o644)
	return p
}

func loadIcon(path string, size int) uintptr {
	p, _ := syscall.UTF16PtrFromString(path)
	h, _, _ := procLoadImage.Call(0, uintptr(unsafe.Pointer(p)), imageIcon, uintptr(size), uintptr(size), lrLoadFromFile)
	return h
}

func windowText(proc *syscall.LazyProc, hwnd uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := proc.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

type winInfo struct {
	hwnd  uintptr
	title string
}

var (
	enumResult   []winInfo
	enumCallback = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		if v, _, _ := procIsVisible.Call(hwnd); v == 0 {
			return 1
		}
		if !strings.HasPrefix(windowText(procGetClassName, hwnd), "Chrome_WidgetWin") {
			return 1
		}
		enumResult = append(enumResult, winInfo{hwnd, windowText(procGetWindowTxt, hwnd)})
		return 1
	})
)

// Nur das App-Fenster: Titel genau "Rhythmus" (normale Browserfenster haben "… – Microsoft Edge" im Titel).
func isAppWindow(title string) bool {
	t := strings.TrimSpace(title)
	return t == "Rhythmus"
}

func keepWindowIcon() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	procCoInitializeEx.Call(0, 0x2) // COINIT_APARTMENTTHREADED

	path := iconFile()
	big, small := loadIcon(path, 64), loadIcon(path, 32)
	self, _ := os.Executable()
	logf("Fenster-Symbol: Start (exe=%s, ico=%s, iconsOK=%v)", self, path, big != 0 && small != 0)

	done := map[uintptr]bool{}
	logged := false
	for i := 0; i < 80; i++ {
		enumResult = enumResult[:0]
		procEnumWindows.Call(enumCallback, 0)
		for _, w := range enumResult {
			if !isAppWindow(w.title) {
				continue
			}
			if !done[w.hwnd] {
				err := setWindowProps(w.hwnd, map[uint32]string{
					2: "\"" + self + "\"", // RelaunchCommand (Anheften startet Rhythmus.exe)
					3: path + ",0",        // RelaunchIconResource
					4: "Rhythmus",         // RelaunchDisplayNameResource
					5: appUserModelID,     // AppUserModelID → eigene Gruppe in der Taskleiste
				})
				logf("App-Fenster gefunden (hwnd=%#x): Taskleisten-ID gesetzt, Fehler=%v", w.hwnd, err)
				done[w.hwnd] = true
			}
			if big != 0 {
				procSendMessage.Call(w.hwnd, wmSetIcon, iconBig, big)
			}
			if small != 0 {
				procSendMessage.Call(w.hwnd, wmSetIcon, iconSmall, small)
			}
		}
		if i == 20 && len(done) == 0 && !logged {
			titles := []string{}
			for _, w := range enumResult {
				titles = append(titles, fmt.Sprintf("%q", w.title))
			}
			logf("Kein App-Fenster mit Titel \"Rhythmus\" gefunden. Sichtbare Edge/Chrome-Fenster: %s", strings.Join(titles, ", "))
			logged = true
		}
		if i < 40 {
			time.Sleep(500 * time.Millisecond)
		} else {
			time.Sleep(5 * time.Second)
		}
	}
}
