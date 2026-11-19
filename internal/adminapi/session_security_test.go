package adminapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestSessionPersistenceRequiresMFA(t *testing.T) {
	for _, flow := range []string{"totp", "enrollment", "no_mfa"} {
		t.Run(flow, func(t *testing.T) {
			e := newEnv(t)
			e.markSetupComplete()
			owner, _ := e.signedIn("settings-owner", "owner")
			setLifetime(t, owner, "30d")
			opts := userOpts{}
			secret := ""
			if flow == "totp" {
				secret = newSecret(t)
				opts = userOpts{role: "owner", totpSecret: secret, totpRequired: true}
			} else if flow == "enrollment" {
				opts.totpRequired = true
			}
			e.createUser("alice", opts)
			c := e.client()
			login := c.login("alice", goodPassword)
			require.Equal(t, http.StatusOK, login.Code, login.Body.String())
			sess, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), c.cookie.Value)
			require.NoError(t, err)
			require.Equal(t, e.clock.Now().Add(30*24*time.Hour), sess.ExpiresAt)
			if flow == "no_mfa" {
				require.True(t, sess.Persistent)
				require.InDelta(t, 30*24*60*60, c.cookie.MaxAge, 1)
			} else {
				require.NotContains(t, login.Header().Get("Set-Cookie"), "Max-Age")
				require.Zero(t, c.cookie.MaxAge)
				require.False(t, sess.Persistent)
				abandoned := e.client()
				require.Equal(t, http.StatusOK, abandoned.login("alice", goodPassword).Code)
				e.clock.Add(2 * time.Minute)
				path := apiPrefix + "/auth/totp"
				if flow == "enrollment" {
					secret = c.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)["secret"].(string)
					path = apiPrefix + "/auth/totp/enroll/verify"
				}
				oldCookie := c.cookie.Value
				rec := c.do(http.MethodPost, path, map[string]string{"code": e.totpCode(secret)})
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				c.csrf = decodeBody(t, rec)["csrf_token"].(string)
				require.NotEqual(t, oldCookie, c.cookie.Value)
				require.InDelta(t, int((30*24*time.Hour-2*time.Minute)/time.Second), c.cookie.MaxAge, 1)
				rotated, err := e.d.Sessions.Lookup(t.Context(), db.New(e.d.Pool), c.cookie.Value)
				require.NoError(t, err)
				require.True(t, rotated.Persistent)
				require.True(t, rotated.MFAPassed)
				require.Equal(t, sess.CreatedAt, rotated.CreatedAt)
				require.Equal(t, sess.ExpiresAt, rotated.ExpiresAt)
				e.clock.Add(4 * time.Minute)
				requireError(t, abandoned.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, codeUnauthenticated)
			}
			e.clock.Add(6 * time.Hour)
			c.ok(http.MethodGet, apiPrefix+"/auth/me", nil)
		})
	}
}

type sessionTraceKey struct{}
type sessionRequestKey struct{}

// Query barriers force the competing transactions to overlap without sleeps.
type sessionQueryTrace struct {
	start func(context.Context, string)
	end   func(context.Context, string)
}

func (tr sessionQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if tr.start != nil {
		tr.start(ctx, data.SQL)
	}
	return context.WithValue(ctx, sessionTraceKey{}, data.SQL)
}

func (tr sessionQueryTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if tr.end != nil && data.Err == nil {
		tr.end(ctx, ctx.Value(sessionTraceKey{}).(string))
	}
}

func sessionTracedEnv(t *testing.T, tr sessionQueryTrace) *env {
	t.Helper()
	return newEnv(t, func(d *Deps) {
		cfg := d.Pool.Config()
		cfg.ConnConfig.Tracer = tr
		pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
		require.NoError(t, err)
		t.Cleanup(pool.Close)
		d.Pool = pool
	})
}

func sessionSecurityRequest(ctx context.Context, e *env, c *client, method, path string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(raw)).WithContext(ctx)
	req.Header.Set("Origin", publicURL)
	req.Header.Set(headerCSRF, c.csrf)
	req.AddCookie(c.cookie)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestSessionSettingsDeletedUpdater(t *testing.T) {
	var deleteUpdater func()
	e := sessionTracedEnv(t, sessionQueryTrace{end: func(ctx context.Context, sql string) {
		if ctx.Value(sessionRequestKey{}) == "get" && strings.Contains(sql, "-- name: GetSessionSettings :one") {
			deleteUpdater()
		}
	}})
	e.markSetupComplete()
	owner, _ := e.signedIn("owner", "owner")
	admin, _ := e.signedIn("admin", "admin")
	setLifetime(t, owner, "30d")
	// Use an updater without audit references, so deletion is allowed by the
	// audit log's RESTRICT FK. The row is read before its updater disappears.
	updaterID := e.createUser("updater", userOpts{})
	_, err := e.d.Pool.Exec(t.Context(), `UPDATE session_settings SET updated_by=$1`, updaterID)
	require.NoError(t, err)
	deleteUpdater = func() {
		_, err := e.d.Pool.Exec(t.Context(), `DELETE FROM users WHERE id=$1`, updaterID)
		require.NoError(t, err)
	}
	ctx := context.WithValue(t.Context(), sessionRequestKey{}, "get")
	rec := sessionSecurityRequest(ctx, e, admin, http.MethodGet, sessionSettingsPath, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Nil(t, decodeBody(t, rec)["updated_by"])
	validateResponse(t, httptest.NewRequest(http.MethodGet, sessionSettingsPath, nil), rec)
	// Also cover the FK's ordinary ON DELETE SET NULL path on the next GET.
	require.Nil(t, admin.ok(http.MethodGet, sessionSettingsPath, nil)["updated_by"])
}

func TestSessionSettingsConcurrentCredentials(t *testing.T) {
	for _, action := range []string{"password", "relogin"} {
		t.Run(action, func(t *testing.T) {
			var settingsLocked, actionAtSettings, release chan struct{}
			e := sessionTracedEnv(t, sessionQueryTrace{
				start: func(ctx context.Context, sql string) {
					if ctx.Value(sessionRequestKey{}) == "action" && strings.Contains(sql, "-- name: GetSessionSettingsForShare") {
						select {
						case actionAtSettings <- struct{}{}:
						default:
						}
					}
				},
				end: func(ctx context.Context, sql string) {
					if ctx.Value(sessionRequestKey{}) == "tighten" && strings.Contains(sql, "-- name: GetSessionSettingsForUpdate") {
						close(settingsLocked)
						select {
						case <-release:
						case <-ctx.Done():
						}
					}
				},
			})
			e.markSetupComplete()
			owner, _ := e.signedIn("owner", "owner")
			actor, actorID := e.signedIn("actor", "admin")
			for i := range 50 {
				setLifetime(t, owner, "30d")
				require.Equal(t, http.StatusOK, actor.login("actor", goodPassword).Code)
				extra := e.client()
				require.Equal(t, http.StatusOK, extra.login("actor", goodPassword).Code)
				settingsLocked, actionAtSettings, release = make(chan struct{}), make(chan struct{}, 1), make(chan struct{})
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				results := make(chan *httptest.ResponseRecorder, 2)
				go func() {
					results <- sessionSecurityRequest(context.WithValue(ctx, sessionRequestKey{}, "tighten"), e, owner,
						http.MethodPut, sessionSettingsPath, map[string]string{"lifetime": "8h"})
				}()
				select {
				case <-settingsLocked:
				case <-ctx.Done():
					cancel()
					t.Fatal("tightening did not acquire settings lock")
				}
				go func() {
					path := apiPrefix + "/auth/login"
					body := map[string]string{"username": "actor", "password": goodPassword}
					if action == "password" {
						path = apiPrefix + "/auth/password"
						body = map[string]string{"current_password": goodPassword, "new_password": goodPassword}
					}
					results <- sessionSecurityRequest(context.WithValue(ctx, sessionRequestKey{}, "action"), e, actor, http.MethodPost, path, body)
				}()
				select {
				case <-actionAtSettings:
				case <-ctx.Done():
					close(release)
					cancel()
					t.Fatal("credential request did not reach settings lock")
				}
				close(release)
				for range 2 {
					select {
					case rec := <-results:
						require.Equal(t, http.StatusOK, rec.Code, "iteration %d: %s", i, rec.Body.String())
					case <-ctx.Done():
						cancel()
						t.Fatal("concurrent credential request timed out")
					}
				}
				cancel()
				var overCap int
				require.NoError(t, e.d.Pool.QueryRow(t.Context(), `SELECT count(*) FROM sessions WHERE user_id=$1 AND expires_at > created_at + interval '8 hours'`, actorID).Scan(&overCap))
				require.Zero(t, overCap)
			}
		})
	}
}

func TestSessionPendingMFAIdle(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	owner, _ := e.signedIn("settings-owner", "owner")
	setLifetime(t, owner, "30d")
	e.createUser("alice", userOpts{role: "owner", totpSecret: newSecret(t), totpRequired: true})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("alice", goodPassword).Code)
	e.clock.Add(6 * time.Minute)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, codeUnauthenticated)
}

func TestSessionSettingsConcurrentUserLocks(t *testing.T) {
	updating := make(chan struct{})
	e := sessionTracedEnv(t, sessionQueryTrace{start: func(ctx context.Context, sql string) {
		if ctx.Value(sessionRequestKey{}) == "tighten" && strings.Contains(sql, "-- name: UpdateSessionSettings") {
			close(updating)
		}
	}})
	e.markSetupComplete()
	owner, ownerID := e.signedIn("owner", "owner")
	setLifetime(t, owner, "30d")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	userLocked := make(chan struct{})
	userDone := make(chan error, 1)
	go func() {
		userDone <- store.Tx(ctx, e.d.Pool, func(q *db.Queries) error {
			// Match the users -> sessions order of user-management handlers.
			if _, err := q.CountActiveOwners(ctx); err != nil {
				return err
			}
			close(userLocked)
			select {
			case <-updating:
			case <-ctx.Done():
				return ctx.Err()
			}
			return q.DeleteUserSessions(ctx, ownerID)
		})
	}()
	select {
	case <-userLocked:
	case <-ctx.Done():
		t.Fatal("user transaction did not acquire owner locks")
	}
	rec := sessionSecurityRequest(context.WithValue(ctx, sessionRequestKey{}, "tighten"), e, owner,
		http.MethodPut, sessionSettingsPath, map[string]string{"lifetime": "8h"})
	select {
	case err := <-userDone:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("user transaction timed out")
	}
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}
