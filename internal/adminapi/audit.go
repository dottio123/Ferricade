package adminapi

import (
	"errors"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/store/db"
)

type auditJSON struct {
	ID          uuid.UUID      `json:"id"`
	At          time.Time      `json:"at"`
	ActorUserID *uuid.UUID     `json:"actor_user_id"`
	ActorIP     netip.Addr     `json:"actor_ip"`
	Action      string         `json:"action"`
	TargetType  string         `json:"target_type"`
	TargetID    string         `json:"target_id"`
	Details     map[string]any `json:"details"`
}

// listAudit handles GET /audit?action=&actor=&target=&since=&until=, newest
// first. since is inclusive and until exclusive, both RFC 3339.
func (a *api) listAudit(w http.ResponseWriter, r *http.Request) {
	var f audit.Filter
	var ok bool
	if f.Action, ok = queryText(w, r, "action"); !ok {
		return
	}
	if f.TargetID, ok = queryText(w, r, "target"); !ok {
		return
	}
	if scope := scopeOf(userFrom(r.Context())); scope != nil {
		f.ActorUserID = scope
		// A demoted admin must not read the entries of their old role.
		f.OwnKindsOnly = true
	} else {
		if f.ActorUserID, ok = queryUUID(w, r, "actor"); !ok {
			return
		}
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
	entries, next, err := audit.List(r.Context(), db.New(a.d.Pool), f)
	if errors.Is(err, audit.ErrInvalidCursor) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid cursor")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := listJSON[auditJSON]{Items: make([]auditJSON, len(entries)), NextCursor: next}
	for i, e := range entries {
		out.Items[i] = auditJSON(e)
	}
	writeJSON(w, http.StatusOK, out)
}

// queryTime returns the RFC 3339 query parameter name, the zero time when it
// is absent; a malformed value writes 400.
func queryTime(w http.ResponseWriter, r *http.Request, name string) (time.Time, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return time.Time{}, true
	}
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, name+" must be an RFC 3339 time")
		return time.Time{}, false
	}
	return t.UTC(), true
}
