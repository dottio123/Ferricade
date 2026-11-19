package adminapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/oidc"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func (a *api) oidcResponse(s oidc.Settings) any {
	return struct {
		oidc.Settings
		RedirectURI string `json:"redirect_uri"`
	}{s, strings.TrimSuffix(a.d.Cfg.PublicURL.String(), "/") + "/admin/api/v1/auth/oidc/callback"}
}

func (a *api) getOIDCSettings(w http.ResponseWriter, r *http.Request) {
	s, err := oidc.Load(r.Context(), db.New(a.d.Pool), a.d.Sealer)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.oidcResponse(s))
}

func (a *api) patchOIDCSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var patch oidc.Patch
	if !decode(w, r, &patch) {
		return
	}
	var saved oidc.Settings
	err := store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		var err error
		saved, _, err = oidc.Save(r.Context(), q, a.d.Sealer, patch, actor, a.d.Cfg.DevInsecure)
		return err
	})
	if ve, ok := oidc.IsValidation(err); ok {
		writeError(w, http.StatusBadRequest, codeBadRequest, ve.Error())
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.oidcResponse(saved))
}

func (a *api) testOIDCSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	s, err := oidc.Load(r.Context(), db.New(a.d.Pool), a.d.Sealer)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if s.Issuer == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "issuer is required")
		return
	}
	result := oidc.Discover(r.Context(), a.d.OIDCClient, s.Issuer, a.now())
	raw, err := json.Marshal(result)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	err = store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		if err := q.SetOIDCTestResult(r.Context(), db.SetOIDCTestResultParams{LastTestAt: &result.TestedAt, LastTestResult: raw}); err != nil {
			return fmt.Errorf("store oidc test: %w", err)
		}
		return audit.Record(r.Context(), q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP, Action: "settings.oidc_updated", TargetType: "settings", TargetID: "oidc", Details: map[string]any{"changed": []string{"last_test"}}})
	})
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("store oidc test: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) getUserAvatar(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if scope := scopeOf(userFrom(r.Context())); scope != nil && id != *scope {
		notFound(w, r)
		return
	}
	row, err := db.New(a.d.Pool).GetUserAvatar(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && len(row.Avatar) == 0) {
		notFound(w, r)
		return
	}
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get avatar: %w", err))
		return
	}
	if row.AvatarType == nil {
		notFound(w, r)
		return
	}
	w.Header().Set("Content-Type", *row.AvatarType)
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(row.Avatar)
}

func (a *api) unlinkUserOIDC(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var row db.User
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		// Keep the same lock order as user profile edits.
		if _, err := q.CountActiveOwners(ctx); err != nil {
			return fmt.Errorf("lock owners: %w", err)
		}
		var err error
		row, err = q.GetUserByIDForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("get user: %w", err)
		}
		if row.OidcIssuer == nil {
			return nil
		}
		if row.PasswordHash == nil {
			return &apiError{http.StatusConflict, "no_password", "cannot unlink a user without a password"}
		}
		row, err = q.UnlinkUserOIDC(ctx, id)
		if err != nil {
			return fmt.Errorf("unlink user: %w", err)
		}
		if err := a.d.Sessions.DeleteForUser(ctx, q, id); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP, Action: "user.oidc_unlinked", TargetType: targetUser, TargetID: id.String()})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, toUserJSON(auth.UserFromRow(row)))
}
