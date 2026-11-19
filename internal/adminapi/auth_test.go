package adminapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/recovery"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const protectedPath = apiPrefix + "/server/client-config"

func TestResetsAndCLIUnlockClearTOTPLockout(t *testing.T) {
	for _, reset := range []string{"http-password", "cli-unlock", "http-totp", "cli-totp"} {
		t.Run(reset, func(t *testing.T) {
			e := newEnv(t)
			e.markSetupComplete()
			owner, _ := e.signedIn("alice", "owner")
			secret := newSecret(t)
			id := e.createUser("bob", userOpts{totpSecret: secret, totpRequired: true})
			c := e.client()
			c.remote = "198.51.100.7:4000"
			require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
			for i := 0; i < 5; i++ {
				rec := c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": wrongCode(e, secret)})
				if i == 4 {
					requireError(t, rec, http.StatusLocked, "locked")
				} else {
					requireError(t, rec, http.StatusBadRequest, "invalid_code")
				}
			}
			password := goodPassword
			switch reset {
			case "http-password":
				password = "a brand new passphrase"
				owner.ok(http.MethodPost, apiPrefix+"/users/"+id.String()+"/password", map[string]string{"password": password})
			case "cli-unlock":
				_, err := recovery.UnlockUser(context.Background(), e.d.Pool, "bob")
				require.NoError(t, err)
			case "http-totp":
				owner.ok(http.MethodPost, apiPrefix+"/users/"+id.String()+"/reset-totp", nil)
			case "cli-totp":
				_, err := recovery.ResetUserTOTP(context.Background(), e.d.Pool, "bob")
				require.NoError(t, err)
			}
			require.Equal(t, http.StatusOK, c.login("bob", password).Code)
			if reset == "http-totp" || reset == "cli-totp" {
				secret = c.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)["secret"].(string)
				c.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": e.totpCode(secret)})
				e.clock.Add(30 * time.Second)
				require.Equal(t, http.StatusOK, c.login("bob", password).Code)
			}
			rec := c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)})
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		})
	}
}

func TestTOTPLockoutSurvivesRestart(t *testing.T) {
	e := newEnv(t)
	secret := newSecret(t)
	e.createUser("bob", userOpts{totpSecret: secret})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	for i := 0; i < 5; i++ {
		c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": wrongCode(e, secret)})
	}
	e.h = New(e.d)
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)}), http.StatusLocked, "locked")
}

func TestUnknownUserLockoutSurvivesSpray(t *testing.T) {
	e := newEnv(t)
	a := newAPI(e.d)
	e.h = http.HandlerFunc(a.login)
	key := unknownUserKey("ghost")
	for i := 0; i < 5; i++ {
		a.unknownUsers.Fail(key, e.clock.Now())
	}
	// Exercise the lockout layer directly to avoid 10,001 unnecessary Argon2id hashes.
	for i := 0; i <= 10_000; i++ {
		a.unknownUsers.Fail(unknownUserKey(fmt.Sprintf("spray%d", i)), e.clock.Now())
	}
	requireError(t, e.client().login("GHOST", "anything at all"), http.StatusLocked, "locked")
}

func TestLoginLooksUpUsernameOnce(t *testing.T) {
	e := newEnv(t)
	e.createUser("known", userOpts{})
	a := newAPI(e.d)
	for _, tc := range []struct {
		name, username, password string
		locked                   bool
		want                     int
	}{
		{name: "known", username: "known", password: "wrong password!", want: http.StatusUnauthorized},
		{name: "unknown", username: "missing", password: "wrong password!", want: http.StatusUnauthorized},
		{name: "locked unknown", username: "ghost", password: "wrong password!", locked: true, want: http.StatusLocked},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.locked {
				for i := 0; i < 5; i++ {
					a.unknownUsers.Fail(unknownUserKey(tc.username), e.clock.Now())
				}
			}
			queries := 0
			lookup := func(ctx context.Context, q *db.Queries, username string) (*db.User, error) {
				queries++
				return lookupUser(ctx, q, username)
			}
			req := httptest.NewRequest(http.MethodPost, apiPrefix+"/auth/login", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":%q}`, tc.username, tc.password)))
			req.RemoteAddr = "198.51.100.9:1234"
			rec := httptest.NewRecorder()
			a.loginWithLookup(rec, req, lookup)
			require.Equal(t, tc.want, rec.Code)
			require.Equal(t, 1, queries)
		})
	}
}

func TestLockedUnknownLoginDoesNotNeedArgonSlot(t *testing.T) {
	e := newEnv(t)
	e.createUser("locked", userOpts{})
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET locked_until=$1 WHERE username='locked'`, e.clock.Now().Add(time.Minute))
	require.NoError(t, err)
	a := newAPI(e.d)
	for i := 0; i < 5; i++ {
		a.unknownUsers.Fail(unknownUserKey("ghost"), e.clock.Now())
	}
	defer auth.SetArgonLimit(1, 5*time.Millisecond)()
	release, err := auth.AcquireArgonSlot(context.Background())
	require.NoError(t, err)
	defer release()

	login := func(username string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, apiPrefix+"/auth/login", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":"anything"}`, username)))
		req.RemoteAddr = "198.51.100.9:1234"
		rec := httptest.NewRecorder()
		a.loginWithLookup(rec, req, lookupUser)
		return rec
	}
	requireError(t, login("locked"), http.StatusLocked, "locked")
	requireError(t, login("ghost"), http.StatusLocked, "locked")
}

func TestLoginTOTPFlow(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	secret := newSecret(t)
	id := e.createUser("bob", userOpts{totpSecret: secret})
	c := e.client()

	rec := c.login("bob", goodPassword)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := decodeBody(t, rec)
	require.Equal(t, true, body["mfa_required"])
	loginCSRF := body["csrf_token"].(string)
	require.NotEmpty(t, loginCSRF)
	loginCookie := c.cookie
	require.NotNil(t, loginCookie)

	requireError(t, c.do(http.MethodGet, protectedPath, nil), http.StatusForbidden, "mfa_required")
	rec = c.do(http.MethodGet, apiPrefix+"/auth/me", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	me := decodeBody(t, rec)
	require.Equal(t, false, me["mfa_passed"])
	require.Equal(t, true, me["totp_enrolled"])
	require.Equal(t, loginCSRF, me["csrf_token"])
	require.Equal(t, "bob", me["user"].(map[string]any)["username"])
	require.Equal(t, false, me["user"].(map[string]any)["sso"])
	require.Nil(t, me["user"].(map[string]any)["avatar_url"])

	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": wrongCode(e, secret)}),
		http.StatusBadRequest, "invalid_code")
	require.Equal(t, http.StatusOK, c.do(http.MethodGet, apiPrefix+"/auth/me", nil).Code, "a wrong code keeps the session")

	rec = c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rawCookie := rec.Header().Get("Set-Cookie")
	require.NotContains(t, rawCookie, "Max-Age")
	require.NotContains(t, rawCookie, "Expires=")
	newCSRF := decodeBody(t, rec)["csrf_token"].(string)
	require.NotEqual(t, loginCSRF, newCSRF, "rotation issues a new CSRF token")
	require.NotEqual(t, loginCookie.Value, c.cookie.Value, "cookie rotated")
	c.csrf = newCSRF

	rec = c.do(http.MethodGet, protectedPath, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = c.do(http.MethodGet, apiPrefix+"/auth/me", nil)
	require.Equal(t, true, decodeBody(t, rec)["mfa_passed"])

	old := e.client()
	old.cookie = loginCookie
	requireError(t, old.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")

	row, err := db.New(e.d.Pool).GetUserByID(context.Background(), id)
	require.NoError(t, err)
	require.Equal(t, e.clock.Now().Unix()/30, row.TOTPLastStep, "totp_last_step stored")
	require.Len(t, e.auditEntries("auth.login"), 1)
	require.Len(t, e.auditEntries("auth.mfa_passed"), 1)
	failed := e.auditEntries("auth.login_failed")
	require.Len(t, failed, 1)
	require.Equal(t, "invalid_totp", failed[0].Details["reason"])
}

func TestTOTPCodeCannotBeReplayed(t *testing.T) {
	e := newEnv(t)
	secret := newSecret(t)
	e.createUser("bob", userOpts{totpSecret: secret})
	code := e.totpCode(secret)

	first := e.client()
	require.Equal(t, http.StatusOK, first.login("bob", goodPassword).Code)
	require.Equal(t, http.StatusOK, first.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": code}).Code)

	second := e.client()
	require.Equal(t, http.StatusOK, second.login("bob", goodPassword).Code)
	// A reused code is refused but not counted: repeating it never locks.
	for i := 0; i < 7; i++ {
		rec := second.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": code})
		requireError(t, rec, http.StatusBadRequest, "code_already_used")
		require.Equal(t, "code already used; wait for the next code",
			decodeBody(t, rec)["error"].(map[string]any)["message"])
	}
	require.Empty(t, e.auditEntries("auth.login_failed"), "not a failure")
	e.clock.Add(30 * time.Second)
	rec := second.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// wrongCode returns a code that is not valid for secret around now.
func wrongCode(e *env, secret string) string {
	valid := map[string]bool{}
	for _, d := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		c, err := auth.TOTPCode(secret, e.clock.Now().Add(d))
		require.NoError(e.t, err)
		valid[c] = true
	}
	for _, c := range []string{"000000", "111111", "222222", "333333"} {
		if !valid[c] {
			return c
		}
	}
	panic("unreachable")
}

// rawRequest builds a request carrying c's cookie, CSRF token and origin
// without touching c, so it can be sent from several goroutines.
func (c *client) rawRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if c.remote != "" {
		req.RemoteAddr = c.remote
	}
	req.Header.Set("Origin", publicURL)
	req.Header.Set("X-CSRF-Token", c.csrf)
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	return req
}

// burst sends n requests built by mk concurrently and returns the status
// codes. Each response is checked against openapi.yaml.
func burst(t *testing.T, h http.Handler, n int, mk func(i int) *http.Request) map[int]int {
	var mu sync.Mutex
	codes := map[int]int{}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		req := mk(i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			validateResponse(t, req, rec)
			mu.Lock()
			codes[rec.Code]++
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()
	return codes
}

func TestTOTPConcurrentGuessesBounded(t *testing.T) {
	e := newEnv(t)
	secret := newSecret(t)
	e.createUser("bob", userOpts{totpSecret: secret})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	body := `{"code":"` + wrongCode(e, secret) + `"}`

	codes := burst(t, e.h, 40, func(int) *http.Request {
		return c.rawRequest(http.MethodPost, apiPrefix+"/auth/totp", body)
	})
	evaluated := 0
	for _, f := range e.auditEntries("auth.login_failed") {
		if f.Details["reason"] == "invalid_totp" {
			evaluated++
		}
	}
	require.LessOrEqual(t, evaluated, 5, "codes evaluated in a burst of 40: %v", codes)
	require.GreaterOrEqual(t, evaluated, 1)
	require.Equal(t, 40, codes[http.StatusBadRequest]+codes[http.StatusLocked]+codes[http.StatusTooManyRequests], codes)
	// From a fresh address (the burst also used up this one), the account's
	// TOTP is locked even for the right code.
	c.remote = "198.51.100.7:4000"
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": e.totpCode(secret)}),
		http.StatusLocked, "locked")
}

func TestLoginConcurrentBurstIPBounded(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 15; i++ {
		e.createUser(fmt.Sprintf("user%d", i), userOpts{})
	}
	codes := burst(t, e.h, 60, func(i int) *http.Request {
		body := fmt.Sprintf(`{"username":"user%d","password":"wrong password!"}`, i%15)
		return e.client().rawRequest(http.MethodPost, apiPrefix+"/auth/login", body)
	})
	evaluated := len(e.auditEntries("auth.login_failed"))
	require.LessOrEqual(t, evaluated, 20, "logins evaluated in a burst of 60: %v", codes)
	require.Equal(t, 60-evaluated, codes[http.StatusTooManyRequests], codes)
	requireError(t, e.client().login("user0", goodPassword), http.StatusTooManyRequests, "rate_limited")
}

func TestTOTPGuessingLocks(t *testing.T) {
	e := newEnv(t)
	secret := newSecret(t)
	e.createUser("bob", userOpts{totpSecret: secret})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	wrong := map[string]string{"code": wrongCode(e, secret)}
	for i := 1; i <= 4; i++ {
		requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", wrong), http.StatusBadRequest, "invalid_code")
	}
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", wrong), http.StatusLocked, "locked")
	good := map[string]string{"code": e.totpCode(secret)}
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", good), http.StatusLocked, "locked")

	// A fresh password login does not reset the TOTP lock.
	again := e.client()
	require.Equal(t, http.StatusOK, again.login("bob", goodPassword).Code)
	requireError(t, again.do(http.MethodPost, apiPrefix+"/auth/totp", good), http.StatusLocked, "locked")

	e.clock.Add(time.Minute)
	good = map[string]string{"code": e.totpCode(secret)}
	require.Equal(t, http.StatusOK, again.do(http.MethodPost, apiPrefix+"/auth/totp", good).Code)
	e.clock.Add(30 * time.Second)
	require.Equal(t, http.StatusOK, again.login("bob", goodPassword).Code)
	requireError(t, again.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": wrongCode(e, secret)}),
		http.StatusBadRequest, "invalid_code")
}

func TestInFlightTOTPAfterRevocation(t *testing.T) {
	for _, change := range []string{"session-deleted", "user-disabled", "totp-reset"} {
		t.Run(change, func(t *testing.T) {
			e := newEnv(t)
			secret := newSecret(t)
			id := e.createUser("bob", userOpts{totpSecret: secret})
			c := e.client()
			require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
			ctx := context.Background()
			q := db.New(e.d.Pool)
			sess, err := e.d.Sessions.Lookup(ctx, q, c.cookie.Value)
			require.NoError(t, err)
			row, err := q.GetUserByID(ctx, id)
			require.NoError(t, err)
			info := authInfo{session: sess, user: auth.UserFromRow(row), token: c.cookie.Value}
			status, code := http.StatusUnauthorized, "unauthenticated"
			switch change {
			case "session-deleted":
				_, err = q.DeleteSession(ctx, sess.ID)
			case "user-disabled":
				_, err = e.d.Pool.Exec(ctx, `UPDATE users SET status = 'disabled' WHERE id = $1`, id)
			case "totp-reset":
				err = q.ResetUserTOTP(ctx, id)
				status, code = http.StatusBadRequest, "bad_request"
			}
			require.NoError(t, err)
			before, err := q.GetUserByID(ctx, id)
			require.NoError(t, err)
			// Keep the loaded auth context to model revocation before the handler's row lock.
			req := c.rawRequest(http.MethodPost, apiPrefix+"/auth/totp", fmt.Sprintf(`{"code":%q}`, wrongCode(e, secret)))
			rec := httptest.NewRecorder()
			newAPI(e.d).verifyTOTP(rec, req.WithContext(withAuth(ctx, info)))
			after, err := q.GetUserByID(ctx, id)
			require.NoError(t, err)
			if after.TotpFailedLogins != before.TotpFailedLogins {
				t.Errorf("revoked request counted a TOTP failure: %d -> %d", before.TotpFailedLogins, after.TotpFailedLogins)
			}
			requireError(t, rec, status, code)
		})
	}
}

func TestCookieFlags(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	rec := e.client().login("bob", goodPassword)
	require.Equal(t, http.StatusOK, rec.Code)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	ck := cookies[0]
	require.Equal(t, "__Host-ferricade_session", ck.Name)
	require.True(t, ck.Secure)
	require.True(t, ck.HttpOnly)
	require.Equal(t, http.SameSiteStrictMode, ck.SameSite)
	require.Equal(t, "/", ck.Path)
	require.Empty(t, ck.Domain)
	require.Zero(t, ck.MaxAge)
	require.True(t, ck.Expires.IsZero())
	raw := rec.Header().Get("Set-Cookie")
	require.NotContains(t, raw, "Max-Age")
	require.NotContains(t, raw, "Expires=")
	require.Contains(t, raw, "; Secure")
	require.Contains(t, raw, "; HttpOnly")
	require.Contains(t, raw, "; SameSite=Strict")

	dev := newEnv(t, func(d *Deps) {
		d.Cfg.DevInsecure = true
		d.Cfg.PublicURL.Scheme = "http"
	})
	dev.createUser("bob", userOpts{})
	c := dev.client()
	c.origin = "http://admin.example.com"
	rec = c.login("bob", goodPassword)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	ck = rec.Result().Cookies()[0]
	require.Equal(t, "ferricade_session", ck.Name)
	require.False(t, ck.Secure)
	require.True(t, ck.HttpOnly)
	require.Equal(t, http.SameSiteStrictMode, ck.SameSite)
}

func TestLogout(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	token := c.cookie

	rec := c.do(http.MethodPost, apiPrefix+"/auth/logout", nil)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	require.Contains(t, rec.Header().Get("Set-Cookie"), "Max-Age=0")
	require.Nil(t, c.cookie, "cookie cleared")
	require.Len(t, e.auditEntries("auth.logout"), 1)

	stale := e.client()
	stale.cookie = token
	requireError(t, stale.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestSessionExpiresAfterFiveMinutesWithoutRequests(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	e.clock.Add(5 * time.Minute)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestLoginRotatesAwayOldSession(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	first := c.cookie
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code, "login needs no CSRF token")
	require.NotEqual(t, first.Value, c.cookie.Value)
	stale := e.client()
	stale.cookie = first
	requireError(t, stale.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestLoginLockoutResponse(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 4; i++ {
		e.createUser(fmt.Sprintf("user%d", i), userOpts{})
	}
	c := e.client()
	for i := 1; i <= 4; i++ {
		requireError(t, c.login("user0", "wrong password!"), http.StatusUnauthorized, "unauthenticated")
	}
	requireError(t, c.login("user0", "wrong password!"), http.StatusLocked, "locked")
	requireError(t, c.login("user0", goodPassword), http.StatusLocked, "locked")

	// 20 failures from one address, across accounts, block it: 6 above.
	for i := 0; i < 14; i++ {
		rec := c.login(fmt.Sprintf("user%d", 1+i%3), "wrong password!")
		require.Contains(t, []int{http.StatusUnauthorized, http.StatusLocked}, rec.Code)
	}
	requireError(t, c.login("user1", goodPassword), http.StatusTooManyRequests, "rate_limited")
	requireError(t, c.login("user3", goodPassword), http.StatusTooManyRequests, "rate_limited")

	other := e.client()
	other.remote = "198.51.100.7:4000"
	require.Equal(t, http.StatusOK, other.login("user3", goodPassword).Code, "other addresses are unaffected")

	e.clock.Add(10 * time.Minute)
	require.Equal(t, http.StatusOK, c.login("user3", goodPassword).Code, "the window slides")
}

func TestLoginIPv6LimitedPer64(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < 5; i++ {
		e.createUser(fmt.Sprintf("user%d", i), userOpts{})
	}
	// Failures from different addresses in one /64 are counted together.
	for i := 0; i < 20; i++ {
		c := e.client()
		c.remote = fmt.Sprintf("[2001:db8:9:9::%x]:4000", i+1)
		c.login(fmt.Sprintf("user%d", i%4), "wrong password!")
	}
	same := e.client()
	same.remote = "[2001:db8:9:9:ffff::abcd]:4000"
	requireError(t, same.login("user4", goodPassword), http.StatusTooManyRequests, "rate_limited")
	other := e.client()
	other.remote = "[2001:db8:9:a::1]:4000"
	require.Equal(t, http.StatusOK, other.login("user4", goodPassword).Code, "another /64 is unaffected")
}

func TestUnknownUserLockoutLooksReal(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	real, ghost := e.client(), e.client()
	ghost.remote = "198.51.100.7:4000"
	for i := 1; i <= 5; i++ {
		r := real.login("bob", "wrong password!")
		g := ghost.login("Ghost", "wrong password!")
		require.Equal(t, r.Code, g.Code, "attempt %d", i)
		require.JSONEq(t, r.Body.String(), g.Body.String(), "attempt %d", i)
	}
	requireError(t, ghost.login("ghost", "anything at all"), http.StatusLocked, "locked")
	requireError(t, ghost.login("GHOST", "anything at all"), http.StatusLocked, "locked")

	e.clock.Add(time.Minute)
	r := real.login("bob", "wrong password!")
	g := ghost.login("ghost", "wrong password!")
	requireError(t, r, http.StatusLocked, "locked")
	require.Equal(t, r.Code, g.Code, "the sixth failure locks both again")

	failed := e.auditEntries("auth.login_failed")
	var ghostEntries int
	for _, f := range failed {
		if f.TargetID == "" {
			ghostEntries++
			require.Equal(t, "user", f.TargetType)
			require.Contains(t, []any{"Ghost", "ghost", "GHOST"}, f.Details["username"])
		}
	}
	require.Equal(t, 8, ghostEntries)
}

func TestLoginFailedAuditTruncatesUsername(t *testing.T) {
	e := newEnv(t)
	long := strings.Repeat("é", 70) + "\x00"
	requireError(t, e.client().login(long, "wrong password!"), http.StatusUnauthorized, "unauthenticated")
	failed := e.auditEntries("auth.login_failed")
	require.Len(t, failed, 1)
	require.Equal(t, "user", failed[0].TargetType)
	require.Empty(t, failed[0].TargetID)
	require.Equal(t, strings.Repeat("é", 64), failed[0].Details["username"])
	require.Nil(t, failed[0].ActorUserID)
	require.Equal(t, "192.0.2.1", failed[0].ActorIP.String())
}

func TestTOTPRequiredUserLimited(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("carol", userOpts{totpRequired: true})
	c := e.client()
	rec := c.login("carol", goodPassword)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, true, decodeBody(t, rec)["mfa_required"])

	requireError(t, c.do(http.MethodGet, protectedPath, nil), http.StatusForbidden, "totp_enroll_required")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/password",
		map[string]string{"current_password": goodPassword, "new_password": "a different long passphrase"}),
		http.StatusForbidden, "totp_enroll_required")
	require.Equal(t, http.StatusOK, c.do(http.MethodGet, apiPrefix+"/auth/me", nil).Code)

	rec = c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := decodeBody(t, rec)
	secret := body["secret"].(string)
	require.Contains(t, body["otpauth_url"], "otpauth://totp/ferricade:carol?")

	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": "notnum"}),
		http.StatusBadRequest, "invalid_code")
	rec = c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	c.csrf = decodeBody(t, rec)["csrf_token"].(string)
	require.Equal(t, http.StatusOK, c.do(http.MethodGet, protectedPath, nil).Code, "enrolling passes MFA")
	require.Len(t, e.auditEntries("auth.totp_enrolled"), 1)

	// Now enrolled: a new password-only session must pass TOTP first, and
	// cannot replace the secret without it.
	again := e.client()
	require.Equal(t, http.StatusOK, again.login("carol", goodPassword).Code)
	requireError(t, again.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil), http.StatusForbidden, "mfa_required")
	requireError(t, again.do(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": "123456"}),
		http.StatusForbidden, "mfa_required")
}

func TestEnrollVerifyNeedsEnrollStart(t *testing.T) {
	e := newEnv(t)
	e.createUser("dave", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("dave", goodPassword).Code)
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": "123456"}),
		http.StatusConflict, "incomplete")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp", map[string]string{"code": "123456"}),
		http.StatusBadRequest, "bad_request")
}

func TestTOTPReenrollRequiresCurrentPassword(t *testing.T) {
	e := newEnv(t)
	e.createUser("reenroll", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("reenroll", goodPassword).Code)
	secret := c.ok(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)["secret"].(string)
	rec := c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll/verify", map[string]string{"code": e.totpCode(secret)})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	c.csrf = decodeBody(t, rec)["csrf_token"].(string)

	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil), http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", map[string]string{"current_password": "wrong password"}), http.StatusForbidden, "forbidden")
	rec = c.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", map[string]string{"current_password": goodPassword})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestSSOOnlyTOTPReenrollRequiresRecentSignIn(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	ctx := context.Background()
	row, err := db.New(e.d.Pool).CreateUser(ctx, db.CreateUserParams{Username: "sso-only", Role: "admin"})
	require.NoError(t, err)
	secret, err := auth.NewTOTPSecret()
	require.NoError(t, err)
	sealed, err := e.d.Sealer.Seal([]byte(secret))
	require.NoError(t, err)
	require.NoError(t, db.New(e.d.Pool).SetTOTP(ctx, db.SetTOTPParams{ID: row.ID, TOTPSecretEnc: sealed}))
	newSession := func() *client {
		c := e.client()
		var token string
		var sess auth.Session
		require.NoError(t, store.Tx(ctx, e.d.Pool, func(q *db.Queries) error {
			var err error
			token, sess, err = e.d.Sessions.Create(ctx, q, row.ID, netip.MustParseAddr("192.0.2.1"), "test")
			return err
		}))
		_, err = e.d.Pool.Exec(ctx, `UPDATE sessions SET mfa_passed = true WHERE user_id = $1`, row.ID)
		require.NoError(t, err)
		c.cookie = &http.Cookie{Name: sessionCookieName(e.d.Cfg), Value: token}
		c.csrf = sess.CSRFToken
		return c
	}

	fresh := newSession()
	rec := fresh.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	stale := newSession()
	_, err = e.d.Pool.Exec(ctx, `UPDATE sessions SET created_at = $1 WHERE user_id = $2`, e.clock.Now().Add(-6*time.Minute), row.ID)
	require.NoError(t, err)
	requireError(t, stale.do(http.MethodPost, apiPrefix+"/auth/totp/enroll", nil), http.StatusForbidden, "reauthentication_required")
}

func TestPasswordChange(t *testing.T) {
	e := newEnv(t)
	id := e.createUser("bob", userOpts{})
	c, other := e.client(), e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	require.Equal(t, http.StatusOK, other.login("bob", goodPassword).Code)
	path := apiPrefix + "/auth/password"

	requireError(t, c.do(http.MethodPost, path, map[string]string{"current_password": "nope nope nope", "new_password": "a different long passphrase"}),
		http.StatusForbidden, "forbidden")
	requireError(t, c.do(http.MethodPost, path, map[string]string{"current_password": goodPassword, "new_password": "password1234"}),
		http.StatusBadRequest, "weak_password")

	oldCookie := c.cookie
	rec := c.do(http.MethodPost, path, map[string]string{"current_password": goodPassword, "new_password": "a different long passphrase"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	newCSRF := decodeBody(t, rec)["csrf_token"].(string)
	require.NotEqual(t, c.csrf, newCSRF)
	require.NotEqual(t, oldCookie.Value, c.cookie.Value)
	c.csrf = newCSRF
	require.Equal(t, http.StatusOK, c.do(http.MethodGet, apiPrefix+"/auth/me", nil).Code)
	requireError(t, other.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")

	entries := e.auditEntries("auth.password_changed")
	require.Len(t, entries, 1)
	require.Equal(t, id, *entries[0].ActorUserID)
	requireError(t, e.client().login("bob", goodPassword), http.StatusUnauthorized, "unauthenticated")
	require.Equal(t, http.StatusOK, e.client().login("bob", "a different long passphrase").Code)
}

func TestDisabledUserSessionRejected(t *testing.T) {
	e := newEnv(t)
	id := e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET status = 'disabled' WHERE id = $1`, id)
	require.NoError(t, err)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	var n int
	require.NoError(t, e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id = $1`, id).Scan(&n))
	require.Zero(t, n, "the session is deleted")
	requireError(t, e.client().login("bob", goodPassword), http.StatusUnauthorized, "unauthenticated")
}

func TestLoadSessionUsesJoinedUser(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob", userOpts{})
	c := e.client()
	require.Equal(t, http.StatusOK, c.login("bob", goodPassword).Code)
	before := e.d.Pool.Stat().AcquireCount()
	require.Equal(t, http.StatusOK, c.do(http.MethodGet, apiPrefix+"/auth/me", nil).Code)
	require.EqualValues(t, 2, e.d.Pool.Stat().AcquireCount()-before, "session lookup and touch only")
}

func TestSessionUserDeletionAndRoleChangeAreImmediate(t *testing.T) {
	e := newEnv(t)
	id := e.createUser("bob", userOpts{role: "owner"})
	c := e.client()
	var token string
	var sess auth.Session
	require.NoError(t, store.Tx(context.Background(), e.d.Pool, func(q *db.Queries) error {
		var err error
		token, sess, err = e.d.Sessions.Create(context.Background(), q, id, netip.MustParseAddr("192.0.2.1"), "test")
		return err
	}))
	c.cookie = &http.Cookie{Name: sessionCookieName(e.d.Cfg), Value: token}
	c.csrf = sess.CSRFToken
	_, err := e.d.Pool.Exec(context.Background(), `UPDATE users SET role = 'user' WHERE id = $1`, id)
	require.NoError(t, err)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/users", nil), http.StatusForbidden, "forbidden")
	_, err = e.d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	require.NoError(t, err)
	requireError(t, c.do(http.MethodGet, apiPrefix+"/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestUseTOTPStepRejectsReuse(t *testing.T) {
	// The database guard behind concurrent submissions of one code: the
	// second write of a step (or an older one) is refused.
	e := newEnv(t)
	id := e.createUser("bob", userOpts{})
	q := db.New(e.d.Pool)
	ctx := context.Background()
	require.NoError(t, useTOTPStep(ctx, q, id, 100))
	require.ErrorIs(t, useTOTPStep(ctx, q, id, 100), errCodeRejected)
	require.ErrorIs(t, useTOTPStep(ctx, q, id, 99), errCodeRejected)
	require.NoError(t, useTOTPStep(ctx, q, id, 101))
}
