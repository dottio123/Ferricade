// Package clientapi serves the RustDesk client API: heartbeat and sysinfo
// (enrollment), audit/conn (session history), plus the health probe. Every
// other /api/ path is a JSON 404.
package clientapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/httpx"
	"github.com/dottio123/ferricade/internal/idalarms"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/sessions"
)

const (
	maxBody    = 64 << 10 // request body cap
	limitRate  = 20       // requests per second per client IP
	limitBurst = 40
)

// SetupState tells the client API whether the console is set up.
type SetupState interface {
	// ServerID returns the server profile the client API serves, and false
	// until setup is complete.
	ServerID() (uuid.UUID, bool)
}

// Deps are what the client API needs.
type Deps struct {
	Devices *devices.Service
	// Sessions records session history. When nil, audit/conn stores nothing
	// and heartbeats do not sync conns.
	Sessions *sessions.Service
	Policies *policies.Service
	IDAlarms *idalarms.Service
	Setup    SetupState
	Trusted  []netip.Prefix // proxies whose X-Forwarded-For is believed
	// Log receives the client API's logs; nil means slog.Default().
	Log *slog.Logger
	// Now is the clock of the rejection log's rate limit; nil means time.Now.
	Now func() time.Time
}

// Routes returns the client API router, to be mounted at "/".
func Routes(d Deps) chi.Router {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	h := &handler{d: d, rejects: newRejectLog(d.Log, d.Now)}
	r := chi.NewRouter()
	r.Use(httpx.RequestID, h.accessLog)
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	r.Route("/api", func(r chi.Router) {
		r.Use(limitBody, httpx.RateLimit(limitRate, limitBurst,
			func(r *http.Request) netip.Addr { return httpx.ClientIP(r, d.Trusted) },
			func(w http.ResponseWriter, _ *http.Request) {
				wire.WriteError(w, http.StatusTooManyRequests, "rate limited")
			}))
		r.Post("/heartbeat", h.heartbeat)
		r.Post("/sysinfo", h.sysinfo)
		r.Post("/audit/conn", h.auditConn)
		r.Post("/audit/alarm", h.auditAlarm)
		r.NotFound(notFound)
		r.MethodNotAllowed(notFound)
	})
	return r
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	wire.WriteError(w, http.StatusNotFound, "not found")
}

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		next.ServeHTTP(w, r)
	})
}

type handler struct {
	d       Deps
	rejects *rejectLog // refused audit/conn records
}

type clientLogMetaKey struct{}

type clientLogMeta struct {
	rustdeskID string
}

func setClientLogID(ctx context.Context, id string) {
	if m, ok := ctx.Value(clientLogMetaKey{}).(*clientLogMeta); ok {
		m.rustdeskID = id
	}
}

func (h *handler) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := h.d.Now()
		meta := &clientLogMeta{}
		sw := httpx.NewStatusWriter(w)
		r = r.WithContext(context.WithValue(r.Context(), clientLogMetaKey{}, meta))
		next.ServeHTTP(sw, r)

		path := ""
		if rc := chi.RouteContext(r.Context()); rc != nil {
			path = rc.RoutePattern()
		}
		if path == "" {
			path = r.URL.Path
		}
		status := sw.Status()
		level := slog.LevelDebug
		switch {
		case status == http.StatusNotFound, status == http.StatusMethodNotAllowed, status == http.StatusTooManyRequests:
			level = slog.LevelDebug
		case status >= 400, path == "/api/sysinfo", strings.HasPrefix(path, "/api/audit/"):
			level = slog.LevelInfo
		}
		ipStr := ""
		if ip := httpx.ClientIP(r, h.d.Trusted); ip.IsValid() {
			ipStr = ip.String()
		}
		attrs := []any{
			"method", r.Method,
			"path", path,
			"status", status,
			"duration_ms", h.d.Now().Sub(start).Milliseconds(),
			"ip", ipStr,
			"request_id", httpx.RequestIDFrom(r.Context()),
		}
		if meta.rustdeskID != "" {
			attrs = append(attrs, "rustdesk_id", clipID(meta.rustdeskID))
		}
		h.d.Log.Log(r.Context(), level, "client request", attrs...)
	})
}

// readBody reads the whole request body whatever its Content-Type. It writes
// the error response itself and returns false when the body is too large or
// cannot be read.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			wire.WriteError(w, http.StatusRequestEntityTooLarge, "body too large")
		} else {
			wire.WriteError(w, http.StatusBadRequest, "bad request")
		}
		return nil, false
	}
	return b, true
}

// hasNUL reports whether any string in the JSON document b, object keys
// included, holds a NUL character. Postgres text and jsonb cannot store one,
// so such a body is refused as a bad request rather than failing later.
func hasNUL(b []byte) bool {
	if !bytes.Contains(b, []byte(`\u0000`)) { // JSON can only spell NUL this way
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := dec.Token()
		if err != nil {
			return false
		}
		if s, ok := tok.(string); ok && strings.ContainsRune(s, 0) {
			return true
		}
	}
}

func writeSysinfoUpdated(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(wire.SysinfoUpdated))
}

func (h *handler) heartbeat(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	serverID, ready := h.d.Setup.ServerID()
	if !ready {
		wire.WriteJSON(w, http.StatusOK, wire.HeartbeatResponse{})
		return
	}
	var hb wire.HeartbeatRequest
	if err := json.Unmarshal(body, &hb); err != nil || hb.ID == "" || hb.UUID == "" || len(hb.ID) > 64 || len(hb.UUID) > 128 || len(hb.Conns) > 256 || hasNUL(body) {
		wire.WriteError(w, http.StatusBadRequest, "bad request")
		return
	}
	setClientLogID(r.Context(), hb.ID)
	reqID := httpx.RequestIDFrom(r.Context())
	resp, deviceID, err := h.d.Devices.HeartbeatWithDeviceID(r.Context(), serverID, hb, httpx.ClientIP(r, h.d.Trusted))
	if err != nil {
		h.d.Log.Error("client api: heartbeat", "request_id", reqID, "err", err)
		wire.WriteError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if h.d.Sessions != nil && deviceID != uuid.Nil {
		// The heartbeat itself succeeded; a failed sync is retried by the
		// next one, so the client is not told.
		disconnect, err := h.d.Sessions.SyncConnsForDevice(r.Context(), deviceID, hb.UUID, hb.Conns)
		if err != nil {
			h.d.Log.Error("client api: sync conns", "request_id", reqID, "err", err)
		} else {
			resp.Disconnect = disconnect
		}
	}
	if h.d.Policies != nil && deviceID != uuid.Nil {
		strategy, version, err := h.d.Policies.StrategyForDevice(r.Context(), deviceID, hb.UUID, hb.ModifiedAt)
		if err != nil {
			h.d.Log.Error("client api: strategy", "request_id", reqID, "err", err)
		} else {
			resp.Strategy, resp.ModifiedAt = strategy, version
		}
	}
	wire.WriteJSON(w, http.StatusOK, resp)
}

// auditConn handles POST /api/audit/conn. The client expects an empty body on
// success, whether or not the record was stored.
func (h *handler) auditConn(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	serverID, ready := h.d.Setup.ServerID()
	if !ready || h.d.Sessions == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	var a wire.ConnAudit
	reqID := httpx.RequestIDFrom(r.Context())
	if reason := connAuditProblem(body, &a); reason != "" {
		id := a.ID
		if reason == "bad_json" {
			id = "" // whatever was decoded before the error is not to be trusted
		}
		setClientLogID(r.Context(), id)
		h.rejects.reject("client api: rejected audit/conn", reason, id, httpx.ClientIP(r, h.d.Trusted).String(), reqID)
		wire.WriteError(w, http.StatusBadRequest, "bad request")
		return
	}
	setClientLogID(r.Context(), a.ID)
	if err := h.d.Sessions.Ingest(r.Context(), serverID, a, httpx.ClientIP(r, h.d.Trusted)); err != nil {
		h.d.Log.Error("client api: audit conn", "request_id", reqID, "err", err)
		wire.WriteError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (h *handler) auditAlarm(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	serverID, ready := h.d.Setup.ServerID()
	if !ready || h.d.IDAlarms == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	var a wire.AlarmAudit
	if json.Unmarshal(body, &a) != nil || hasNUL(body) || a.ID == "" || a.UUID == "" {
		wire.WriteError(w, http.StatusBadRequest, "bad request")
		return
	}
	setClientLogID(r.Context(), a.ID)
	reason := ""
	switch a.Typ {
	case 1:
		reason = "too_many_attempts"
	case 2:
		reason = "too_many_per_minute"
	case 6:
		reason = "ipv6_prefix"
	case 10:
	default:
		w.WriteHeader(http.StatusOK)
		return
	}
	var info struct {
		ID   string `json:"id"`
		IP   string `json:"ip"`
		Name string `json:"name"`
	}
	if json.Unmarshal([]byte(a.Info), &info) != nil || info.ID == "" || hasNUL([]byte(a.Info)) {
		wire.WriteError(w, http.StatusBadRequest, "bad request")
		return
	}
	if len([]rune(info.ID)) > 64 {
		w.WriteHeader(http.StatusOK)
		return
	}
	if err := h.d.IDAlarms.Record(r.Context(), idalarms.Alarm{
		ServerID: serverID, DeviceID: a.ID, DeviceUUID: a.UUID,
		BlockedID: info.ID, BlockedIP: truncateRunes(info.IP, 64), BlockedName: truncateRunes(info.Name, 128),
		Reason:  reason,
		ActorIP: httpx.ClientIP(r, h.d.Trusted),
	}); err != nil {
		h.d.Log.Error("client api: audit alarm", "request_id", httpx.RequestIDFrom(r.Context()), "err", err)
		wire.WriteError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusOK)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

// connAuditProblem decodes body into a and returns why the record must be
// refused, or "" when it is acceptable.
func connAuditProblem(body []byte, a *wire.ConnAudit) string {
	switch {
	case json.Unmarshal(body, a) != nil:
		return "bad_json"
	case a.ID == "":
		return "missing_id"
	case a.UUID == "":
		return "missing_uuid"
	case a.Nonce == "":
		return "missing_nonce"
	case len(a.Nonce) > sessions.MaxNonceLen:
		return "nonce_too_long"
	case hasNUL(body):
		return "nul"
	}
	return ""
}

func (h *handler) sysinfo(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	serverID, ready := h.d.Setup.ServerID()
	if !ready {
		writeSysinfoUpdated(w)
		return
	}
	si, err := wire.ParseSysinfo(body)
	if err != nil || si.ID == "" || si.UUID == "" || !validSysinfo(si) || hasNUL(body) {
		wire.WriteError(w, http.StatusBadRequest, "bad request")
		return
	}
	setClientLogID(r.Context(), si.ID)
	if err := h.d.Devices.Sysinfo(r.Context(), serverID, si, httpx.ClientIP(r, h.d.Trusted)); err != nil {
		h.d.Log.Error("client api: sysinfo", "request_id", httpx.RequestIDFrom(r.Context()), "err", err)
		wire.WriteError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeSysinfoUpdated(w)
}

func validSysinfo(si wire.SysinfoRequest) bool {
	if len(si.ID) > 64 || len(si.UUID) > 128 || len(si.Version) > 1024 || len(si.Hostname) > 1024 || len(si.OS) > 1024 || len(si.CPU) > 1024 || len(si.Memory) > 1024 || len(si.Username) > 1024 || len(si.Presets) > 64 {
		return false
	}
	for key, value := range si.Presets {
		if len(key) > 1024 || len(value) > 1024 {
			return false
		}
	}
	return true
}
