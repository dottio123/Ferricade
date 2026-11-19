package adminapi

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

const (
	codeMethodNotAllowed = "method_not_allowed" // 405, UI paths only

	uiPlaceholder = `ferricade: the web UI is not built into this binary. Build it with "npm ci && npm run build" in web/, then rebuild ferricade.`

	// cspNoncePlaceholder is the text web/index.html carries in its
	// <meta name="csp-nonce"> (scripts/check-dist.mjs checks it is there once).
	cspNoncePlaceholder = "__FERRICADE_CSP_NONCE__"
)

// uiHandler serves the embedded single-page app: files under /assets/ (their
// names carry a content hash, so they are cached for good), any other file of
// the build at its path (favicon.ico, robots.txt, the manifest; not cached,
// since their names do not change), and index.html for every other path, so
// client-side routes survive a reload. Folders are never listed. It runs
// inside the security-header middleware like every other admin response.
func (a *api) uiHandler() http.Handler {
	ui := a.d.UI
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !safeMethod(r.Method) {
			w.Header().Set("Allow", "GET, HEAD")
			w.Header().Set("Cache-Control", "no-store")
			writeError(w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "only GET and HEAD are allowed")
			return
		}
		if ui == nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(uiPlaceholder))
			return
		}
		p := path.Clean("/" + r.URL.Path)
		name := strings.TrimPrefix(p, "/")
		if p == "/assets" || strings.HasPrefix(p, "/assets/") {
			data, ok := readFile(ui, name)
			if !ok {
				w.Header().Set("Cache-Control", "no-store")
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			http.ServeContent(w, r, path.Base(p), time.Time{}, bytes.NewReader(data))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if name != "index.html" {
			if data, ok := readFile(ui, name); ok {
				http.ServeContent(w, r, path.Base(p), time.Time{}, bytes.NewReader(data))
				return
			}
		}
		index, err := fs.ReadFile(ui, "index.html")
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		a.serveIndex(w, r, index)
	})
}

// serveIndex serves index.html with a fresh style nonce (Ruling F5): Radix's
// scroll lock adds a <style> at runtime, which default-src 'self' blocks. The
// page reads the nonce from <meta name="csp-nonce"> and puts it on the styles
// it adds; only this response's CSP allows it, and only for <style> elements
// (scripts stay 'self', style attributes stay blocked). The response is
// no-store, so a nonce is never served twice.
func (a *api) serveIndex(w http.ResponseWriter, r *http.Request, index []byte) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		a.writeInternal(w, r, fmt.Errorf("csp nonce: %w", err))
		return
	}
	nonce := base64.StdEncoding.EncodeToString(raw[:])
	body := bytes.ReplaceAll(index, []byte(cspNoncePlaceholder), []byte(nonce))
	w.Header().Set("Content-Security-Policy", styleNonceCSP(nonce))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(body))
}

// styleNonceCSP is contentSecurityPolicy with a style-src directive for nonce
// inserted after default-src, built from the constant so the two cannot
// drift. Should default-src change, nothing is inserted: styles fall back to
// the plain policy (fail closed) and TestUIIndexStyleNonce fails.
func styleNonceCSP(nonce string) string {
	const head = "default-src 'self'; "
	return strings.Replace(contentSecurityPolicy, head, head+"style-src 'self' 'nonce-"+nonce+"'; ", 1)
}

// readFile returns the regular file name of fsys, and false for a folder,
// the root, a missing file or a dotfile (dist/.gitkeep is embedded too).
func readFile(fsys fs.FS, name string) ([]byte, bool) {
	if name == "" || !fs.ValidPath(name) || strings.HasPrefix(name, ".") || strings.Contains(name, "/.") {
		return nil, false
	}
	st, err := fs.Stat(fsys, name)
	if err != nil || !st.Mode().IsRegular() {
		return nil, false
	}
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, false
	}
	return data, true
}

// setupStatus handles GET /setup/status. It is outside the setup guard so the
// UI can tell the wizard from the sign-in page, before and after setup.
func (a *api) setupStatus(w http.ResponseWriter, r *http.Request) {
	done, err := a.d.Setup.Complete(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		SetupComplete bool `json:"setup_complete"`
	}{done})
}
