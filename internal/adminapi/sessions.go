package adminapi

import (
	"errors"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/sessions"
)

type sessionJSON struct {
	ID                    uuid.UUID   `json:"id"`
	DeviceID              uuid.UUID   `json:"device_id"`
	DeviceName            string      `json:"device_name"`
	RustdeskID            string      `json:"rustdesk_id"`
	PeerRustdeskID        string      `json:"peer_rustdesk_id"`
	PeerName              string      `json:"peer_name"`
	Type                  string      `json:"type"`
	ClientIP              *netip.Addr `json:"client_ip"`
	StartedAt             time.Time   `json:"started_at"`
	AuthedAt              *time.Time  `json:"authed_at"`
	EndedAt               *time.Time  `json:"ended_at"`
	EndReason             *string     `json:"end_reason"`
	DisconnectRequestedAt *time.Time  `json:"disconnect_requested_at"`
	DurationSeconds       int64       `json:"duration_seconds"`
}

// listSessions handles GET /sessions?device_id=&active=&authenticated=&since=&until=,
// newest first. since is inclusive and until exclusive, on the start time.
func (a *api) listSessions(w http.ResponseWriter, r *http.Request) {
	var f sessions.Filter
	var ok bool
	if f.DeviceID, ok = queryUUID(w, r, "device_id"); !ok {
		return
	}
	if f.Active, ok = queryBool(w, r, "active"); !ok {
		return
	}
	if f.Authenticated, ok = queryBool(w, r, "authenticated"); !ok {
		return
	}
	if f.Since, ok = queryTime(w, r, "since"); !ok {
		return
	}
	if f.Until, ok = queryTime(w, r, "until"); !ok {
		return
	}
	if f.Limit, f.Cursor, ok = page(w, r); !ok {
		return
	}
	f.ScopeUser = scopeOf(userFrom(r.Context()))
	list, next, err := a.d.RemoteSessions.List(r.Context(), f)
	if errors.Is(err, sessions.ErrInvalidCursor) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid cursor")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := listJSON[sessionJSON]{Items: make([]sessionJSON, len(list)), NextCursor: next}
	isUser := f.ScopeUser != nil
	for i, s := range list {
		out.Items[i] = sessionJSON{
			ID: s.ID, DeviceID: s.DeviceID, DeviceName: s.DeviceName, RustdeskID: s.RustdeskID,
			PeerRustdeskID: s.PeerRustdeskID, PeerName: s.PeerName, Type: s.Type, ClientIP: s.ClientIP,
			StartedAt: s.StartedAt, AuthedAt: s.AuthedAt, EndedAt: s.EndedAt, EndReason: s.EndReason,
			DisconnectRequestedAt: s.DisconnectRequestedAt,
			DurationSeconds:       s.DurationSeconds,
		}
		if isUser {
			out.Items[i].ClientIP = nil // other people's addresses
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// queryBool reads the optional true|false query parameter name: nil when it
// is absent. It answers 400 itself for any other value.
func queryBool(w http.ResponseWriter, r *http.Request, name string) (*bool, bool) {
	switch v := r.URL.Query().Get(name); v {
	case "":
		return nil, true
	case "true", "false":
		b := v == "true"
		return &b, true
	default:
		writeError(w, http.StatusBadRequest, codeBadRequest, name+" must be true or false")
		return nil, false
	}
}

type dayStatsJSON struct {
	Day          string `json:"day"`
	Count        int64  `json:"count"`
	TotalSeconds int64  `json:"total_seconds"`
}

type deviceStatsJSON struct {
	DeviceID     uuid.UUID `json:"device_id"`
	DeviceName   string    `json:"device_name"`
	Count        int64     `json:"count"`
	TotalSeconds int64     `json:"total_seconds"`
}

type sessionStatsJSON struct {
	Range          string            `json:"range"`
	TZ             string            `json:"tz"`
	PerDay         []dayStatsJSON    `json:"per_day"`
	AverageSeconds int64             `json:"average_seconds"`
	TopDevices     []deviceStatsJSON `json:"top_devices"`
}

// sessionStats handles GET /sessions/stats?range=7d|30d&tz=<IANA zone>. The
// range defaults to 7d and the zone to UTC.
func (a *api) sessionStats(w http.ResponseWriter, r *http.Request) {
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "7d"
	}
	tz, ok := queryText(w, r, "tz")
	if !ok {
		return
	}
	loc := time.UTC
	if tz != "" {
		var err error
		// "Local" is the server's zone, which is not the caller's to name.
		if loc, err = time.LoadLocation(tz); err != nil || tz == "Local" {
			writeError(w, http.StatusBadRequest, codeBadRequest, "tz must be an IANA time zone name")
			return
		}
	}
	st, err := a.d.RemoteSessions.Stats(r.Context(), rng, loc, scopeOf(userFrom(r.Context())))
	if errors.Is(err, sessions.ErrInvalidRange) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "range must be 7d or 30d")
		return
	}
	if errors.Is(err, sessions.ErrUnknownZone) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "unknown time zone")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := sessionStatsJSON{
		Range: st.Range, TZ: st.TZ, AverageSeconds: st.AverageSeconds,
		PerDay:     make([]dayStatsJSON, len(st.PerDay)),
		TopDevices: make([]deviceStatsJSON, len(st.TopDevices)),
	}
	for i, d := range st.PerDay {
		out.PerDay[i] = dayStatsJSON(d)
	}
	for i, d := range st.TopDevices {
		out.TopDevices[i] = deviceStatsJSON(d)
	}
	writeJSON(w, http.StatusOK, out)
}

// codeSessionEnded is the 409 for a disconnect request on a session that has
// already ended.
const codeSessionEnded = "session_ended"

// disconnectSession handles POST /sessions/{id}/disconnect. The request is
// stored and delivered with the device's next heartbeat, so the answer is 202
// with the session, not proof that it is gone.
func (a *api) disconnectSession(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	s, err := a.d.RemoteSessions.RequestDisconnect(r.Context(), act, id)
	switch {
	case errors.Is(err, sessions.ErrNotFound):
		notFound(w, r)
		return
	case errors.Is(err, sessions.ErrEnded):
		writeError(w, http.StatusConflict, codeSessionEnded, "the session has already ended")
		return
	case err != nil:
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, sessionJSON{
		ID: s.ID, DeviceID: s.DeviceID, DeviceName: s.DeviceName, RustdeskID: s.RustdeskID,
		PeerRustdeskID: s.PeerRustdeskID, PeerName: s.PeerName, Type: s.Type, ClientIP: s.ClientIP,
		StartedAt: s.StartedAt, AuthedAt: s.AuthedAt, EndedAt: s.EndedAt, EndReason: s.EndReason,
		DisconnectRequestedAt: s.DisconnectRequestedAt, DurationSeconds: s.DurationSeconds,
	})
}
