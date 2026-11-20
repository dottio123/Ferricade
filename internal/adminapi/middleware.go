package adminapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/httpx"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	headerRequestID = httpx.HeaderRequestID
	headerCSRF      = "X-CSRF-Token"
	headerSetup     = "X-Setup-Token"

	contentSecurityPolicy = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)

type ctxKey int

const (
	authKey ctxKey = iota
	logMetaKey
)

type logMeta struct {
	user string
}

func setLogUser(ctx context.Context, user string) {
	if m, ok := ctx.Value(logMetaKey).(*logMeta); ok {
		m.user = user
	}
}

// authInfo is the signed-in session of a request: the session, its user and
// the cookie token (needed to rotate or end the session).
type authInfo struct {
	session auth.Session
	user    auth.User
	token   string
}

func withAuth(ctx context.Context, a authInfo) context.Context {
	return context.WithValue(ctx, authKey, a)
}

func authFrom(ctx context.Context) (authInfo, bool) {
	a, ok := ctx.Value(authKey).(authInfo)
	return a, ok
}

// userFrom returns the signed-in user, or the zero User when there is none.
func userFrom(ctx context.Context) auth.User {
	a, _ := authFrom(ctx)
	return a.user
}

// sessionFrom returns the request's session, or the zero Session when there
// is none.
func sessionFrom(ctx context.Context) auth.Session {
	a, _ := authFrom(ctx)
	return a.session
}

func requestIDFrom(ctx context.Context) string {
	return httpx.RequestIDFrom(ctx)
}

func (a *api) requestID(next http.Handler) http.Handler {
	return httpx.RequestID(next)
}

func (a *api) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := a.now()
		meta := &logMeta{}
		sw := httpx.NewStatusWriter(w)
		r = r.WithContext(context.WithValue(r.Context(), logMetaKey, meta))
		next.ServeHTTP(sw, r)

		route := routePattern(r)
		if a.d.ClientRoutes != nil && (route == "/api/*" || route == "/healthz") {
			return
		}

		status := sw.Status()
		var level slog.Level
		switch {
		case status >= 500:
			level = slog.LevelWarn
		case status == http.StatusUnauthorized, status == http.StatusNotFound, status == http.StatusMethodNotAllowed, status == http.StatusTooManyRequests:
			level = slog.LevelDebug
		case status >= 400:
			level = slog.LevelInfo
		case route == "/admin/api/v1/events" || route == "/*" || route == "/healthz":
			level = slog.LevelDebug
		case !safeMethod(r.Method):
			level = slog.LevelInfo
		default:
			level = slog.LevelDebug
		}

		ipStr := a.logIP(r)
		attrs := []any{
			"method", r.Method,
			"route", route,
			"status", status,
			"duration_ms", a.now().Sub(start).Milliseconds(),
			"ip", ipStr,
			"request_id", requestIDFrom(r.Context()),
		}
		if meta.user != "" {
			attrs = append(attrs, "user", meta.user)
		}
		a.log.Log(r.Context(), level, "admin request", attrs...)
	})
}

// securityHeaders sets the spec's response headers; HSTS is left out in
// DEV_INSECURE mode, where the console is served over plain HTTP.
func (a *api) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if !a.d.Cfg.DevInsecure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// recoverer turns a panic into a logged 500 "internal" response carrying the
// request ID. http.ErrAbortHandler is re-raised, as net/http expects.
func (a *api) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			a.writeInternal(w, r, fmt.Errorf("panic: %v\n%s", v, debug.Stack()))
		}()
		next.ServeHTTP(w, r)
	})
}

// noStore keeps API responses, which carry CSRF tokens and secrets, out of
// caches.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// loadSession resolves the session cookie. A valid session of an active user
// is put in the context; an unknown or expired one clears the cookie, and a
// session whose user is gone or not active is deleted. The request continues
// either way: requireAuth decides whether a session is needed.
func (a *api) loadSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ck, err := r.Cookie(sessionCookieName(a.d.Cfg))
		if err != nil || ck.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		ctx := r.Context()
		q := db.New(a.d.Pool)
		sess, err := a.d.Sessions.Lookup(ctx, q, ck.Value)
		if errors.Is(err, auth.ErrNoSession) {
			a.clearSessionCookie(w)
			next.ServeHTTP(w, r)
			return
		}
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		if sess.User.Status != "active" {
			if err := a.d.Sessions.Delete(ctx, q, ck.Value); err != nil {
				a.writeInternal(w, r, err)
				return
			}
			a.clearSessionCookie(w)
			next.ServeHTTP(w, r)
			return
		}
		setLogUser(ctx, sess.User.Username)
		next.ServeHTTP(w, r.WithContext(withAuth(ctx, authInfo{
			session: sess, user: sess.User, token: ck.Value,
		})))
	})
}

func safeMethod(m string) bool { return m == http.MethodGet || m == http.MethodHead }

// checkOrigin refuses a state-changing request unless its Origin header, or
// its Referer when Origin is absent, has PUBLIC_URL's origin.
func (a *api) checkOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !safeMethod(r.Method) && !a.sameOrigin(r) {
			a.log.Log(r.Context(), a.securityRejectLevel(r), "origin rejected", "route", routePattern(r), "ip", a.logIP(r), "request_id", requestIDFrom(r.Context()))
			writeError(w, http.StatusForbidden, codeCSRF, "request origin does not match the console")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *api) securityRejectLevel(r *http.Request) slog.Level {
	if _, ok := authFrom(r.Context()); ok {
		return slog.LevelWarn
	}
	return slog.LevelDebug
}

func routePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "-"
}

func (a *api) logIP(r *http.Request) string {
	if ip := httpx.ClientIP(r, a.d.Cfg.TrustedProxies); ip.IsValid() {
		return ip.String()
	}
	return ""
}

func (a *api) sameOrigin(r *http.Request) bool {
	src := r.Header.Get("Origin")
	if src == "" {
		src = r.Header.Get("Referer")
	}
	if src == "" || a.d.Cfg.PublicURL == nil {
		return false
	}
	u, err := url.Parse(src)
	if err != nil {
		return false
	}
	got, want := origin(u), origin(a.d.Cfg.PublicURL)
	return got != "" && got == want
}

// origin returns u's scheme://host[:port] in lower case, without a default
// port, or "" when u has no http(s) scheme or no host.
func origin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if (scheme != "http" && scheme != "https") || host == "" {
		return ""
	}
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if port == "" {
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		return scheme + "://" + host
	}
	return scheme + "://" + net.JoinHostPort(host, port)
}

// csrfToken requires, on a state-changing request with a session, an
// X-CSRF-Token header equal to the session's CSRF token. Requests without a
// session pass through to requireAuth.
func (a *api) csrfToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if info, ok := authFrom(r.Context()); ok && !safeMethod(r.Method) {
			got := r.Header.Get(headerCSRF)
			if subtle.ConstantTimeCompare([]byte(got), []byte(info.session.CSRFToken)) != 1 {
				a.log.Log(r.Context(), a.securityRejectLevel(r), "csrf rejected", "route", routePattern(r), "ip", a.logIP(r), "request_id", requestIDFrom(r.Context()))
				writeError(w, http.StatusForbidden, codeCSRF, "missing or wrong "+headerCSRF+" header")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requireAuth requires a signed-in session.
func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := authFrom(r.Context()); !ok {
			writeError(w, http.StatusUnauthorized, codeUnauthenticated, "sign in required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireMFA requires the session to have passed TOTP when the user has TOTP
// enrolled, and refuses users who must enroll but have not.
func requireMFA(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info, _ := authFrom(r.Context())
		switch {
		case info.user.TOTPEnrolled && !info.session.MFAPassed:
			writeError(w, http.StatusForbidden, codeMFARequired, "enter your TOTP code first")
		case !info.user.TOTPEnrolled && info.user.TOTPRequired:
			writeError(w, http.StatusForbidden, codeTOTPEnrollRequired, "set up TOTP first")
		default:
			next.ServeHTTP(w, r)
		}
	})
}

// allowTOTPEnroll admits users without TOTP, who may enroll, and users with
// TOTP only after their session has passed it, so a password alone cannot
// replace the second factor.
func allowTOTPEnroll(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info, _ := authFrom(r.Context())
		if info.user.TOTPEnrolled && !info.session.MFAPassed {
			writeError(w, http.StatusForbidden, codeMFARequired, "enter your TOTP code first")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireRole requires one of the listed roles.
func requireRole(roles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for _, role := range roles {
				if userFrom(r.Context()).Role == role {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeError(w, http.StatusForbidden, codeForbidden, "not allowed for your role")
		})
	}
}

func scopeOf(u auth.User) *uuid.UUID {
	if u.Role == roleUser {
		return &u.ID
	}
	return nil
}

// clientIP returns the request's client address for audit records and
// sessions. It writes a 400 and returns false when the address cannot be
// determined, which does not happen for a real TCP peer.
func (a *api) clientIP(w http.ResponseWriter, r *http.Request) (netip.Addr, bool) {
	ip := httpx.ClientIP(r, a.d.Cfg.TrustedProxies)
	if !ip.IsValid() {
		writeError(w, http.StatusBadRequest, codeBadRequest, "cannot determine the client address")
		return netip.Addr{}, false
	}
	return ip, true
}

// sessionCookieName is __Host-ferricade_session, or ferricade_session in
// DEV_INSECURE mode, where the cookie cannot be Secure.
func sessionCookieName(cfg config.Config) string {
	if cfg.DevInsecure {
		return "ferricade_session"
	}
	return "__Host-ferricade_session"
}

// setSessionCookie uses the session's stored persistence and remaining lifetime. The cookie is
// HttpOnly, SameSite=Strict, Path=/ and Secure (except in DEV_INSECURE mode).
func (a *api) setSessionCookie(w http.ResponseWriter, token string, sess auth.Session) {
	maxAge := 0
	if sess.Persistent {
		maxAge = int(sess.ExpiresAt.Sub(a.now()) / time.Second)
		if maxAge <= 0 {
			maxAge = -1 // Do not turn an expired persistent session into a browser cookie.
		}
	}
	http.SetCookie(w, a.sessionCookie(token, maxAge))
}

func (a *api) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, a.sessionCookie("", -1))
}

func (a *api) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookieName(a.d.Cfg),
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		Secure:   !a.d.Cfg.DevInsecure,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	}
}
