package adminapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
)

// holdArgon takes the only Argon2id slot for the rest of the test, with
// waits cut to 10 ms.
func holdArgon(t *testing.T) (release func()) {
	t.Helper()
	t.Cleanup(auth.SetArgonLimit(1, 10*time.Millisecond))
	release, err := auth.AcquireArgonSlot(context.Background())
	require.NoError(t, err)
	t.Cleanup(release)
	return release
}

func requireBusy(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	requireError(t, rec, http.StatusServiceUnavailable, "busy")
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
	require.Equal(t, "server busy, retry", decodeBody(t, rec)["error"].(map[string]any)["message"])
}

// While every Argon2id slot is taken, logins answer 503 busy and count as
// no failure: neither against the address, the account nor the unknown
// username.
func TestLoginBusy(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	e.createUser("alice", userOpts{})
	release := holdArgon(t)

	c := e.client()
	for i := 0; i < 25; i++ { // beyond the 20 failures that give 429
		requireBusy(t, c.login("alice", "wrong password!"))
		requireBusy(t, c.login("nobody", "wrong password!"))
	}
	require.Empty(t, e.auditEntries("auth.login_failed"))
	release()
	require.Equal(t, http.StatusOK, c.login("alice", goodPassword).Code, "nothing was counted")
}

func TestPasswordHandlersBusy(t *testing.T) {
	e := newEnv(t)
	e.markSetupComplete()
	c, _ := e.signedIn("alice", "owner")
	holdArgon(t)

	requireBusy(t, c.do(http.MethodPost, apiPrefix+"/auth/password",
		map[string]string{"current_password": goodPassword, "new_password": "a different long passphrase"}))
	requireBusy(t, c.do(http.MethodPost, apiPrefix+"/users",
		map[string]any{"username": "bob", "password": goodPassword, "role": "admin"}))
	require.Empty(t, e.auditEntries("user.created"))
}

func TestSetupOwnerBusy(t *testing.T) {
	e := newEnv(t)
	holdArgon(t)
	requireBusy(t, e.client().setup("/owner", map[string]string{
		"username": "owner", "password": goodPassword, "display_name": "Owner", "email": "",
	}))
}
