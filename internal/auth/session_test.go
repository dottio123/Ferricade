package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

var testIP = netip.MustParseAddr("192.0.2.10")

// testClock is a settable clock for Sessions.Now.
type testClock struct{ t time.Time }

func (c *testClock) Now() time.Time          { return c.t }
func (c *testClock) Advance(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *testClock {
	return &testClock{t: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)}
}

// createTestUser inserts an active admin with password pw hashed using
// TestParams.
func createTestUser(t *testing.T, q *db.Queries, username, pw string) db.User {
	t.Helper()
	hash, err := HashPassword(context.Background(), pw, TestParams)
	require.NoError(t, err)
	u, err := q.CreateUser(context.Background(), db.CreateUserParams{
		Username:     username,
		DisplayName:  "Display " + username,
		Email:        username + "@example.com",
		Role:         "admin",
		PasswordHash: &hash,
	})
	require.NoError(t, err)
	return u
}

func TestSessionCreateLookup(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	clk := newClock()
	s := &Sessions{Now: clk.Now}

	token, sess, err := s.Create(ctx, q, u.ID, testIP, "test-agent")
	require.NoError(t, err)
	raw, err := base64.RawURLEncoding.DecodeString(token)
	require.NoError(t, err)
	require.Len(t, raw, 32)
	require.Equal(t, u.ID, sess.UserID)
	require.False(t, sess.MFAPassed)
	require.Equal(t, clk.Now(), sess.CreatedAt)
	require.Equal(t, clk.Now(), sess.LastSeenAt)
	require.Equal(t, clk.Now().Add(7*24*time.Hour), sess.ExpiresAt)
	csrf, err := base64.RawURLEncoding.DecodeString(sess.CSRFToken)
	require.NoError(t, err)
	require.Len(t, csrf, 32)

	// Only the SHA-256 of the token is stored.
	var ids [][]byte
	rows, err := pool.Query(ctx, `SELECT id FROM sessions`)
	require.NoError(t, err)
	for rows.Next() {
		var id []byte
		require.NoError(t, rows.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, rows.Err())
	require.Len(t, ids, 1)
	require.Len(t, ids[0], 32)
	require.False(t, bytes.Equal(ids[0], raw))
	require.False(t, bytes.Equal(ids[0], []byte(token)))
	require.Equal(t, sess.ID, ids[0])

	clk.Advance(time.Minute)
	got, err := s.Lookup(ctx, q, token)
	require.NoError(t, err)
	require.Equal(t, u.ID, got.UserID)
	require.Equal(t, sess.CSRFToken, got.CSRFToken)
	require.Equal(t, sess.ID, got.ID)
	require.Equal(t, sess.ExpiresAt, got.ExpiresAt)
	require.Equal(t, clk.Now(), got.LastSeenAt)

	// Unknown and malformed tokens.
	other, _, err := s.Create(ctx, q, u.ID, testIP, "")
	require.NoError(t, err)
	require.NoError(t, s.Delete(ctx, q, other))
	for _, bad := range []string{"", "not-base64!", base64.RawURLEncoding.EncodeToString(make([]byte, 31)), other} {
		_, err := s.Lookup(ctx, q, bad)
		require.ErrorIs(t, err, ErrNoSession, "token %q", bad)
	}
}

func TestSessionCreateRejectsInvalidIP(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	_, _, err := (&Sessions{}).Create(ctx, q, u.ID, netip.Addr{}, "ua")
	require.Error(t, err)
}

func TestSessionCreateSanitisesUserAgent(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	long := "a\x00b\xffc" + string(bytes.Repeat([]byte("x"), 1000))
	_, sess, err := (&Sessions{}).Create(ctx, q, u.ID, testIP, long)
	require.NoError(t, err)
	var ua string
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_agent FROM sessions WHERE id = $1`, sess.ID).Scan(&ua))
	require.Len(t, ua, maxUserAgentLen)
	require.Equal(t, "abc", ua[:3])
}

func TestSessionIdleBoundary(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	clk := newClock()
	s := &Sessions{Now: clk.Now}

	token, _, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)

	clk.Advance(SessionIdleTimeout - time.Microsecond)
	got, err := s.Lookup(ctx, q, token)
	require.NoError(t, err)
	require.Equal(t, clk.Now(), got.LastSeenAt)

	// Just under the idle limit is still fine on a second session.
	token2, _, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)
	clk.Advance(SessionIdleTimeout - time.Microsecond)
	_, err = s.Lookup(ctx, q, token2)
	require.NoError(t, err)

	// Exactly at the idle limit after the first session's last-seen: expired.
	clk.Advance(time.Microsecond)
	_, err = s.Lookup(ctx, q, token)
	require.ErrorIs(t, err, ErrNoSession)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1`, got.ID).Scan(&n))
	require.Zero(t, n, "expired session row must be deleted")
}

func TestSessionTouch(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	clk := newClock()
	s := &Sessions{Now: clk.Now}
	_, sess, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)

	clk.Advance(time.Minute)
	require.NoError(t, s.Touch(ctx, q, sess.ID))
	got, err := q.GetSession(ctx, sess.ID)
	require.NoError(t, err)
	require.Equal(t, clk.Now(), got.LastSeenAt)
}

func TestSessionTouchRejectsExpired(t *testing.T) {
	for _, name := range []string{"idle", "absolute"} {
		t.Run(name, func(t *testing.T) {
			pool := store.NewTestDB(t)
			ctx := context.Background()
			q := db.New(pool)
			u := createTestUser(t, q, "alice", "correct horse battery")
			clk := newClock()
			s := &Sessions{Now: clk.Now}
			_, sess, err := s.Create(ctx, q, u.ID, testIP, "ua")
			require.NoError(t, err)
			if name == "idle" {
				clk.Advance(SessionIdleTimeout)
			} else {
				clk.t = sess.ExpiresAt
			}
			require.ErrorIs(t, s.Touch(ctx, q, sess.ID), ErrNoSession)
		})
	}
}

func TestSessionAbsoluteExpiry(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	clk := newClock()
	s := &Sessions{Now: clk.Now}
	start := clk.Now()

	token, sess, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)
	for clk.Now().Add(SessionIdleTimeout - time.Minute).Before(start.Add(SessionMaxAge)) {
		clk.Advance(SessionIdleTimeout - time.Minute)
		_, err := s.Lookup(ctx, q, token)
		require.NoError(t, err, "at %v", clk.Now().Sub(start))
	}
	clk.t = sess.ExpiresAt.Add(-time.Microsecond)
	_, err = s.Lookup(ctx, q, token)
	require.NoError(t, err)

	clk.t = start.Add(7 * 24 * time.Hour)
	_, err = s.Lookup(ctx, q, token)
	require.ErrorIs(t, err, ErrNoSession)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sessions`).Scan(&n))
	require.Zero(t, n)
}

func TestSessionRotate(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	clk := newClock()
	s := &Sessions{Now: clk.Now}

	token, sess, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)
	clk.Advance(time.Minute)

	newToken, rotated, err := s.Rotate(ctx, q, token, true)
	require.NoError(t, err)
	require.NotEqual(t, token, newToken)
	require.NotEqual(t, sess.ID, rotated.ID)
	require.NotEqual(t, sess.CSRFToken, rotated.CSRFToken)
	require.True(t, rotated.MFAPassed)
	require.Equal(t, sess.ExpiresAt, rotated.ExpiresAt)
	require.Equal(t, sess.CreatedAt, rotated.CreatedAt)
	require.Equal(t, clk.Now(), rotated.LastSeenAt)
	require.Equal(t, u.ID, rotated.UserID)

	_, err = s.Lookup(ctx, q, token)
	require.ErrorIs(t, err, ErrNoSession)
	got, err := s.Lookup(ctx, q, newToken)
	require.NoError(t, err)
	require.True(t, got.MFAPassed)
	require.Equal(t, sess.ExpiresAt, got.ExpiresAt)
	require.Equal(t, rotated.CSRFToken, got.CSRFToken)

	// The old token cannot be rotated again.
	_, _, err = s.Rotate(ctx, q, token, true)
	require.ErrorIs(t, err, ErrNoSession)

	// An idle-expired session cannot be rotated.
	clk.Advance(SessionIdleTimeout)
	_, _, err = s.Rotate(ctx, q, newToken, true)
	require.ErrorIs(t, err, ErrNoSession)
}

func TestSessionDeleteForUser(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	alice := createTestUser(t, q, "alice", "correct horse battery")
	bob := createTestUser(t, q, "bob", "correct horse battery")
	s := &Sessions{}

	a1, _, err := s.Create(ctx, q, alice.ID, testIP, "")
	require.NoError(t, err)
	a2, _, err := s.Create(ctx, q, alice.ID, testIP, "")
	require.NoError(t, err)
	b1, _, err := s.Create(ctx, q, bob.ID, testIP, "")
	require.NoError(t, err)

	require.NoError(t, s.DeleteForUser(ctx, q, alice.ID))
	for _, tok := range []string{a1, a2} {
		_, err := s.Lookup(ctx, q, tok)
		require.ErrorIs(t, err, ErrNoSession)
	}
	_, err = s.Lookup(ctx, q, b1)
	require.NoError(t, err)

	require.NoError(t, s.Delete(ctx, q, b1))
	_, err = s.Lookup(ctx, q, b1)
	require.ErrorIs(t, err, ErrNoSession)
	require.NoError(t, s.Delete(ctx, q, "garbage"))
	require.NoError(t, s.DeleteForUser(ctx, q, uuid.New()))
}

func TestSessionConcurrentRotateOneWins(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	s := &Sessions{}
	token, _, err := s.Create(ctx, q, u.ID, testIP, "")
	require.NoError(t, err)

	const n = 8
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			_, _, err := s.Rotate(ctx, q, token, true)
			errs <- err
		}()
	}
	ok := 0
	for i := 0; i < n; i++ {
		if err := <-errs; err == nil {
			ok++
		} else {
			require.ErrorIs(t, err, ErrNoSession)
		}
	}
	require.Equal(t, 1, ok)
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sessions`).Scan(&rows))
	require.Equal(t, 1, rows)
}
