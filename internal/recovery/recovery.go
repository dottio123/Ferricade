// Package recovery implements the operator's account recovery commands
// (ferricade user unlock and ferricade user reset-totp), which work directly on
// the database. Each runs in one transaction and is audited with no actor
// user and the address 127.0.0.1.
package recovery

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Audit actions.
const (
	ActionUnlocked  = "user.unlocked_cli"
	ActionTOTPReset = "user.totp_reset_cli"
)

// ErrUserNotFound is returned when no account has the username.
var ErrUserNotFound = errors.New("no user with that username")

// actorIP is the audit address of a command run on the server itself.
var actorIP = netip.MustParseAddr("127.0.0.1")

// Unlocked describes an UnlockUser: the account and the failure count and
// lock it had.
type Unlocked struct {
	UserID       uuid.UUID
	Username     string
	FailedLogins int32
	LockedUntil  *time.Time
}

// UnlockUser clears the failed-login count and lock of the account named
// username (case-insensitive).
func UnlockUser(ctx context.Context, pool *pgxpool.Pool, username string) (Unlocked, error) {
	var res Unlocked
	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		u, err := lockUser(ctx, q, username)
		if err != nil {
			return err
		}
		res = Unlocked{UserID: u.ID, Username: u.Username, FailedLogins: u.FailedLogins, LockedUntil: u.LockedUntil}
		if err := q.UnlockUser(ctx, u.ID); err != nil {
			return fmt.Errorf("unlock user: %w", err)
		}
		details := map[string]any{"username": u.Username, "failed_logins": u.FailedLogins}
		if u.LockedUntil != nil {
			details["locked_until"] = u.LockedUntil.UTC().Format(time.RFC3339)
		}
		return audit.Record(ctx, q, audit.Event{
			ActorIP: actorIP, Action: ActionUnlocked, TargetType: "user", TargetID: u.ID.String(), Details: details,
		})
	})
	if err != nil {
		return Unlocked{}, err
	}
	return res, nil
}

// TOTPReset describes a ResetUserTOTP. SetupVerificationCleared is true when
// the account is the setup wizard's owner and setup is incomplete, so the
// wizard's TOTP step must be done again.
type TOTPReset struct {
	UserID                   uuid.UUID
	Username                 string
	WasEnrolled              bool
	SetupVerificationCleared bool
}

// ResetUserTOTP removes the TOTP secret of the account named username
// (case-insensitive), restarts its totp_last_step at 0 and ends its sessions.
// totp_required is unchanged, so an account that requires TOTP enrolls again
// at its next sign-in.
func ResetUserTOTP(ctx context.Context, pool *pgxpool.Pool, username string) (TOTPReset, error) {
	var res TOTPReset
	err := store.Tx(ctx, pool, func(q *db.Queries) error {
		// The setup lock before the user's row, the wizard's order.
		if err := q.LockSetup(ctx); err != nil {
			return fmt.Errorf("lock setup: %w", err)
		}
		u, err := lockUser(ctx, q, username)
		if err != nil {
			return err
		}
		if err := q.ResetUserTOTP(ctx, u.ID); err != nil {
			return fmt.Errorf("reset totp: %w", err)
		}
		if err := q.DeleteUserSessions(ctx, u.ID); err != nil {
			return fmt.Errorf("end sessions: %w", err)
		}
		if err := q.NotifyGrantsChanged(ctx, u.ID); err != nil {
			return fmt.Errorf("notify session revocation: %w", err)
		}
		cleared, err := setup.ForgetOwnerTOTP(ctx, q, u.ID)
		if err != nil {
			return err
		}
		res = TOTPReset{UserID: u.ID, Username: u.Username, WasEnrolled: u.TOTPSecretEnc != nil, SetupVerificationCleared: cleared}
		return audit.Record(ctx, q, audit.Event{
			ActorIP: actorIP, Action: ActionTOTPReset, TargetType: "user", TargetID: u.ID.String(),
			Details: map[string]any{"username": u.Username, "was_enrolled": res.WasEnrolled, "setup_verification_cleared": cleared},
		})
	})
	if err != nil {
		return TOTPReset{}, err
	}
	return res, nil
}

// lockUser finds the account named username and locks its row.
func lockUser(ctx context.Context, q *db.Queries, username string) (db.User, error) {
	// Postgres text cannot hold such a name, so no account has it.
	if !utf8.ValidString(username) || strings.ContainsRune(username, 0) {
		return db.User{}, ErrUserNotFound
	}
	u, err := q.GetUserByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrUserNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("get user: %w", err)
	}
	u, err = q.GetUserByIDForUpdate(ctx, u.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrUserNotFound // deleted meanwhile
	}
	if err != nil {
		return db.User{}, fmt.Errorf("lock user: %w", err)
	}
	return u, nil
}
