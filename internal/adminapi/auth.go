package adminapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/httpx"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Audit actions written by the auth endpoints.
const (
	actionLogin           = "auth.login"
	actionLoginFailed     = "auth.login_failed"
	actionMFAPassed       = "auth.mfa_passed"
	actionLogout          = "auth.logout"
	actionPasswordChanged = "auth.password_changed"
	actionTOTPEnrolled    = "auth.totp_enrolled"
)

const (
	targetUser = "user"
	// maxAuditUsername bounds the typed username kept in auth.login_failed.
	maxAuditUsername = 64
	// maxLockoutKeyBytes bounds the in-memory key of an unknown username; no
	// real username is longer than 64 bytes.
	maxLockoutKeyBytes = 256
	// maxPasswordBytes bounds a new password.
	maxPasswordBytes = 1024
	// enrollTTL is how long a TOTP secret from /auth/totp/enroll waits for
	// its first code.
	enrollTTL = 10 * time.Minute
)

// The same messages for real and unknown accounts, so responses do not
// reveal which usernames exist.
const (
	msgInvalidLogin = "invalid username or password"
	msgLocked       = "too many failed attempts; try again later"
	msgRateLimited  = "too many failed sign-ins from your address; try again later"
	msgInvalidCode  = "invalid code"
)

// errCodeRejected reports a TOTP code that matched but whose step was already
// used, which happens when the same code is submitted twice concurrently.
var errCodeRejected = errors.New("totp code already used")

type userJSON struct {
	ID           uuid.UUID `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	Email        string    `json:"email"`
	Role         string    `json:"role"`
	Status       string    `json:"status"`
	TOTPRequired bool      `json:"totp_required"`
	SSO          bool      `json:"sso"`
	AvatarURL    *string   `json:"avatar_url"`
}

func toUserJSON(u auth.User) userJSON {
	out := userJSON{
		ID: u.ID, Username: u.Username, DisplayName: u.DisplayName, Email: u.Email,
		Role: u.Role, Status: u.Status, TOTPRequired: u.TOTPRequired, SSO: u.SSO,
	}
	if u.AvatarUpdatedAt != nil {
		url := "/admin/api/v1/users/" + u.ID.String() + "/avatar?v=" + strconv.FormatInt(u.AvatarUpdatedAt.Unix(), 10)
		out.AvatarURL = &url
	}
	return out
}

type csrfResponse struct {
	CSRFToken string `json:"csrf_token"`
}

type codeRequest struct {
	Code string `json:"code"`
}

// login handles POST /auth/login. Failures count against the client address
// (20 in 10 minutes give 429) and, through auth.Login, against the account;
// unknown usernames are counted in memory on the same schedule, so both kinds
// answer 401 and then 423 alike.
func (a *api) login(w http.ResponseWriter, r *http.Request) {
	a.loginWithLookup(w, r, lookupUser)
}

func (a *api) loginWithLookup(w http.ResponseWriter, r *http.Request, lookup func(context.Context, *db.Queries, string) (*db.User, error)) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	att := a.beginIPAttempt(w, ip)
	if att == nil {
		return
	}
	defer att.end()
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	now := a.now()
	q := db.New(a.d.Pool) // not a transaction: failure counts must persist
	known, err := lookup(ctx, q, req.Username)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	ghostKey := unknownUserKey(req.Username)

	var user auth.User
	if known == nil {
		if a.unknownUsers.Locked(ghostKey, now) {
			err = auth.ErrLocked
		} else {
			err = auth.RejectUnknown(ctx, req.Password)
			if errors.Is(err, auth.ErrInvalidCredentials) && a.unknownUsers.Fail(ghostKey, now) {
				err = auth.ErrLocked
			}
		}
	} else {
		user, err = auth.LoginKnown(ctx, q, *known, req.Password, now)
	}

	targetID := ""
	logUser := "(unknown)"
	if known != nil {
		targetID = known.ID.String()
		logUser = known.Username
	}
	switch {
	case err == nil:
		a.startSession(w, r, ip, user)
	case errors.Is(err, auth.ErrBusy):
		// Nothing was verified, so nothing counts against the address.
		writeBusy(w)
	case errors.Is(err, auth.ErrLocked):
		if a.loginFailed(w, r, att, ip, req.Username, logUser, targetID, "locked") {
			writeError(w, http.StatusLocked, codeLocked, msgLocked)
		}
	case errors.Is(err, auth.ErrInvalidCredentials), errors.Is(err, auth.ErrDisabled):
		// A disabled account gets the generic answer: telling it apart would
		// confirm that the password was right.
		reason := "invalid_credentials"
		if errors.Is(err, auth.ErrDisabled) {
			reason = "disabled"
		}
		if a.loginFailed(w, r, att, ip, req.Username, logUser, targetID, reason) {
			writeError(w, http.StatusUnauthorized, codeUnauthenticated, msgInvalidLogin)
		}
	default:
		a.writeInternal(w, r, err)
	}
}

// lookupUser returns the account username names, or nil when there is none.
// Names Postgres text cannot hold are unknown, as in auth.Login.
func lookupUser(ctx context.Context, q *db.Queries, username string) (*db.User, error) {
	if !utf8.ValidString(username) || strings.ContainsRune(username, 0) {
		return nil, nil
	}
	row, err := q.GetUserByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("look up user: %w", err)
	}
	return &row, nil
}

// unknownUserKey is the lockout key of an unknown username: lower-cased, as
// the citext column compares, and bounded in length.
func unknownUserKey(username string) string {
	k := strings.ToLower(username)
	if len(k) > maxLockoutKeyBytes {
		k = k[:maxLockoutKeyBytes]
	}
	return k
}

// ipAttempt is one credential check reserved against the client address's
// failure limit (auth.IPLimiter.Begin), so parallel requests cannot all pass
// the limit before any failure is recorded. end must run exactly once, after
// failed is set for a failed check.
type ipAttempt struct {
	l      *auth.IPLimiter
	key    netip.Addr
	failed bool
}

// beginIPAttempt reserves an attempt from ip, keyed like the client rate
// limit (IPv6 by /64). When the address has reached its limit it writes 429
// and returns nil.
func (a *api) beginIPAttempt(w http.ResponseWriter, ip netip.Addr) *ipAttempt {
	key := httpx.LimitKey(ip)
	if !a.d.IPLimiter.Begin(key) {
		writeError(w, http.StatusTooManyRequests, codeRateLimited, msgRateLimited)
		return nil
	}
	return &ipAttempt{l: a.d.IPLimiter, key: key}
}

func (t *ipAttempt) end() { t.l.End(t.key, t.failed) }

// loginFailed marks att failed, so it counts against the client address, and
// audits the failure. It reports false after writing a 500 when the audit
// cannot be stored. targetID is the account's ID, or "" for an unknown
// username.
func (a *api) loginFailed(w http.ResponseWriter, r *http.Request, att *ipAttempt, ip netip.Addr, username, logUser, targetID, reason string) bool {
	att.failed = true
	e := audit.Event{
		ActorIP: ip, Action: actionLoginFailed, TargetType: targetUser, TargetID: targetID,
		Details: map[string]any{"username": auditUsername(username), "reason": reason},
	}
	if err := audit.Record(r.Context(), db.New(a.d.Pool), e); err != nil {
		a.writeInternal(w, r, err)
		return false
	}
	msg := "sign-in failed"
	if reason == "locked" {
		msg = "sign-in locked"
	}
	a.log.Warn(msg, "user", logUser, "reason", reason, "ip", ip.String(), "request_id", requestIDFrom(r.Context()))
	return true
}

// auditUsername makes a typed username storable in jsonb (no NUL, valid
// UTF-8) and truncates it to 64 characters.
func auditUsername(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "")
	if utf8.RuneCountInString(s) <= maxAuditUsername {
		return s
	}
	return string([]rune(s)[:maxAuditUsername])
}

// startSession creates the session for a correct password, replacing the
// browser's previous session, and answers {mfa_required, csrf_token}.
// mfa_required is true when the session cannot reach the API yet: the user
// must enter a TOTP code, or enroll one first.
func (a *api) startSession(w http.ResponseWriter, r *http.Request, ip netip.Addr, user auth.User) {
	ctx := r.Context()
	mfaRequired := user.TOTPEnrolled || user.TOTPRequired
	var token string
	var sess auth.Session
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		var err error
		token, sess, err = a.d.Sessions.Create(ctx, q, user.ID, ip, r.UserAgent())
		if err != nil {
			return err
		}
		if old, ok := authFrom(ctx); ok {
			if err := a.d.Sessions.Delete(ctx, q, old.token); err != nil {
				return err
			}
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &user.ID, ActorIP: ip, Action: actionLogin, TargetType: targetUser, TargetID: user.ID.String(),
			Details: map[string]any{"mfa_required": mfaRequired},
		})
	})
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.log.Info("sign-in ok", "user", user.Username, "mfa_required", mfaRequired, "ip", ip.String(), "request_id", requestIDFrom(ctx))
	a.setSessionCookie(w, token, sess)
	writeJSON(w, http.StatusOK, struct {
		MFARequired bool   `json:"mfa_required"`
		CSRFToken   string `json:"csrf_token"`
	}{mfaRequired, sess.CSRFToken})
}

// logout handles POST /auth/logout.
func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	info, _ := authFrom(ctx)
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		if err := a.d.Sessions.Delete(ctx, q, info.token); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &info.user.ID, ActorIP: ip, Action: actionLogout,
			TargetType: targetUser, TargetID: info.user.ID.String(),
		})
	})
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.log.Info("sign-out", "user", info.user.Username, "ip", ip.String(), "request_id", requestIDFrom(ctx))
	a.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// me handles GET /auth/me. It also returns the session's current CSRF token,
// which a reloaded page needs.
func (a *api) me(w http.ResponseWriter, r *http.Request) {
	info, _ := authFrom(r.Context())
	writeJSON(w, http.StatusOK, struct {
		User         userJSON `json:"user"`
		MFAPassed    bool     `json:"mfa_passed"`
		TOTPEnrolled bool     `json:"totp_enrolled"`
		CSRFToken    string   `json:"csrf_token"`
	}{toUserJSON(info.user), info.session.MFAPassed, info.user.TOTPEnrolled, info.session.CSRFToken})
}

// verifyTOTP handles POST /auth/totp: a correct, unused code marks the
// session MFA-passed under a new session ID and CSRF token. Wrong codes count
// against the client address and, per user, lock TOTP on the account lockout
// schedule; a password login does not reset that count, so a stolen password
// does not allow unlimited guessing. Both counters are reserved before the
// code is checked, so parallel guesses are bounded too. A right code whose
// step was already used is refused (400 code_already_used) without counting
// as a failure: it is what a user sees who signs in within 30 s of enrolling.
func (a *api) verifyTOTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	info, _ := authFrom(ctx)
	if !info.user.TOTPEnrolled {
		writeError(w, http.StatusBadRequest, codeBadRequest, "TOTP is not set up for this account")
		return
	}
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	att := a.beginIPAttempt(w, ip)
	if att == nil {
		return
	}
	defer att.end()
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	userKey := info.user.ID.String()
	var token string
	var sess auth.Session
	var failed, locked bool
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		// Rotate also takes this lock: keep settings -> user -> session order.
		if _, err := q.GetSessionSettingsForShare(ctx); err != nil {
			return fmt.Errorf("lock session settings: %w", err)
		}
		row, err := q.GetUserByIDForUpdate(ctx, info.user.ID)
		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}
		if row.Status != statusActive {
			return auth.ErrNoSession
		}
		if _, err := a.d.Sessions.Check(ctx, q, info.session.ID); err != nil {
			return err
		}
		if row.TOTPSecretEnc == nil {
			return &apiError{http.StatusBadRequest, codeBadRequest, "TOTP is not set up for this account"}
		}
		now := a.now()
		locked = row.TotpLockedUntil != nil && now.Before(*row.TotpLockedUntil)
		reason := "totp_locked"
		if !locked {
			step, valid, err := a.checkStoredTOTP(row, req.Code, now)
			if err != nil {
				return err
			}
			if valid {
				if step <= row.TOTPLastStep {
					return errCodeRejected
				}
				if token, sess, err = a.d.Sessions.Rotate(ctx, q, info.token, true); err != nil {
					return err
				}
				if err := useTOTPStep(ctx, q, row.ID, step); err != nil {
					return err
				}
				return audit.Record(ctx, q, audit.Event{
					ActorUserID: &info.user.ID, ActorIP: ip, Action: actionMFAPassed,
					TargetType: targetUser, TargetID: userKey,
				})
			}
			reason = "invalid_totp"
			var until *time.Time
			if d := auth.LockDuration(int(row.TotpFailedLogins) + 1); d > 0 {
				t := now.Add(d)
				until = &t
				locked = true
			}
			if err := q.RecordTOTPFailure(ctx, db.RecordTOTPFailureParams{ID: row.ID, Until: until}); err != nil {
				return fmt.Errorf("record totp failure: %w", err)
			}
		}
		failed, att.failed = true, true
		return audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: actionLoginFailed,
			TargetType: targetUser, TargetID: userKey,
			Details: map[string]any{"username": auditUsername(info.user.Username), "reason": reason},
		})
	})
	switch {
	case errors.Is(err, errCodeRejected):
		writeCodeUsed(w)
	case errors.Is(err, auth.ErrNoSession):
		a.clearSessionCookie(w)
		writeError(w, http.StatusUnauthorized, codeUnauthenticated, "sign in required")
	case err != nil:
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
	case locked:
		a.log.Warn("totp locked", "user", info.user.Username, "ip", ip.String(), "request_id", requestIDFrom(ctx))
		writeError(w, http.StatusLocked, codeLocked, msgLocked)
	case failed:
		a.log.Warn("totp failed", "user", info.user.Username, "ip", ip.String(), "request_id", requestIDFrom(ctx))
		writeError(w, http.StatusBadRequest, codeInvalidCode, msgInvalidCode)
	default:
		a.log.Info("totp passed", "user", info.user.Username, "ip", ip.String(), "request_id", requestIDFrom(ctx))
		a.setSessionCookie(w, token, sess)
		writeJSON(w, http.StatusOK, csrfResponse{sess.CSRFToken})
	}
}

// writeCodeUsed answers a right TOTP code whose time step was already used.
func writeCodeUsed(w http.ResponseWriter) {
	writeError(w, http.StatusBadRequest, codeCodeAlreadyUsed, "code already used; wait for the next code")
}

// checkStoredTOTP checks code against row's sealed secret at now and returns
// the step it matches, whether or not that step was used already (the caller
// compares it with totp_last_step to tell a reused code from a wrong one).
func (a *api) checkStoredTOTP(row db.User, code string, now time.Time) (int64, bool, error) {
	if row.TOTPSecretEnc == nil {
		return 0, false, nil
	}
	secret, err := a.d.Sealer.Open(row.TOTPSecretEnc)
	if err != nil {
		return 0, false, fmt.Errorf("open totp secret of %s: %w", row.ID, err)
	}
	step, ok := auth.VerifyTOTP(string(secret), code, now, -1)
	return step, ok, nil
}

// useTOTPStep records step as the user's last accepted TOTP step. It returns
// errCodeRejected when the step is not newer than the stored one, so a code is
// accepted at most once even under concurrent use.
func useTOTPStep(ctx context.Context, q *db.Queries, userID uuid.UUID, step int64) error {
	n, err := q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: userID, Step: step})
	if err != nil {
		return fmt.Errorf("store totp step: %w", err)
	}
	if n == 0 {
		return errCodeRejected
	}
	return nil
}

// changePassword handles POST /auth/password. It needs the current password,
// ends the user's other sessions and rotates this one.
func (a *api) changePassword(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	att := a.beginIPAttempt(w, ip)
	if att == nil {
		return
	}
	defer att.end()
	var req struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	info, _ := authFrom(ctx)
	row, err := db.New(a.d.Pool).GetUserByID(ctx, info.user.ID)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get user: %w", err))
		return
	}
	if row.PasswordHash == nil {
		att.failed = true
		writeError(w, http.StatusForbidden, codeForbidden, "current password is incorrect")
		return
	}
	match, err := auth.VerifyPassword(ctx, *row.PasswordHash, req.Current)
	if errors.Is(err, auth.ErrBusy) {
		writeBusy(w)
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if !match {
		att.failed = true
		writeError(w, http.StatusForbidden, codeForbidden, "current password is incorrect")
		return
	}
	if len(req.New) > maxPasswordBytes {
		writeError(w, http.StatusBadRequest, codeBadRequest, fmt.Sprintf("password must be at most %d bytes", maxPasswordBytes))
		return
	}
	if err := auth.ValidatePassword(row.Username, req.New); err != nil {
		writeError(w, http.StatusBadRequest, codeWeakPassword, err.Error())
		return
	}
	hash, err := auth.HashPassword(ctx, req.New, a.d.Params)
	if errors.Is(err, auth.ErrBusy) {
		writeBusy(w)
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	var token string
	var sess auth.Session
	err = store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		var err error
		if token, sess, err = a.d.Sessions.Rotate(ctx, q, info.token, info.session.MFAPassed); err != nil {
			return err
		}
		if err := q.SetPasswordHash(ctx, db.SetPasswordHashParams{ID: row.ID, PasswordHash: &hash}); err != nil {
			return fmt.Errorf("store password: %w", err)
		}
		if err := q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: row.ID, KeepID: sess.ID}); err != nil {
			return fmt.Errorf("end other sessions: %w", err)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &row.ID, ActorIP: ip, Action: actionPasswordChanged,
			TargetType: targetUser, TargetID: row.ID.String(),
		})
	})
	if errors.Is(err, auth.ErrNoSession) {
		a.clearSessionCookie(w)
		writeError(w, http.StatusUnauthorized, codeUnauthenticated, "sign in required")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.setSessionCookie(w, token, sess)
	writeJSON(w, http.StatusOK, csrfResponse{sess.CSRFToken})
}

// enrollTOTP handles POST /auth/totp/enroll. The new secret is held in
// memory for this session until /auth/totp/enroll/verify confirms a code
// from it; only then does it replace the stored secret.
func (a *api) enrollTOTP(w http.ResponseWriter, r *http.Request) {
	info, _ := authFrom(r.Context())
	var req struct {
		CurrentPassword string `json:"current_password"`
	}
	if r.Body != http.NoBody && !decode(w, r, &req) {
		return
	}
	row, err := db.New(a.d.Pool).GetUserByID(r.Context(), info.user.ID)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get user for TOTP enrollment: %w", err))
		return
	}
	if row.TOTPSecretEnc != nil {
		if row.PasswordHash == nil {
			if a.now().Sub(info.session.CreatedAt) >= 5*time.Minute {
				writeError(w, http.StatusForbidden, codeReauthRequired, "sign in again before re-enrolling TOTP")
				return
			}
		} else {
			if req.CurrentPassword == "" {
				writeError(w, http.StatusForbidden, codeForbidden, "current password is required")
				return
			}
			ip, ok := a.clientIP(w, r)
			if !ok {
				return
			}
			att := a.beginIPAttempt(w, ip)
			if att == nil {
				return
			}
			defer att.end()
			match, err := auth.VerifyPassword(r.Context(), *row.PasswordHash, req.CurrentPassword)
			if errors.Is(err, auth.ErrBusy) {
				writeBusy(w)
				return
			}
			if err != nil {
				a.writeInternal(w, r, err)
				return
			}
			if !match {
				att.failed = true
				writeError(w, http.StatusForbidden, codeForbidden, "current password is incorrect")
				return
			}
		}
	}
	secret, err := auth.NewTOTPSecret()
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.enrollments.put(string(info.session.ID), secret, a.now().Add(enrollTTL))
	writeJSON(w, http.StatusOK, struct {
		Secret     string `json:"secret"`
		OTPAuthURL string `json:"otpauth_url"`
	}{secret, auth.TOTPURL(info.user.Username, secret)})
}

// verifyEnrollTOTP handles POST /auth/totp/enroll/verify: a correct code
// stores the pending secret, and the session, having just proved the second
// factor, is rotated as MFA-passed.
func (a *api) verifyEnrollTOTP(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	att := a.beginIPAttempt(w, ip)
	if att == nil {
		return
	}
	defer att.end()
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	info, _ := authFrom(ctx)
	now := a.now()
	sessKey := string(info.session.ID)
	secret, ok := a.enrollments.get(sessKey, now)
	if !ok {
		writeError(w, http.StatusConflict, codeIncomplete, "start TOTP enrollment first")
		return
	}
	row, err := db.New(a.d.Pool).GetUserByID(ctx, info.user.ID)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get user: %w", err))
		return
	}
	step, ok := auth.VerifyTOTP(secret, req.Code, now, -1)
	if !ok {
		att.failed = true
		writeError(w, http.StatusBadRequest, codeInvalidCode, msgInvalidCode)
		return
	}
	if step <= row.TOTPLastStep {
		// Re-enrolling within 30 s of the last accepted code: the new
		// secret's code for that step is refused like a reused one.
		writeCodeUsed(w)
		return
	}
	sealed, err := a.d.Sealer.Seal([]byte(secret))
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	var token string
	var sess auth.Session
	err = store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		var err error
		if token, sess, err = a.d.Sessions.Rotate(ctx, q, info.token, true); err != nil {
			return err
		}
		if err := q.SetTOTP(ctx, db.SetTOTPParams{ID: row.ID, TOTPSecretEnc: sealed}); err != nil {
			return fmt.Errorf("store totp secret: %w", err)
		}
		if err := useTOTPStep(ctx, q, row.ID, step); err != nil {
			return err
		}
		if err := q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: row.ID, KeepID: sess.ID}); err != nil {
			return fmt.Errorf("end other sessions: %w", err)
		}
		if err := q.NotifyGrantsChanged(ctx, row.ID); err != nil {
			return fmt.Errorf("notify session revocation: %w", err)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &row.ID, ActorIP: ip, Action: actionTOTPEnrolled,
			TargetType: targetUser, TargetID: row.ID.String(),
		})
	})
	switch {
	case errors.Is(err, errCodeRejected):
		writeCodeUsed(w)
	case errors.Is(err, auth.ErrNoSession):
		a.clearSessionCookie(w)
		writeError(w, http.StatusUnauthorized, codeUnauthenticated, "sign in required")
	case err != nil:
		a.writeInternal(w, r, err)
	default:
		a.enrollments.delete(sessKey)
		a.setSessionCookie(w, token, sess)
		writeJSON(w, http.StatusOK, csrfResponse{sess.CSRFToken})
	}
}

// enrollments holds TOTP secrets awaiting their first code, per session ID.
// It keeps at most max entries; adding one to a full map drops the entry that
// expires soonest.
type enrollments struct {
	max int

	mu      sync.Mutex
	pending map[string]pendingSecret
}

type pendingSecret struct {
	secret  string
	expires time.Time
}

func newEnrollments(max int) *enrollments {
	return &enrollments{max: max, pending: make(map[string]pendingSecret)}
}

func (e *enrollments) put(key, secret string, expires time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.pending[key]; !ok && len(e.pending) >= e.max {
		var soonest string
		for k, p := range e.pending {
			if soonest == "" || p.expires.Before(e.pending[soonest].expires) {
				soonest = k
			}
		}
		delete(e.pending, soonest)
	}
	e.pending[key] = pendingSecret{secret: secret, expires: expires}
}

func (e *enrollments) get(key string, now time.Time) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.pending[key]
	if !ok || !now.Before(p.expires) {
		delete(e.pending, key)
		return "", false
	}
	return p.secret, true
}

func (e *enrollments) delete(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.pending, key)
}
