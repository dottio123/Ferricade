package adminapi

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

const placeholderText = `ferricade: the web UI is not built into this binary. Build it with "npm ci && npm run build" in web/, then rebuild ferricade.`

func uiFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":        {Data: []byte("<!doctype html><title>ferricade</title>")},
		"assets/app-abc.js": {Data: []byte("console.log(1)")},
	}
}

func withUI(fsys fstest.MapFS) func(*Deps) {
	return func(d *Deps) { d.UI = fsys }
}

func TestUIIndexFallback(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	c := e.client()
	for _, p := range []string{"/", "/devices/abc"} {
		_, rec := c.send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusOK, rec.Code, p)
		require.Equal(t, "<!doctype html><title>ferricade</title>", rec.Body.String(), p)
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"), p)
		require.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"), p)
	}
	_, rec := c.send(http.MethodHead, "/", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Empty(t, rec.Body.String())
}

func TestUIAssetsImmutable(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	_, rec := e.client().send(http.MethodGet, "/assets/app-abc.js", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "console.log(1)", rec.Body.String())
	require.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
	require.Contains(t, rec.Header().Get("Content-Type"), "javascript")
}

func TestUIMissingAsset404(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	for _, p := range []string{"/assets/nope.js", "/assets/", "/assets"} {
		_, rec := e.client().send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusNotFound, rec.Code, p)
		require.NotContains(t, rec.Body.String(), "<title>", p)
	}
}

func TestUIPlaceholder(t *testing.T) {
	e := newEnv(t)
	for _, p := range []string{"/", "/assets/x.js"} {
		_, rec := e.client().send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusOK, rec.Code, p)
		require.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"), p)
		require.Equal(t, placeholderText, rec.Body.String(), p)
	}
}

func TestUIDoesNotShadowAPI(t *testing.T) {
	clientAPI := chi.NewRouter()
	clientAPI.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	clientAPI.Post("/api/heartbeat", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("{}")) })
	e := newEnv(t, withUI(uiFS()), func(d *Deps) { d.ClientRoutes = clientAPI })
	c := e.client()

	_, rec := c.send(http.MethodGet, "/admin/api/v1/nope", nil)
	requireError(t, rec, http.StatusNotFound, "not_found")

	_, rec = c.send(http.MethodGet, "/setup/x", nil, http.Header{"X-Setup-Token": {e.setupToken}})
	requireError(t, rec, http.StatusNotFound, "not_found")

	_, rec = c.send(http.MethodPost, "/api/heartbeat", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "{}", rec.Body.String())

	_, rec = c.send(http.MethodGet, "/healthz", nil)
	require.Equal(t, "ok", rec.Body.String())
}

func TestUIPostIs405(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	for _, p := range []string{"/", "/assets/app-abc.js"} {
		_, rec := e.client().send(http.MethodPost, p, nil)
		requireError(t, rec, http.StatusMethodNotAllowed, "method_not_allowed")
		require.Equal(t, "GET, HEAD", rec.Header().Get("Allow"), p)
	}
}

// Everything but index.html keeps the plain CSP (index.html: TestUIIndexStyleNonce).
func TestUIHasCSP(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	for _, p := range []string{"/assets/app-abc.js", "/assets/missing.js"} {
		_, rec := e.client().send(http.MethodGet, p, nil)
		require.Equal(t, contentSecurityPolicy, rec.Header().Get("Content-Security-Policy"), p)
		require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"), p)
		require.NotEmpty(t, rec.Header().Get("Strict-Transport-Security"), p)
	}
}

func TestSetupStatus(t *testing.T) {
	e := newEnv(t, withUI(uiFS()), func(d *Deps) { d.Cfg.DevInsecure = false })
	c := e.client()
	rec := c.do(http.MethodGet, "/setup/status", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, map[string]any{"setup_complete": false, "plain_http": false}, decodeBody(t, rec))

	e.markSetupComplete()
	rec = c.do(http.MethodGet, "/setup/status", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, true, decodeBody(t, rec)["setup_complete"])

	// The other setup routes are still gone.
	requireError(t, c.setup("/owner", ownerBody), http.StatusNotFound, "not_found")
}

func TestSetupStatusPlainHTTP(t *testing.T) {
	e := newEnv(t, withUI(uiFS()), func(d *Deps) { d.Cfg.DevInsecure = true })
	rec := e.client().do(http.MethodGet, "/setup/status", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, true, decodeBody(t, rec)["plain_http"])
}

// Files at the root of the build (favicon, robots.txt, the manifest) and in
// other folders are served as themselves, but not cached for good: only
// /assets/ names carry a content hash.
func TestUIServesOtherFiles(t *testing.T) {
	fsys := uiFS()
	fsys["favicon.ico"] = &fstest.MapFile{Data: []byte("ICO")}
	fsys["robots.txt"] = &fstest.MapFile{Data: []byte("User-agent: *\nDisallow: /\n")}
	fsys["manifest.webmanifest"] = &fstest.MapFile{Data: []byte(`{"name":"ferricade"}`)}
	fsys["img/logo.svg"] = &fstest.MapFile{Data: []byte("<svg/>")}
	e := newEnv(t, withUI(fsys))
	c := e.client()
	for p, want := range map[string]string{
		"/favicon.ico":          "ICO",
		"/robots.txt":           "User-agent: *\nDisallow: /\n",
		"/manifest.webmanifest": `{"name":"ferricade"}`,
		"/img/logo.svg":         "<svg/>",
	} {
		_, rec := c.send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusOK, rec.Code, p)
		require.Equal(t, want, rec.Body.String(), p)
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"), p)
	}
	_, rec := c.send(http.MethodGet, "/robots.txt", nil)
	require.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	_, rec = c.send(http.MethodGet, "/img/logo.svg", nil)
	require.Equal(t, "image/svg+xml", rec.Header().Get("Content-Type"))

	// A folder is never listed: it is a client-side route like any unknown path.
	fsys[".gitkeep"] = &fstest.MapFile{Data: []byte("")}
	for _, p := range []string{"/img", "/img/", "/nope.txt", "/.gitkeep"} {
		_, rec := c.send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusOK, rec.Code, p)
		require.Equal(t, "<!doctype html><title>ferricade</title>", rec.Body.String(), p)
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"), p)
	}
}

func TestUIErrorsNotCached(t *testing.T) {
	e := newEnv(t, withUI(uiFS()))
	_, rec := e.client().send(http.MethodGet, "/assets/nope.js", nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	_, rec = e.client().send(http.MethodPost, "/favicon.ico", nil)
	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

const (
	noncePlaceholder = "__FERRICADE_CSP_NONCE__"
	nonceIndex       = `<!doctype html><head><meta name="csp-nonce" content="__FERRICADE_CSP_NONCE__"></head><title>ferricade</title>`
)

var (
	metaNonceRE = regexp.MustCompile(`<meta name="csp-nonce" content="([^"]*)">`)
	indexCSPRE  = regexp.MustCompile(`^default-src 'self'; style-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'$`)
)

// nonceFS is the UI with an index.html that carries the nonce placeholder,
// as web/index.html does, and a root file next to it.
func nonceFS() fstest.MapFS {
	fsys := uiFS()
	fsys["index.html"] = &fstest.MapFile{Data: []byte(nonceIndex)}
	fsys["robots.txt"] = &fstest.MapFile{Data: []byte("User-agent: *\nDisallow: /\n")}
	return fsys
}

// headerNonce returns the style nonce of rec's CSP, after checking the
// policy's exact shape and that the nonce is 16 random bytes.
func headerNonce(t *testing.T, rec interface{ Header() http.Header }, p string) string {
	t.Helper()
	csp := rec.Header().Get("Content-Security-Policy")
	m := indexCSPRE.FindStringSubmatch(csp)
	require.NotNil(t, m, "%s: CSP %q", p, csp)
	raw, err := base64.StdEncoding.DecodeString(m[1])
	require.NoError(t, err, p)
	require.Len(t, raw, 16, p)
	return m[1]
}

// Ruling F5: every index.html response (the SPA fallback and /index.html)
// carries a fresh nonce, in its CSP's style-src and in <meta name="csp-nonce">.
func TestUIIndexStyleNonce(t *testing.T) {
	e := newEnv(t, withUI(nonceFS()))
	c := e.client()
	seen := map[string]string{}
	for _, p := range []string{"/", "/devices/x", "/index.html", "/", "/devices/x", "/index.html"} {
		_, rec := c.send(http.MethodGet, p, nil)
		require.Equal(t, http.StatusOK, rec.Code, p)
		require.Equal(t, "text/html; charset=utf-8", rec.Header().Get("Content-Type"), p)
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"), p)
		require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"), p)
		nonce := headerNonce(t, rec, p)
		body := rec.Body.String()
		require.NotContains(t, body, noncePlaceholder, p)
		meta := metaNonceRE.FindStringSubmatch(body)
		require.NotNil(t, meta, "%s: no csp-nonce meta in %q", p, body)
		require.Equal(t, nonce, meta[1], p)
		require.Equal(t, `<!doctype html><head><meta name="csp-nonce" content="`+nonce+`"></head><title>ferricade</title>`, body, p)
		prev, dup := seen[nonce]
		require.False(t, dup, "%s reused the nonce of %s", p, prev)
		seen[nonce] = p
	}

	_, rec := c.send(http.MethodHead, "/", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Empty(t, rec.Body.String())
	require.NotContains(t, seen, headerNonce(t, rec, "HEAD /"))
}

// Every placeholder in index.html gets the response's one nonce.
func TestUIIndexStyleNonceEveryPlaceholder(t *testing.T) {
	fsys := uiFS()
	fsys["index.html"] = &fstest.MapFile{Data: []byte("a " + noncePlaceholder + " b " + noncePlaceholder)}
	e := newEnv(t, withUI(fsys))
	_, rec := e.client().send(http.MethodGet, "/", nil)
	nonce := headerNonce(t, rec, "/")
	require.Equal(t, "a "+nonce+" b "+nonce, rec.Body.String())
}

// Only index.html is templated: assets, other files, API answers and the
// no-UI placeholder keep the plain CSP, and no body leaks the placeholder.
func TestUIStyleNonceOnlyOnIndex(t *testing.T) {
	e := newEnv(t, withUI(nonceFS()))
	c := e.client()
	for _, p := range []string{"/assets/app-abc.js", "/assets/missing.js", "/robots.txt"} {
		_, rec := c.send(http.MethodGet, p, nil)
		require.Equal(t, contentSecurityPolicy, rec.Header().Get("Content-Security-Policy"), p)
		require.NotContains(t, rec.Body.String(), noncePlaceholder, p)
	}
	rec := c.do(http.MethodGet, apiPrefix+"/auth/me", nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Equal(t, contentSecurityPolicy, rec.Header().Get("Content-Security-Policy"))

	bare := newEnv(t)
	_, rec = bare.client().send(http.MethodGet, "/", nil)
	require.Equal(t, placeholderText, rec.Body.String())
	require.Equal(t, contentSecurityPolicy, rec.Header().Get("Content-Security-Policy"))
}
