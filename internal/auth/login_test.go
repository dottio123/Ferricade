package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const goodPW = "correct horse battery"

var loginNow = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)

func TestLoginFailuresDecayAfterHour(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)
	for i := 0; i < 5; i++ {
		_, _ = Login(ctx, q, "alice", "wrong password!", loginNow)
	}
	_, err := Login(ctx, q, "alice", "wrong password!", loginNow.Add(time.Hour+time.Second))
	require.ErrorIs(t, err, ErrInvalidCredentials)
	n, until := failures(t, q, "alice")
	require.EqualValues(t, 1, n)
	require.True(t, until == nil || !until.After(loginNow.Add(time.Hour)))
}

func failures(t *testing.T, q *db.Queries, username string) (int32, *time.Time) {
	t.Helper()
	u, err := q.GetUserByUsername(context.Background(), username)
	require.NoError(t, err)
	return u.FailedLogins, u.LockedUntil
}

func TestLoginSuccessResetsFailures(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	row := createTestUser(t, q, "alice", goodPW)

	for i := 0; i < 3; i++ {
		_, err := Login(ctx, q, "alice", "wrong password!", loginNow)
		require.ErrorIs(t, err, ErrInvalidCredentials)
	}
	n, until := failures(t, q, "alice")
	require.EqualValues(t, 3, n)
	require.Nil(t, until)

	u, err := Login(ctx, q, "ALICE", goodPW, loginNow) // usernames are citext
	require.NoError(t, err)
	require.Equal(t, User{
		ID:          row.ID,
		Username:    "alice",
		DisplayName: "Display alice",
		Email:       "alice@example.com",
		Role:        "admin",
		Status:      "active",
	}, u)
	n, until = failures(t, q, "alice")
	require.Zero(t, n)
	require.Nil(t, until)
}

func TestLoginSuccessAfterLockExpiresResets(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)

	for i := 0; i < 5; i++ {
		_, _ = Login(ctx, q, "alice", "wrong password!", loginNow)
	}
	_, until := failures(t, q, "alice")
	require.NotNil(t, until)

	_, err := Login(ctx, q, "alice", goodPW, until.Add(-time.Microsecond))
	require.ErrorIs(t, err, ErrLocked)
	_, err = Login(ctx, q, "alice", goodPW, *until)
	require.NoError(t, err)
	n, until := failures(t, q, "alice")
	require.Zero(t, n)
	require.Nil(t, until)
}

func TestLoginLocksAfterFive(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)

	for i := 1; i <= 4; i++ {
		_, err := Login(ctx, q, "alice", "wrong password!", loginNow)
		require.ErrorIs(t, err, ErrInvalidCredentials, "attempt %d", i)
		require.False(t, errors.Is(err, ErrLocked))
		_, until := failures(t, q, "alice")
		require.Nil(t, until, "attempt %d", i)
	}

	// The fifth failure locks the account and says so.
	_, err := Login(ctx, q, "alice", "wrong password!", loginNow)
	require.ErrorIs(t, err, ErrLocked)
	var le LockedError
	require.ErrorAs(t, err, &le)
	require.Equal(t, loginNow.Add(time.Minute), le.Until)
	n, until := failures(t, q, "alice")
	require.EqualValues(t, 5, n)
	require.NotNil(t, until)
	require.Equal(t, loginNow.Add(time.Minute), *until)

	// Sixth attempt, correct password, still locked: no verify, no new failure.
	_, err = Login(ctx, q, "alice", goodPW, loginNow.Add(30*time.Second))
	require.ErrorIs(t, err, ErrLocked)
	require.False(t, errors.Is(err, ErrInvalidCredentials))
	require.ErrorAs(t, err, &le)
	require.Equal(t, loginNow.Add(time.Minute), le.Until)
	n, _ = failures(t, q, "alice")
	require.EqualValues(t, 5, n)

	// A wrong password while locked is not counted either.
	_, err = Login(ctx, q, "alice", "wrong password!", loginNow.Add(30*time.Second))
	require.ErrorIs(t, err, ErrLocked)
	n, _ = failures(t, q, "alice")
	require.EqualValues(t, 5, n)

	// After the lock, a further failure doubles it.
	later := loginNow.Add(time.Minute)
	_, err = Login(ctx, q, "alice", "wrong password!", later)
	require.ErrorAs(t, err, &le)
	require.Equal(t, later.Add(2*time.Minute), le.Until)
	n, until = failures(t, q, "alice")
	require.EqualValues(t, 6, n)
	require.Equal(t, later.Add(2*time.Minute), *until)
}

func TestLoginUnknownUserSameError(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)

	_, errUnknown := Login(ctx, q, "mallory", goodPW, loginNow)
	_, errWrong := Login(ctx, q, "alice", "wrong password!", loginNow)
	require.ErrorIs(t, errUnknown, ErrInvalidCredentials)
	require.ErrorIs(t, errWrong, ErrInvalidCredentials)
	require.Equal(t, errUnknown.Error(), errWrong.Error())
	for _, name := range []string{"ali\x00ce", "ali\xffce"} {
		_, err := Login(ctx, q, name, goodPW, loginNow)
		require.ErrorIs(t, err, ErrInvalidCredentials, "username %q", name)
	}

	// The unknown-user path verifies against a real DefaultParams hash.
	hash, err := dummyHash()
	require.NoError(t, err)
	require.Contains(t, hash, "$argon2id$v=19$m=65536,t=3,p=2$")
}

func TestLoginDisabledUser(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)
	_, err := pool.Exec(ctx, `UPDATE users SET status = 'disabled' WHERE username = 'alice'`)
	require.NoError(t, err)

	_, err = Login(ctx, q, "alice", "wrong password!", loginNow)
	require.ErrorIs(t, err, ErrInvalidCredentials)
	require.False(t, errors.Is(err, ErrDisabled))

	_, err = Login(ctx, q, "alice", goodPW, loginNow)
	require.ErrorIs(t, err, ErrDisabled)
	require.False(t, errors.Is(err, ErrInvalidCredentials))
}

func TestLoginUserFields(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	row := createTestUser(t, q, "alice", goodPW)
	require.NoError(t, q.SetTOTP(ctx, db.SetTOTPParams{ID: row.ID, TOTPSecretEnc: []byte("sealed")}))
	_, err := pool.Exec(ctx, `UPDATE users SET totp_required = true, role = 'owner' WHERE id = $1`, row.ID)
	require.NoError(t, err)

	u, err := Login(ctx, q, "alice", goodPW, loginNow)
	require.NoError(t, err)
	require.True(t, u.TOTPEnrolled)
	require.True(t, u.TOTPRequired)
	require.Equal(t, "owner", u.Role)
}

func TestSetTOTPLastStepOnlyIncreases(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	row := createTestUser(t, q, "alice", goodPW)

	n, err := q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: row.ID, Step: 100})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	n, err = q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: row.ID, Step: 100})
	require.NoError(t, err)
	require.Zero(t, n, "replaying the same step must not win")
	n, err = q.SetTOTPLastStep(ctx, db.SetTOTPLastStepParams{ID: row.ID, Step: 99})
	require.NoError(t, err)
	require.Zero(t, n)
	u, err := q.GetUserByID(ctx, row.ID)
	require.NoError(t, err)
	require.EqualValues(t, 100, u.TOTPLastStep)
}

func TestCountActiveOwners(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "admin1", goodPW)
	for _, name := range []string{"o1", "o2", "o3"} {
		hash, err := HashPassword(context.Background(), goodPW, TestParams)
		require.NoError(t, err)
		_, err = q.CreateUser(ctx, db.CreateUserParams{Username: name, Role: "owner", PasswordHash: &hash})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `UPDATE users SET status = 'disabled' WHERE username = 'o3'`)
	require.NoError(t, err)

	require.NoError(t, store.Tx(ctx, pool, func(q *db.Queries) error {
		n, err := q.CountActiveOwners(ctx)
		require.NoError(t, err)
		require.EqualValues(t, 2, n)
		return nil
	}))
}

func TestLoginConcurrentFailuresAllCounted(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)

	const n = 12
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			_, err := Login(ctx, q, "alice", "wrong password!", loginNow)
			errs <- err
		}()
	}
	locked := 0
	for i := 0; i < n; i++ {
		err := <-errs
		if errors.Is(err, ErrLocked) {
			locked++
		} else {
			require.ErrorIs(t, err, ErrInvalidCredentials)
		}
	}
	// Exactly the first four counted failures report invalid credentials.
	// Every later attempt reports the lock: either its own increment reached
	// the threshold, or it found the account already locked and was not
	// counted. No increment is lost.
	require.Equal(t, n-(lockThreshold-1), locked)
	count, until := failures(t, q, "alice")
	require.GreaterOrEqual(t, count, int32(lockThreshold))
	require.LessOrEqual(t, count, int32(n))
	require.NotNil(t, until)
	require.Equal(t, loginNow.Add(LockDuration(int(count))), *until, "the longest lock wins")
}

func TestResetLoginFailuresRefusesWhileLocked(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	row := createTestUser(t, q, "alice", goodPW)
	for i := 0; i < 5; i++ {
		_, _ = Login(ctx, q, "alice", "wrong password!", loginNow)
	}
	n, err := q.ResetLoginFailures(ctx, db.ResetLoginFailuresParams{ID: row.ID, Now: loginNow})
	require.NoError(t, err)
	require.Zero(t, n)
	// Login reports the lock found after a correct password.
	err = lockedSince(ctx, q, row.ID, loginNow)
	var le LockedError
	require.ErrorAs(t, err, &le)
	require.Equal(t, loginNow.Add(time.Minute), le.Until)
}

func TestWarmDummyHash(t *testing.T) {
	require.NoError(t, WarmDummyHash())
	hash, err := dummyHash()
	require.NoError(t, err)
	require.Contains(t, hash, "$m=65536,t=3,p=2$", "the dummy uses production params")
}

// A busy server refuses the login without verifying or counting it, for
// unknown usernames (the dummy verify) and real accounts alike.
func TestLoginBusy(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	createTestUser(t, q, "alice", goodPW)
	require.NoError(t, WarmDummyHash())

	defer SetArgonLimit(1, 10*time.Millisecond)()
	release, err := AcquireArgonSlot(ctx)
	require.NoError(t, err)
	defer release()

	_, err = Login(ctx, q, "mallory", goodPW, loginNow)
	require.ErrorIs(t, err, ErrBusy)
	_, err = Login(ctx, q, "alice", "wrong password!", loginNow)
	require.ErrorIs(t, err, ErrBusy)
	n, until := failures(t, q, "alice")
	require.Zero(t, n, "a busy refusal is not a failure")
	require.Nil(t, until)
}
