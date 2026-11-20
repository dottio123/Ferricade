package auth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestSessionPersistentLifetime(t *testing.T) {
	for _, tc := range []struct {
		lifetime string
		duration time.Duration
		idle     time.Duration
	}{{"8h", 8 * time.Hour, 6 * time.Hour}, {"1d", 24 * time.Hour, 6 * time.Hour}, {"7d", 7 * 24 * time.Hour, 6 * time.Hour}, {"30d", 30 * 24 * time.Hour, 29 * 24 * time.Hour}} {
		t.Run(tc.lifetime, func(t *testing.T) {
			pool := store.NewTestDB(t)
			ctx := context.Background()
			q := db.New(pool)
			u := createTestUser(t, q, "alice", "correct horse battery")
			_, err := pool.Exec(ctx, `UPDATE session_settings SET lifetime=$1`, tc.lifetime)
			require.NoError(t, err)
			clk := newClock()
			s := &Sessions{Now: clk.Now}
			token, sess, err := s.Create(ctx, q, u.ID, testIP, "ua")
			require.NoError(t, err)
			require.Equal(t, clk.Now().Add(tc.duration), sess.ExpiresAt)
			clk.Advance(tc.idle)
			_, err = s.Check(ctx, q, sess.ID)
			require.NoError(t, err)
			require.NoError(t, s.Touch(ctx, q, sess.ID))
			_, err = s.Lookup(ctx, q, token)
			require.NoError(t, err)
			clk.t = sess.ExpiresAt
			_, err = s.Check(ctx, q, sess.ID)
			require.ErrorIs(t, err, ErrNoSession)
			require.ErrorIs(t, s.Touch(ctx, q, sess.ID), ErrNoSession)
			_, err = s.Lookup(ctx, q, token)
			require.ErrorIs(t, err, ErrNoSession)
		})
	}
}

func TestSessionPersistentRotation(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	q := db.New(pool)
	u := createTestUser(t, q, "alice", "correct horse battery")
	_, err := pool.Exec(ctx, `UPDATE session_settings SET lifetime='1d'`)
	require.NoError(t, err)
	clk := newClock()
	s := &Sessions{Now: clk.Now}
	token, original, err := s.Create(ctx, q, u.ID, testIP, "ua")
	require.NoError(t, err)
	clk.Advance(time.Hour)
	newToken, rotated, err := s.Rotate(ctx, q, token, true)
	require.NoError(t, err)
	require.Equal(t, original.ExpiresAt, rotated.ExpiresAt)
	require.Equal(t, original.CreatedAt, rotated.CreatedAt)
	require.NotEqual(t, original.ID, rotated.ID)
	require.NotEqual(t, original.CSRFToken, rotated.CSRFToken)
	_, err = s.Lookup(ctx, q, token)
	require.ErrorIs(t, err, ErrNoSession)
	clk.Advance(22 * time.Hour)
	_, err = s.Lookup(ctx, q, newToken)
	require.NoError(t, err, "rotation must preserve persistence")
}

func TestSessionMFAPromotionUsesCurrentLifetime(t *testing.T) {
	for _, tc := range []struct {
		initial, current string
		want             time.Duration
	}{
		{"30d", "8h", 8 * time.Hour},
		{"browser", "30d", SessionMaxAge},
		{"30d", "browser", SessionMaxAge},
	} {
		t.Run(tc.initial+"_to_"+tc.current, func(t *testing.T) {
			pool := store.NewTestDB(t)
			ctx := t.Context()
			q := db.New(pool)
			u := createTestUser(t, q, "alice", "correct horse battery")
			_, err := pool.Exec(ctx, `UPDATE users SET totp_required=true WHERE id=$1`, u.ID)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE session_settings SET lifetime=$1`, tc.initial)
			require.NoError(t, err)
			clk := newClock()
			s := &Sessions{Now: clk.Now}
			var token string
			var original, rotated Session
			require.NoError(t, store.Tx(ctx, pool, func(q *db.Queries) error {
				var err error
				token, original, err = s.Create(ctx, q, u.ID, testIP, "ua")
				return err
			}))
			_, err = pool.Exec(ctx, `UPDATE session_settings SET lifetime=$1`, tc.current)
			require.NoError(t, err)
			clk.Advance(2 * time.Minute)
			require.NoError(t, store.Tx(ctx, pool, func(q *db.Queries) error {
				var err error
				_, rotated, err = s.Rotate(ctx, q, token, true)
				return err
			}))
			require.Equal(t, tc.current != "browser", rotated.Persistent)
			require.Equal(t, original.CreatedAt.Add(tc.want), rotated.ExpiresAt)
			require.Equal(t, original.CreatedAt, rotated.CreatedAt)
		})
	}
}
