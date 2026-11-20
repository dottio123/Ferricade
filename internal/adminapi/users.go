package adminapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Roles and statuses of users.
const (
	roleOwner      = "owner"
	roleAdmin      = "admin"
	roleUser       = "user"
	statusActive   = "active"
	statusDisabled = "disabled"
)

// Audit actions written by the user endpoints.
const (
	actionUserCreated       = "user.created"
	actionUserUpdated       = "user.updated"
	actionUserTOTPReset     = "user.totp_reset"
	actionUserPasswordReset = "user.password_reset"
)

// Page sizes of GET /users.
const (
	defaultUserLimit = 50
	maxUserLimit     = 200
)

var errOwnerTOTP = &apiError{http.StatusBadRequest, codeBadRequest, "an owner must use TOTP; totp_required cannot be false"}

// listUsers handles GET /users: users by username, case-insensitively.
func (a *api) listUsers(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := page(w, r)
	if !ok {
		return
	}
	if limit == 0 {
		limit = defaultUserLimit
	}
	limit = min(limit, maxUserLimit)
	p := db.ListUsersParams{RowLimit: int32(limit + 1)}
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || len(raw) == 0 || !utf8.Valid(raw) || strings.ContainsRune(string(raw), 0) {
			writeError(w, http.StatusBadRequest, codeBadRequest, "invalid cursor")
			return
		}
		after := string(raw)
		p.AfterUsername = &after
	}
	rows, err := db.New(a.d.Pool).ListUsers(r.Context(), p)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("list users: %w", err))
		return
	}
	out := listJSON[userJSON]{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(rows[limit-1].Username))
	}
	out.Items = make([]userJSON, len(rows))
	for i, row := range rows {
		out.Items[i] = toUserJSON(auth.UserFromRow(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// createUser handles POST /users. An owner always has totp_required.
func (a *api) createUser(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Username     string `json:"username"`
		Password     string `json:"password"`
		DisplayName  string `json:"display_name"`
		Email        string `json:"email"`
		Role         string `json:"role"`
		TOTPRequired bool   `json:"totp_required"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := auth.ValidateUsername(req.Username); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	if req.Role != roleOwner && req.Role != roleAdmin && req.Role != roleUser {
		writeError(w, http.StatusBadRequest, codeBadRequest, "role must be owner, admin or user")
		return
	}
	if err := setup.ValidateProfile(req.DisplayName, req.Email); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	if len(req.Password) > maxPasswordBytes {
		writeError(w, http.StatusBadRequest, codeBadRequest, fmt.Sprintf("password must be at most %d bytes", maxPasswordBytes))
		return
	}
	if err := auth.ValidatePassword(req.Username, req.Password); err != nil {
		writeError(w, http.StatusBadRequest, codeWeakPassword, err.Error())
		return
	}
	if req.Role == roleOwner {
		req.TOTPRequired = true
	}
	ctx := r.Context()
	hash, err := auth.HashPassword(ctx, req.Password, a.d.Params)
	if errors.Is(err, auth.ErrBusy) {
		writeBusy(w)
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	var row db.User
	err = store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		var err error
		row, err = q.CreateUser(ctx, db.CreateUserParams{
			Username: req.Username, DisplayName: req.DisplayName, Email: req.Email,
			Role: req.Role, PasswordHash: &hash, TOTPRequired: req.TOTPRequired,
		})
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" { // unique_violation on username
			return &apiError{http.StatusConflict, codeUsernameTaken, "username is already taken"}
		}
		if err != nil {
			return fmt.Errorf("create user: %w", err)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionUserCreated,
			TargetType: targetUser, TargetID: row.ID.String(),
			Details: map[string]any{"username": row.Username, "role": row.Role, "totp_required": row.TOTPRequired},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusCreated, toUserJSON(auth.UserFromRow(row)))
}

// patchUser handles PATCH /users/{id}. The change is refused (409
// last_owner) when it would leave no active owner: the active owners are
// counted, and their rows locked, in the change's transaction before the
// update. Disabling a user ends their sessions in the same transaction.
func (a *api) patchUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		DisplayName  *string `json:"display_name"`
		Email        *string `json:"email"`
		Role         *string `json:"role"`
		Status       *string `json:"status"`
		TOTPRequired *bool   `json:"totp_required"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Role != nil && *req.Role != roleOwner && *req.Role != roleAdmin && *req.Role != roleUser {
		writeError(w, http.StatusBadRequest, codeBadRequest, "role must be owner, admin or user")
		return
	}
	if req.Status != nil && *req.Status != statusActive && *req.Status != statusDisabled {
		writeError(w, http.StatusBadRequest, codeBadRequest, "status must be active or disabled")
		return
	}
	if err := setup.ValidateProfile(deref(req.DisplayName), deref(req.Email)); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	var row db.User
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		owners, err := q.CountActiveOwners(ctx) // locks the active owners until commit
		if err != nil {
			return fmt.Errorf("count owners: %w", err)
		}
		cur, err := q.GetUserByIDForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("get user: %w", err)
		}
		next := db.UpdateUserProfileParams{
			ID: id, DisplayName: cur.DisplayName, Email: cur.Email, Role: cur.Role,
			Status: cur.Status, TOTPRequired: cur.TOTPRequired,
		}
		if req.DisplayName != nil {
			next.DisplayName = *req.DisplayName
		}
		if req.Email != nil {
			next.Email = *req.Email
			next.EmailEdited = true
		}
		if req.Role != nil {
			next.Role = *req.Role
		}
		if req.Status != nil {
			next.Status = *req.Status
		}
		if req.TOTPRequired != nil {
			next.TOTPRequired = *req.TOTPRequired
		}
		// An owner must use TOTP: promotion turns it on, and it cannot be
		// turned off for an owner.
		if next.Role == roleOwner {
			if req.TOTPRequired != nil && !*req.TOTPRequired {
				return errOwnerTOTP
			}
			if cur.Role != roleOwner {
				next.TOTPRequired = true
			}
		}
		wasOwner := cur.Role == roleOwner && cur.Status == statusActive
		staysOwner := next.Role == roleOwner && next.Status == statusActive
		if wasOwner && !staysOwner && owners <= 1 {
			return &apiError{http.StatusConflict, codeLastOwner, "this would leave no active owner"}
		}
		if row, err = q.UpdateUserProfile(ctx, next); err != nil {
			return fmt.Errorf("update user: %w", err)
		}
		if cur.Role != next.Role && (cur.Role == roleUser || next.Role == roleUser) {
			if err := q.DeleteUserGrants(ctx, id); err != nil {
				return fmt.Errorf("delete user grants: %w", err)
			}
			if err := q.NotifyGrantsChanged(ctx, id); err != nil {
				return fmt.Errorf("notify grants changed: %w", err)
			}
		}
		if cur.Status == statusActive && next.Status == statusDisabled {
			if err := a.d.Sessions.DeleteForUser(ctx, q, id); err != nil {
				return err
			}
		}
		if !cur.TOTPRequired && next.TOTPRequired && cur.TOTPSecretEnc == nil {
			if err := q.NotifyGrantsChanged(ctx, id); err != nil {
				return fmt.Errorf("notify MFA requirement: %w", err)
			}
		}
		before, after := map[string]any{}, map[string]any{}
		changed := func(name string, old, new any) {
			if old != new {
				before[name], after[name] = old, new
			}
		}
		changed("display_name", cur.DisplayName, next.DisplayName)
		changed("email", cur.Email, next.Email)
		changed("role", cur.Role, next.Role)
		changed("status", cur.Status, next.Status)
		changed("totp_required", cur.TOTPRequired, next.TOTPRequired)
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionUserUpdated,
			TargetType: targetUser, TargetID: id.String(),
			Details: map[string]any{"before": before, "after": after},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, toUserJSON(auth.UserFromRow(row)))
}

// resetUserTOTP handles POST /users/{id}/reset-totp: the user's TOTP secret
// is removed and their sessions end, so their next sign-in must enroll again
// when TOTP is required. Like patchUser, it locks the active owners before the
// target row, so the two cannot deadlock on an owner's row.
func (a *api) resetUserTOTP(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var row db.User
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		// Same lock order as patchUser: the active owners (the actor among
		// them, whose row the audit insert references), then the target.
		if _, err := q.CountActiveOwners(ctx); err != nil {
			return fmt.Errorf("lock owners: %w", err)
		}
		cur, err := q.GetUserByIDForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("get user: %w", err)
		}
		if err := q.SetTOTP(ctx, db.SetTOTPParams{ID: id, TOTPSecretEnc: nil}); err != nil {
			return fmt.Errorf("clear totp: %w", err)
		}
		if err := a.d.Sessions.DeleteForUser(ctx, q, id); err != nil {
			return err
		}
		row = cur
		row.TOTPSecretEnc = nil
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionUserTOTPReset,
			TargetType: targetUser, TargetID: id.String(),
			Details: map[string]any{"was_enrolled": cur.TOTPSecretEnc != nil},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, toUserJSON(auth.UserFromRow(row)))
}

// resetUserPassword handles POST /users/{id}/password: an owner sets another
// account's password. The account's sessions end and its sign-in lockout
// clears, so the new password works at once; TOTP is untouched. The username
// the password is checked against comes from the locked row, so an unknown id
// is 404 before any password rule applies; the lock order is resetUserTOTP's.
func (a *api) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	if len(req.Password) > maxPasswordBytes {
		writeError(w, http.StatusBadRequest, codeBadRequest, fmt.Sprintf("password must be at most %d bytes", maxPasswordBytes))
		return
	}
	if id == act.UserID {
		writeError(w, http.StatusBadRequest, codeBadRequest, "change your own password under User settings")
		return
	}
	ctx := r.Context()
	var row db.User
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		if _, err := q.CountActiveOwners(ctx); err != nil {
			return fmt.Errorf("lock owners: %w", err)
		}
		cur, err := q.GetUserByIDForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("get user: %w", err)
		}
		if err := auth.ValidatePassword(cur.Username, req.Password); err != nil {
			return &apiError{http.StatusBadRequest, codeWeakPassword, err.Error()}
		}
		hash, err := auth.HashPassword(ctx, req.Password, a.d.Params)
		if errors.Is(err, auth.ErrBusy) {
			return err
		}
		if err != nil {
			return fmt.Errorf("hash password: %w", err)
		}
		if err := q.SetPasswordHash(ctx, db.SetPasswordHashParams{ID: id, PasswordHash: &hash}); err != nil {
			return fmt.Errorf("store password: %w", err)
		}
		if err := q.UnlockUser(ctx, id); err != nil {
			return fmt.Errorf("clear lockout: %w", err)
		}
		if err := a.d.Sessions.DeleteForUser(ctx, q, id); err != nil {
			return err
		}
		row = cur
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionUserPasswordReset,
			TargetType: targetUser, TargetID: id.String(),
			Details: map[string]any{},
		})
	})
	if errors.Is(err, auth.ErrBusy) {
		writeBusy(w)
		return
	}
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, toUserJSON(auth.UserFromRow(row)))
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
