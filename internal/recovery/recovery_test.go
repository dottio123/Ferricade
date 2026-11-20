package recovery_test

import (
	"context"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/recovery"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var localhost = netip.MustParseAddr("127.0.0.1")

func createUser(t *testing.T, pool *pgxpool.Pool, username, role string, totpRequired bool) db.User {
	t.Helper()
	hash, err := auth.HashPassword(context.Background(), "correct horse battery staple", auth.TestParams)
	require.NoError(t, err)
	u, err := db.New(pool).CreateUser(context.Background(), db.CreateUserParams{
		Username: username, Role: role, PasswordHash: &hash, TOTPRequired: totpRequired,
	})
	require.NoError(t, err)
	return u
}

func getUser(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) db.User {
	t.Helper()
	u, err := db.New(pool).GetUserByID(context.Background(), id)
	require.NoError(t, err)
	return u
}

func auditEntries(t *testing.T, pool *pgxpool.Pool, action string) []audit.Entry {
	t.Helper()
	entries, _, err := audit.List(context.Background(), db.New(pool), audit.Filter{Action: action, Limit: 200})
	require.NoError(t, err)
	return entries
}

func setting(t *testing.T, pool *pgxpool.Pool, key string) string {
	t.Helper()
	raw, err := db.New(pool).GetSetting(context.Background(), key)
	require.NoError(t, err)
	return string(raw)
}

func TestUnlockUser(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	alice := createUser(t, pool, "alice", "owner", true)
	until := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	_, err := pool.Exec(ctx, `UPDATE users SET failed_logins = 7, locked_until = $2 WHERE id = $1`, alice.ID, until)
	require.NoError(t, err)

	res, err := recovery.UnlockUser(ctx, pool, "ALICE") // usernames are case-insensitive
	require.NoError(t, err)
	require.Equal(t, recovery.Unlocked{UserID: alice.ID, Username: "alice", FailedLogins: 7, LockedUntil: &until}, res)

	u := getUser(t, pool, alice.ID)
	require.Zero(t, u.FailedLogins)
	require.Nil(t, u.LockedUntil)

	got := auditEntries(t, pool, "user.unlocked_cli")
	require.Len(t, got, 1)
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, localhost, got[0].ActorIP)
	require.Equal(t, "user", got[0].TargetType)
	require.Equal(t, alice.ID.String(), got[0].TargetID)
	require.Equal(t, "alice", got[0].Details["username"])
	require.EqualValues(t, 7, got[0].Details["failed_logins"])
}

func TestUnlockUnknownUser(t *testing.T) {
	pool := store.NewTestDB(t)
	for _, name := range []string{"nobody", "bad\x00name"} {
		_, err := recovery.UnlockUser(context.Background(), pool, name)
		require.ErrorIs(t, err, recovery.ErrUserNotFound)
		_, err = recovery.ResetUserTOTP(context.Background(), pool, name)
		require.ErrorIs(t, err, recovery.ErrUserNotFound)
	}
	require.Empty(t, auditEntries(t, pool, "user.unlocked_cli"))
	require.Empty(t, auditEntries(t, pool, "user.totp_reset_cli"))
}

// enrolled gives u a TOTP secret, a used step and a session.
func enrolled(t *testing.T, pool *pgxpool.Pool, u db.User) {
	t.Helper()
	ctx := context.Background()
	q := db.New(pool)
	require.NoError(t, q.SetTOTP(ctx, db.SetTOTPParams{ID: u.ID, TOTPSecretEnc: []byte("sealed secret")}))
	n, err := q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: u.ID, Step: 100})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	_, _, err = (&auth.Sessions{}).Create(ctx, q, u.ID, localhost, "test")
	require.NoError(t, err)
}

func sessionCount(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id = $1`, id).Scan(&n))
	return n
}

func TestResetUserTOTP(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	owner := createUser(t, pool, "owner", "owner", true)
	bob := createUser(t, pool, "bob", "admin", true)
	enrolled(t, pool, owner)
	enrolled(t, pool, bob)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeyOwnerTOTPVerified, Value: []byte(`true`)}))
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeySetupComplete, Value: []byte(`true`)}))

	res, err := recovery.ResetUserTOTP(ctx, pool, "Bob")
	require.NoError(t, err)
	require.Equal(t, recovery.TOTPReset{UserID: bob.ID, Username: "bob", WasEnrolled: true}, res)

	u := getUser(t, pool, bob.ID)
	require.Nil(t, u.TOTPSecretEnc)
	require.Zero(t, u.TOTPLastStep)
	require.True(t, u.TOTPRequired, "totp_required is unchanged")
	require.Zero(t, sessionCount(t, pool, bob.ID), "sessions ended")
	require.Equal(t, 1, sessionCount(t, pool, owner.ID), "other users keep theirs")
	require.NotNil(t, getUser(t, pool, owner.ID).TOTPSecretEnc)

	got := auditEntries(t, pool, "user.totp_reset_cli")
	require.Len(t, got, 1)
	require.Nil(t, got[0].ActorUserID)
	require.Equal(t, localhost, got[0].ActorIP)
	require.Equal(t, "user", got[0].TargetType)
	require.Equal(t, bob.ID.String(), got[0].TargetID)
	require.Equal(t, map[string]any{"username": "bob", "was_enrolled": true, "setup_verification_cleared": false}, got[0].Details)

	// Setup is complete: the owner's setup verification is left alone.
	res, err = recovery.ResetUserTOTP(ctx, pool, "owner")
	require.NoError(t, err)
	require.False(t, res.SetupVerificationCleared)
	require.Equal(t, "true", setting(t, pool, setup.KeyOwnerTOTPVerified))
}

// Before setup completes, resetting the wizard owner's TOTP also clears its
// setup verification, so setup cannot finish until it is verified again.
func TestResetUserTOTPDuringSetup(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	owner := createUser(t, pool, "owner", "owner", true)
	enrolled(t, pool, owner)
	require.NoError(t, q.PutSetting(ctx, db.PutSettingParams{Key: setup.KeyOwnerTOTPVerified, Value: []byte(`true`)}))

	res, err := recovery.ResetUserTOTP(ctx, pool, "owner")
	require.NoError(t, err)
	require.Equal(t, recovery.TOTPReset{UserID: owner.ID, Username: "owner", WasEnrolled: true, SetupVerificationCleared: true}, res)
	require.Equal(t, "false", setting(t, pool, setup.KeyOwnerTOTPVerified))
	require.Nil(t, getUser(t, pool, owner.ID).TOTPSecretEnc)
	got := auditEntries(t, pool, "user.totp_reset_cli")
	require.Len(t, got, 1)
	require.Equal(t, true, got[0].Details["setup_verification_cleared"])
}
