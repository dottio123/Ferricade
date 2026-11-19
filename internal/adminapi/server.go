package adminapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/connect"
	"github.com/dottio123/ferricade/internal/servers"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// actionServerUpdated is audited by PATCH /server.
const actionServerUpdated = "server.updated"

type serverJSON struct {
	ID                 uuid.UUID `json:"id"`
	Name               string    `json:"name"`
	IDHost             string    `json:"id_host"`
	RelayHost          string    `json:"relay_host"`
	PublicKey          string    `json:"public_key"`
	APIURL             string    `json:"api_url"`
	LinksIncludeServer bool      `json:"links_include_server"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

func toServerJSON(s db.Server) serverJSON {
	return serverJSON{
		ID: s.ID, Name: s.Name, IDHost: s.IDHost, RelayHost: s.RelayHost, PublicKey: s.PublicKey, APIURL: s.ApiUrl,
		LinksIncludeServer: s.LinksIncludeServer,
		CreatedAt:          s.CreatedAt.UTC(), UpdatedAt: s.UpdatedAt.UTC(),
	}
}

var errNoServer = &apiError{http.StatusNotFound, codeNotFound, "no server profile yet"}

// loadServer returns the server profile, or writes 404 when there is none.
func (a *api) loadServer(w http.ResponseWriter, r *http.Request) (db.Server, bool) {
	srv, err := db.New(a.d.Pool).GetServer(r.Context())
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, errNoServer)
		return srv, false
	}
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get server: %w", err))
		return srv, false
	}
	return srv, true
}

// getServer handles GET /server.
func (a *api) getServer(w http.ResponseWriter, r *http.Request) {
	if srv, ok := a.loadServer(w, r); ok {
		writeJSON(w, http.StatusOK, toServerJSON(srv))
	}
}

// patchServer handles PATCH /server (Owner only). Absent fields keep their
// value; the result is validated as the setup wizard validates it.
func (a *api) patchServer(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Name               *string         `json:"name"`
		IDHost             *string         `json:"id_host"`
		RelayHost          *string         `json:"relay_host"`
		PublicKey          *string         `json:"public_key"`
		APIURL             json.RawMessage `json:"api_url"`
		LinksIncludeServer *bool           `json:"links_include_server"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	var row db.Server
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		cur, err := q.GetServerForUpdate(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoServer
		}
		if err != nil {
			return fmt.Errorf("get server: %w", err)
		}
		pick := func(v *string, old string) string {
			if v != nil {
				return *v
			}
			return old
		}
		p, err := setup.ValidateServer(pick(req.Name, cur.Name), pick(req.IDHost, cur.IDHost),
			pick(req.RelayHost, cur.RelayHost), pick(req.PublicKey, cur.PublicKey))
		if err != nil {
			return err
		}
		apiURLInput := cur.ApiUrl
		if len(req.APIURL) != 0 {
			if string(req.APIURL) == "null" {
				return setup.InputError("api_url must be a string")
			}
			if err := json.Unmarshal(req.APIURL, &apiURLInput); err != nil {
				return setup.InputError("api_url must be a string")
			}
		}
		apiURL, err := connect.ValidateAPIURL(apiURLInput)
		if err != nil {
			return setup.InputError(err.Error())
		}
		linksIncludeServer := cur.LinksIncludeServer
		if req.LinksIncludeServer != nil {
			linksIncludeServer = *req.LinksIncludeServer
		}
		row, err = q.UpdateServer(ctx, db.UpdateServerParams{
			ID: cur.ID, Name: p.Name, IDHost: p.IDHost, RelayHost: p.RelayHost, PublicKey: p.PublicKey, ApiUrl: apiURL,
			LinksIncludeServer: linksIncludeServer,
		})
		if err != nil {
			return fmt.Errorf("update server: %w", err)
		}
		before, after := map[string]any{}, map[string]any{}
		for _, f := range []struct {
			name     string
			old, new any
		}{
			{"name", cur.Name, p.Name}, {"id_host", cur.IDHost, p.IDHost},
			{"relay_host", cur.RelayHost, p.RelayHost}, {"public_key", cur.PublicKey, p.PublicKey}, {"api_url", cur.ApiUrl, apiURL},
			{"links_include_server", cur.LinksIncludeServer, linksIncludeServer},
		} {
			if f.old != f.new {
				before[f.name], after[f.name] = f.old, f.new
			}
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionServerUpdated,
			TargetType: "server", TargetID: cur.ID.String(),
			Details: map[string]any{"before": before, "after": after},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeSetupError(w, r, err) // validation errors, else internal
		}
		return
	}
	writeJSON(w, http.StatusOK, toServerJSON(row))
}

// checkServer handles POST /server/check against the saved profile.
func (a *api) checkServer(w http.ResponseWriter, r *http.Request) {
	srv, ok := a.loadServer(w, r)
	if !ok {
		return
	}
	results := servers.Run(r.Context(), srv.IDHost, srv.RelayHost, connect.ConfiguredAPIAddr(srv.ApiUrl, srv.IDHost, a.d.Cfg.ClientListenAddr), a.d.Cfg.HBBSAddr, a.d.Dial)
	a.d.ServerMonitor.Record(results, a.now())
	checks := make([]checkJSON, len(results))
	for i, c := range results {
		checks[i] = toCheckJSON(c)
	}
	writeJSON(w, http.StatusOK, struct {
		Checks []checkJSON `json:"checks"`
	}{checks})
}

// serverHealth returns the latest completed round without starting a probe.
func (a *api) serverHealth(w http.ResponseWriter, r *http.Request) {
	health := a.d.ServerMonitor.Latest()
	if userFrom(r.Context()).Role == roleUser {
		for i := range health.Checks {
			health.Checks[i].Detail = ""
			health.Checks[i].Target = ""
			health.Checks[i].Address = ""
		}
	}
	writeJSON(w, http.StatusOK, health)
}
