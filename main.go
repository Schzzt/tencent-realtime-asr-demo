package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"runtime"
)

func main() {
	noBrowser := flag.Bool("no-browser", false, "disable auto-open browser on startup")
	flag.Parse()

	cfg, err := ParseConfig()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	// API: stop a running session by voiceID (used when ws stop message can't get through)
	http.HandleFunc("/api/stop", func(w http.ResponseWriter, r *http.Request) {
		voiceID := r.URL.Query().Get("voice_id")
		if voiceID == "" {
			http.Error(w, "missing voice_id", http.StatusBadRequest)
			return
		}
		ok := AbortSession(voiceID)
		w.Header().Set("Content-Type", "application/json")
		if ok {
			log.Printf("HTTP /api/stop: aborted session %s", voiceID)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
		} else {
			log.Printf("HTTP /api/stop: session %s not found", voiceID)
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "session not found"})
		}
	})

	// WebSocket handler
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		HandleWebSocket(w, r, cfg)
	})

	// static files — disable caching so browser always gets the latest version
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		fs.ServeHTTP(w, r)
	}))

	addr := fmt.Sprintf(":%d", cfg.Port)
	url := fmt.Sprintf("http://localhost:%d", cfg.Port)
	log.Printf("ASR Demo started at %s", url)

	// Auto-open browser unless --no-browser is set
	if !*noBrowser {
		go openBrowser(url)
	}

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// openBrowser opens the specified URL in the default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		log.Printf("auto-open browser not supported on %s, please visit: %s", runtime.GOOS, url)
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("failed to open browser: %v, please visit: %s", err, url)
	}
}
