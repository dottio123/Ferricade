package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/store/db"
)

// Login errors. A wrong password and an unknown username both give
// ErrInvalidCredentials.
var (
	ErrInvalidCredentials = errors.New("auth: invalid username or password")
	ErrLocked             = errors.New("auth: account locked")
	ErrDisabled           = errors.New("auth: account disabled")
)

// LockedError reports until when an account is locked. It matches ErrLocked
// with errors.Is.
type LockedError struct {
	Until time.Time
}

func (e LockedError) Error() string {
	return fmt.Sprintf("auth: account locked until %s", e.Until.UTC().Format(time.RFC3339))
}

func (e LockedError) Unwrap() error { return ErrLocked }

// User is an admin console account as the rest of the application sees it.
// TOTPEnrolled is true when a TOTP secret is stored.
type User struct {
	ID              uuid.UUID
	Username        string
	DisplayName     string
	Email           string
	Role            string
	TOTPEnrolled    bool
	TOTPRequired    bool
	Status          string
	SSO             bool
	AvatarUpdatedAt *time.Time
}

// UserFromRow converts a users row.
func UserFromRow(r db.User) User {
	return User{
		ID:              r.ID,
		Username:        r.Username,
		DisplayName:     r.DisplayName,
		Email:           r.Email,
		Role:            r.Role,
		TOTPEnrolled:    r.TOTPSecretEnc != nil,
		TOTPRequired:    r.TOTPRequired,
		Status:          r.Status,
		SSO:             r.OidcIssuer != nil && r.OidcSubject != nil,
		AvatarUpdatedAt: r.AvatarUpdatedAt,
	}
}

// The unknown-username path verifies the password against this hash so that
// it costs the same Argon2id work as a real account. It is computed once, on
// first use, with DefaultParams: production hashes use DefaultParams, so the
// timing matches theirs. (Accounts hashed with other params, such as
// TestParams in tests, take a different time; that does not arise in
// production.)
var (
	dummyOnce    sync.Once
	dummyEncoded string
	dummyErr     error
)

// WarmDummyHash computes the unknown-username dummy hash now, so the first
// login for an unknown username does not take longer than later ones. Call it
// once at startup.
func WarmDummyHash() error {
	_, err := dummyHash()
	return err
}

// dummyHash computes the dummy hash once. It waits for an Argon2id slot as
// long as it takes, so a busy moment cannot leave it failed for good.
func dummyHash() (string, error) {
	dummyOnce.Do(func() {
		dummyEncoded, dummyErr = hashPassword(context.Background(), "ferricade dummy password, never matches a login", DefaultParams, false)
	})
	return dummyEncoded, dummyErr
}

// Login checks username and password at now.
//
//   - An unknown username verifies against a dummy hash and returns
//     ErrInvalidCredentials, the same error as a wrong password.
//   - When no Argon2id slot frees up in time (see AcquireArgonSlot), ErrBusy
//     is returned and nothing is counted.
//   - An account locked at now returns LockedError (matching ErrLocked)
//     without verifying the password or counting a failure.
//   - A wrong password increments failed_logins and returns
//     ErrInvalidCredentials, or LockedError once the new count locks the
//     account (locked_until = now + LockDuration(count)).
//   - A correct password on a disabled account returns ErrDisabled.
//   - Otherwise the failure count and lock are cleared and the user returned.
//     If a concurrent failure locked the account while this password was
//     being verified, LockedError is returned instead, so parallel guesses
//     cannot get past the lock.
//
// The failure count is written before the error is returned, so q must not be
// a transaction that is rolled back on error (as store.Tx does): that would
// undo the count. Run Login on the pool, or commit regardless of its error.
func Login(ctx context.Context, q *db.Queries, username, password string, now time.Time) (User, error) {
	now = now.UTC().Truncate(time.Microsecond) // timestamptz precision
	// Postgres text rejects NUL and invalid UTF-8; no stored username has
	// them, so such a name is simply unknown rather than a database error.
	if !utf8.ValidString(username) || strings.ContainsRune(username, 0) {
		return User{}, unknownUser(ctx, password)
	}
	row, err := q.GetUserByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, unknownUser(ctx, password)
	}
	if err != nil {
		return User{}, fmt.Errorf("auth: get user: %w", err)
	}
	return LoginKnown(ctx, q, row, password, now)
}

// LoginKnown checks a user row already loaded by the caller.
func LoginKnown(ctx context.Context, q *db.Queries, row db.User, password string, now time.Time) (User, error) {
	now = now.UTC().Truncate(time.Microsecond)

	if row.LockedUntil != nil && now.Before(*row.LockedUntil) {
		return User{}, LockedError{Until: *row.LockedUntil}
	}

	if row.PasswordHash == nil {
		if err := unknownUser(ctx, password); !errors.Is(err, ErrInvalidCredentials) {
			return User{}, err
		}
		return User{}, recordFailure(ctx, q, row.ID, now)
	}
	ok, err := VerifyPassword(ctx, *row.PasswordHash, password)
	if errors.Is(err, ErrBusy) {
		return User{}, err
	}
	if err != nil {
		return User{}, fmt.Errorf("auth: verify password for user %s: %w", row.ID, err)
	}
	if !ok {
		return User{}, recordFailure(ctx, q, row.ID, now)
	}

	if row.Status != "active" {
		return User{}, ErrDisabled
	}
	n, err := q.ResetLoginFailures(ctx, db.ResetLoginFailuresParams{ID: row.ID, Now: now})
	if err != nil {
		return User{}, fmt.Errorf("auth: reset login failures: %w", err)
	}
	if n == 0 {
		return User{}, lockedSince(ctx, q, row.ID, now)
	}
	return UserFromRow(row), nil
}

// unknownUser spends the same Argon2id work as checking a real account and
// returns ErrInvalidCredentials, or ErrBusy when the server is too busy to
// spend it.
func unknownUser(ctx context.Context, password string) error {
	hash, err := dummyHash()
	if err != nil {
		return fmt.Errorf("auth: dummy hash: %w", err)
	}
	if _, err := VerifyPassword(ctx, hash, password); errors.Is(err, ErrBusy) {
		return err
	}
	return ErrInvalidCredentials
}

// RejectUnknown performs the timing-equalising password work for an unknown username.
func RejectUnknown(ctx context.Context, password string) error { return unknownUser(ctx, password) }

// recordFailure counts a failed login for id and, from the fifth on, locks
// the account. It returns the error Login reports for the failure.
func recordFailure(ctx context.Context, q *db.Queries, id uuid.UUID, now time.Time) error {
	count, err := q.RecordLoginFailure(ctx, db.RecordLoginFailureParams{ID: id, Now: now})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalidCredentials // deleted concurrently
	}
	if err != nil {
		return fmt.Errorf("auth: record login failure: %w", err)
	}
	d := LockDuration(int(count))
	if d == 0 {
		return ErrInvalidCredentials
	}
	until, err := q.SetLockedUntil(ctx, db.SetLockedUntilParams{ID: id, Until: now.Add(d), Failures: count})
	if errors.Is(err, pgx.ErrNoRows) {
		// A success reset the count after this failure was counted.
		return ErrInvalidCredentials
	}
	if err != nil {
		return fmt.Errorf("auth: lock account: %w", err)
	}
	if until == nil { // cannot happen: GREATEST of a non-NULL value
		return ErrInvalidCredentials
	}
	return LockedError{Until: *until}
}

// lockedSince is Login's result when a correct password could not clear the
// failure count because the account became locked during verification.
func lockedSince(ctx context.Context, q *db.Queries, id uuid.UUID, now time.Time) error {
	row, err := q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalidCredentials
	}
	if err != nil {
		return fmt.Errorf("auth: get user: %w", err)
	}
	if row.LockedUntil != nil && now.Before(*row.LockedUntil) {
		return LockedError{Until: *row.LockedUntil}
	}
	// The row changed again between the two statements; fail closed.
	return ErrInvalidCredentials
}
