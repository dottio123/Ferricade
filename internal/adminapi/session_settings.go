package adminapi

import (
	"context"
	"net/http"
	"time"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type sessionSettingsJSON struct {
	Lifetime  string           `json:"lifetime"`
	UpdatedAt *time.Time       `json:"updated_at"`
	UpdatedBy *deploymentActor `json:"updated_by"`
}

func (a *api) sessionSettingsResponse(ctx context.Context, q *db.Queries, row db.SessionSetting) (sessionSettingsJSON, error) {
	out := sessionSettingsJSON{Lifetime: row.Lifetime, UpdatedAt: row.UpdatedAt}
	if row.UpdatedBy != nil {
		actor, err := a.policyActorWithQueries(ctx, q, row.UpdatedBy)
		if err != nil {
			return out, err
		}
		out.UpdatedBy = actor
	}
	return out, nil
}

func (a *api) getSessionSettings(w http.ResponseWriter, r *http.Request) {
	q := db.New(a.d.Pool)
	row, err := q.GetSessionSettings(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out, err := a.sessionSettingsResponse(r.Context(), q, row)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) putSessionSettings(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Lifetime string `json:"lifetime"`
	}
	if !decode(w, r, &req) {
		return
	}
	duration, rank, ok := auth.SessionLifetime(req.Lifetime)
	if !ok {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid lifetime")
		return
	}
	ctx := r.Context()
	var out sessionSettingsJSON
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		row, err := q.GetSessionSettingsForUpdate(ctx)
		if err != nil {
			return err
		}
		if row.Lifetime != req.Lifetime {
			before := row.Lifetime
			_, oldRank, _ := auth.SessionLifetime(before)
			now := a.now()
			row, err = q.UpdateSessionSettings(ctx, db.UpdateSessionSettingsParams{
				Lifetime: req.Lifetime, UpdatedAt: &now, UpdatedBy: &act.UserID,
			})
			if err != nil {
				return err
			}
			if err := audit.Record(ctx, q, audit.Event{
				ActorUserID: &act.UserID, ActorIP: act.IP, Action: "session_lifetime.changed",
				TargetType: "settings", TargetID: "sessions",
				Details: map[string]any{"before": before, "after": req.Lifetime},
			}); err != nil {
				return err
			}
			// The settings update and audit acquire user FK locks before sessions,
			// matching user-management handlers' users -> sessions lock order.
			if rank < oldRank {
				if err := q.CapSessionLifetimes(ctx, db.CapSessionLifetimesParams{
					Seconds: int64(duration / time.Second), Browser: req.Lifetime == "browser",
				}); err != nil {
					return err
				}
			}
		}
		out, err = a.sessionSettingsResponse(ctx, q, row)
		return err
	})
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
