package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestRunUserRevocationNotifies(t *testing.T) {
	for _, command := range []string{"set-password", "reset-totp"} {
		t.Run(command, func(t *testing.T) {
			pool := store.NewTestDB(t)
			ctx := context.Background()
			user, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "alice", Role: "admin"})
			require.NoError(t, err)
			listener, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
			require.NoError(t, err)
			t.Cleanup(func() { _ = listener.Close(ctx) })
			_, err = listener.Exec(ctx, "LISTEN ferricade_events")
			require.NoError(t, err)
			u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
			require.NoError(t, err)
			u.Path = "/" + pool.Config().ConnConfig.Database
			getenv := func(k string) string {
				if k == "DATABASE_URL" {
					return u.String()
				}
				return ""
			}
			var out, errOut bytes.Buffer
			require.Equal(t, 0, runUserInput(ctx, []string{command, "alice"}, getenv,
				strings.NewReader("Frosted pencils meet harbor lights\nFrosted pencils meet harbor lights\n"), &out, &errOut), errOut.String())
			waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			for {
				n, err := listener.WaitForNotification(waitCtx)
				require.NoError(t, err, "CLI revocation did not notify grants")
				var payload struct {
					Kind   string `json:"kind"`
					UserID string `json:"user_id"`
				}
				require.NoError(t, json.Unmarshal([]byte(n.Payload), &payload))
				if payload.Kind == "grants" {
					require.Equal(t, user.ID.String(), payload.UserID)
					break
				}
			}
		})
	}
}

func TestRunUserUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"unlock"}, {"nope", "alice"}, {"unlock", "a", "b"}} {
		var out, errOut bytes.Buffer
		require.Equal(t, 2, runUser(context.Background(), args, func(string) string { return "" }, &out, &errOut), "%v", args)
		require.Contains(t, errOut.String(), "usage: ferricade user")
		require.Empty(t, out.String())
	}
	var out, errOut bytes.Buffer
	require.Equal(t, 1, runUser(context.Background(), []string{"unlock", "alice"}, func(string) string { return "" }, &out, &errOut))
	require.Contains(t, errOut.String(), "DATABASE_URL is required")
}

func TestRunUser(t *testing.T) {
	pool := store.NewTestDB(t)
	ctx := context.Background()
	hash, err := auth.HashPassword(ctx, "correct horse battery staple", auth.TestParams)
	require.NoError(t, err)
	_, err = db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "alice", Role: "owner", PasswordHash: &hash, TOTPRequired: true})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET failed_logins = 5`)
	require.NoError(t, err)
	// Only DATABASE_URL is needed.
	u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	require.NoError(t, err)
	u.Path = "/" + pool.Config().ConnConfig.Database
	dbURL := u.String()
	getenv := func(k string) string {
		if k == "DATABASE_URL" {
			return dbURL
		}
		return ""
	}

	var out, errOut bytes.Buffer
	require.Equal(t, 0, runUser(ctx, []string{"unlock", "alice"}, getenv, &out, &errOut), errOut.String())
	require.Equal(t, "unlocked user alice (had 5 failed sign-ins)\n", out.String())

	out.Reset()
	require.Equal(t, 0, runUser(ctx, []string{"reset-totp", "alice"}, getenv, &out, &errOut), errOut.String())
	require.Equal(t, "reset TOTP of user alice (was enrolled: false); its sessions are ended; redo the setup TOTP step\n", out.String())

	out.Reset()
	require.Equal(t, 1, runUser(ctx, []string{"unlock", "bob"}, getenv, &out, &errOut))
	require.Contains(t, errOut.String(), `no user "bob"`)
	require.Empty(t, out.String())

	out.Reset()
	errOut.Reset()
	alice, err := db.New(pool).GetUserByUsername(ctx, "alice")
	require.NoError(t, err)
	var session auth.Session
	require.NoError(t, store.Tx(ctx, pool, func(q *db.Queries) error {
		_, session, err = (&auth.Sessions{}).Create(ctx, q, alice.ID, netip.MustParseAddr("127.0.0.1"), "test")
		return err
	}))
	_, err = pool.Exec(ctx, `UPDATE users SET failed_logins = 5, locked_until = now() + interval '1 hour' WHERE id = $1`, alice.ID)
	require.NoError(t, err)
	require.Equal(t, 0, runUserInput(ctx, []string{"set-password", "alice"}, getenv,
		strings.NewReader("Frosted pencils meet harbor lights\nFrosted pencils meet harbor lights\n"), &out, &errOut), errOut.String())
	require.Contains(t, out.String(), "password set for user alice")
	user, err := db.New(pool).GetUserByUsername(ctx, "alice")
	require.NoError(t, err)
	require.Zero(t, user.FailedLogins)
	require.Nil(t, user.LockedUntil)
	require.NotNil(t, user.PasswordHash)
	valid, err := auth.VerifyPassword(ctx, *user.PasswordHash, "Frosted pencils meet harbor lights")
	require.NoError(t, err)
	require.True(t, valid)
	_, err = (&auth.Sessions{}).Check(ctx, db.New(pool), session.ID)
	require.ErrorIs(t, err, auth.ErrNoSession)
	var audited int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='user.password_set_cli' AND target_id=$1", user.ID.String()).Scan(&audited))
	require.Equal(t, 1, audited)
}
