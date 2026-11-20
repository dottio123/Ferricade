package setup_test

import (
	"context"
	"encoding/json"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	goodPassword = "correct horse battery staple"
	validKey     = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
)

var testIP = netip.MustParseAddr("192.0.2.10")

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.t = c.t.Add(d) }

func newClock() *clock { return &clock{t: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)} }

func TestGuard(t *testing.T) {
	c := newClock()
	token, g := setup.NewGuard(c.Now)
	require.Len(t, token, 43, "32 random bytes, unpadded base64url")
	require.True(t, g.Valid(token))
	require.False(t, g.Valid(""))
	require.False(t, g.Valid(token+"x"))
	require.False(t, g.Valid(strings.ToUpper(token)))

	other, _ := setup.NewGuard(c.Now)
	require.NotEqual(t, token, other)
	require.False(t, g.Valid(other))

	c.Add(24*time.Hour - time.Nanosecond)
	require.True(t, g.Valid(token))
	c.Add(time.Nanosecond)
	require.False(t, g.Valid(token), "a token at exactly 24 h is rejected")

	var nilGuard *setup.Guard
	require.False(t, nilGuard.Valid(token))
}

func newService(t *testing.T) (*setup.Service, *clock) {
	t.Helper()
	sealer, err := auth.NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	c := newClock()
	return &setup.Service{Pool: store.NewTestDB(t), Sealer: sealer, Params: auth.TestParams, Now: c.Now}, c
}

func code(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	c, err := auth.TOTPCode(secret, at)
	require.NoError(t, err)
	return c
}

func actions(t *testing.T, s *setup.Service) []string {
	t.Helper()
	entries, _, err := audit.List(context.Background(), db.New(s.Pool), audit.Filter{Limit: 200})
	require.NoError(t, err)
	var out []string
	for i := len(entries) - 1; i >= 0; i-- {
		out = append(out, entries[i].Action)
	}
	return out
}

func TestServiceFlow(t *testing.T) {
	s, c := newService(t)
	ctx := context.Background()

	done, err := s.Complete(ctx)
	require.NoError(t, err)
	require.False(t, done)
	_, ok, err := s.ServerID(ctx)
	require.NoError(t, err)
	require.False(t, ok)

	ownerID, err := s.CreateOwner(ctx, "alice", goodPassword, "Alice", "alice@example.com", testIP)
	require.NoError(t, err)
	row, err := db.New(s.Pool).GetUserByID(ctx, ownerID)
	require.NoError(t, err)
	require.Equal(t, "owner", row.Role)
	require.True(t, row.TOTPRequired, "TOTP is mandatory for the owner")
	require.NotNil(t, row.PasswordHash)
	ok, err = auth.VerifyPassword(context.Background(), *row.PasswordHash, goodPassword)
	require.NoError(t, err)
	require.True(t, ok)

	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrIncomplete, "no TOTP, no server")

	secret, url, err := s.BeginOwnerTOTP(ctx)
	require.NoError(t, err)
	require.Contains(t, url, "otpauth://totp/ferricade:alice?secret="+secret)
	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrIncomplete, "TOTP not verified")

	require.ErrorIs(t, s.VerifyOwnerTOTP(ctx, "000000", testIP), setup.ErrInvalidCode)
	good := code(t, secret, c.Now())
	require.NoError(t, s.VerifyOwnerTOTP(ctx, good, testIP))
	require.ErrorIs(t, s.VerifyOwnerTOTP(ctx, good, testIP), setup.ErrCodeUsed, "a code is not accepted twice")
	row, err = db.New(s.Pool).GetUserByID(ctx, ownerID)
	require.NoError(t, err)
	require.Equal(t, c.Now().Unix()/30, row.TOTPLastStep, "totp_last_step stored")

	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrIncomplete, "no server")

	serverID, err := s.SaveServer(ctx, "lab", "rd.example.com", "relay.example.com", validKey, testIP)
	require.NoError(t, err)
	profile, err := db.New(s.Pool).GetServer(ctx)
	require.NoError(t, err)
	_, err = db.New(s.Pool).UpdateServer(ctx, db.UpdateServerParams{
		ID: profile.ID, Name: profile.Name, IDHost: profile.IDHost, RelayHost: profile.RelayHost,
		PublicKey: profile.PublicKey, ApiUrl: "https://api.example.com", LinksIncludeServer: false,
	})
	require.NoError(t, err)
	again, err := s.SaveServer(ctx, "lab2", "rd2.example.com", "relay2.example.com:21117", validKey, testIP)
	require.NoError(t, err)
	require.Equal(t, serverID, again, "a second save updates the one server profile")
	srv, err := db.New(s.Pool).GetServer(ctx)
	require.NoError(t, err)
	require.Equal(t, "rd2.example.com", srv.IDHost)
	require.Equal(t, "relay2.example.com:21117", srv.RelayHost)
	require.Equal(t, "https://api.example.com", srv.ApiUrl, "setup re-save keeps the configured client API address")
	require.False(t, srv.LinksIncludeServer, "setup re-save keeps the connect link setting")

	require.NoError(t, s.Finish(ctx, testIP))
	done, err = s.Complete(ctx)
	require.NoError(t, err)
	require.True(t, done)
	id, ok, err := s.ServerID(ctx)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, serverID, id)

	policy, err := db.New(s.Pool).GetSetting(ctx, "enrollment_policy")
	require.NoError(t, err)
	require.JSONEq(t, `"approval"`, string(policy))

	// Every step is refused once setup is complete.
	_, err = s.CreateOwner(ctx, "mallory", goodPassword, "", "", testIP)
	require.ErrorIs(t, err, setup.ErrComplete)
	_, _, err = s.BeginOwnerTOTP(ctx)
	require.ErrorIs(t, err, setup.ErrComplete)
	_, err = s.SaveServer(ctx, "x", "evil.example.com", "evil.example.com", validKey, testIP)
	require.ErrorIs(t, err, setup.ErrComplete)
	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrComplete)

	require.Equal(t, []string{
		"setup.owner_created", "auth.totp_enrolled", "setup.server_saved", "setup.server_saved", "setup.completed",
	}, actions(t, s))
}

func TestCreateOwnerValidates(t *testing.T) {
	s, _ := newService(t)
	ctx := context.Background()
	for _, pw := range []string{"short", "password1234", "alice-is-the-owner"} {
		_, err := s.CreateOwner(ctx, "alice-is-the-owner", pw, "", "", testIP)
		require.Error(t, err, pw)
		require.True(t, auth.IsWeakPassword(err), "%q: %v", pw, err)
	}
	for _, tc := range []struct{ username, display, email string }{
		{"", "", ""},
		{"has space", "", ""},
		{strings.Repeat("a", 65), "", ""},
		{"bob", "bad\x00name", ""},
		{"bob", "", "not-an-email"},
	} {
		_, err := s.CreateOwner(ctx, tc.username, goodPassword, tc.display, tc.email, testIP)
		var in setup.InputError
		require.ErrorAs(t, err, &in, "%+v", tc)
	}
	_, err := s.CreateOwner(ctx, "bob", strings.Repeat("x", 1025), "", "", testIP)
	var in setup.InputError
	require.ErrorAs(t, err, &in, "over-long password")
	require.Empty(t, actions(t, s), "nothing written")
}

func TestCreateOwnerAgainReplacesOwner(t *testing.T) {
	s, c := newService(t)
	ctx := context.Background()
	first, err := s.CreateOwner(ctx, "alice", goodPassword, "", "", testIP)
	require.NoError(t, err)
	secret, _, err := s.BeginOwnerTOTP(ctx)
	require.NoError(t, err)
	require.NoError(t, s.VerifyOwnerTOTP(ctx, code(t, secret, c.Now()), testIP))

	second, err := s.CreateOwner(ctx, "carol", "another long passphrase", "Carol", "", testIP)
	require.NoError(t, err)
	require.Equal(t, first, second, "the wizard's owner is overwritten, not duplicated")
	row, err := db.New(s.Pool).GetUserByID(ctx, second)
	require.NoError(t, err)
	require.Equal(t, "carol", row.Username)
	require.Nil(t, row.TOTPSecretEnc, "TOTP enrollment starts over")

	_, err = s.SaveServer(ctx, "lab", "rd.example.com", "rd.example.com", validKey, testIP)
	require.NoError(t, err)
	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrIncomplete, "the new owner has no verified TOTP")
}

func TestBeginOwnerTOTPAgainNeedsNewVerification(t *testing.T) {
	s, c := newService(t)
	ctx := context.Background()
	_, _, err := s.BeginOwnerTOTP(ctx)
	require.ErrorIs(t, err, setup.ErrIncomplete, "no owner yet")
	require.ErrorIs(t, s.VerifyOwnerTOTP(ctx, "123456", testIP), setup.ErrIncomplete)

	_, err = s.CreateOwner(ctx, "alice", goodPassword, "", "", testIP)
	require.NoError(t, err)
	secret, _, err := s.BeginOwnerTOTP(ctx)
	require.NoError(t, err)
	require.NoError(t, s.VerifyOwnerTOTP(ctx, code(t, secret, c.Now()), testIP))
	_, err = s.SaveServer(ctx, "lab", "rd.example.com", "rd.example.com", validKey, testIP)
	require.NoError(t, err)

	newSecret, _, err := s.BeginOwnerTOTP(ctx)
	require.NoError(t, err)
	require.NotEqual(t, secret, newSecret)
	require.ErrorIs(t, s.Finish(ctx, testIP), setup.ErrIncomplete, "the replaced secret is unverified")
	c.Add(30 * time.Second)
	require.NoError(t, s.VerifyOwnerTOTP(ctx, code(t, newSecret, c.Now()), testIP))
	require.NoError(t, s.Finish(ctx, testIP))
}

func TestSaveServerValidates(t *testing.T) {
	s, _ := newService(t)
	ctx := context.Background()
	for _, key := range []string{"", "abc", "AAAA", validKey[:40], "!!!!" + validKey[4:]} {
		_, err := s.SaveServer(ctx, "lab", "rd.example.com", "rd.example.com", key, testIP)
		require.ErrorIs(t, err, setup.ErrInvalidKey, "%q", key)
	}
	for _, hosts := range [][2]string{
		{"", "rd.example.com"}, {"rd.example.com", ""}, {"  ", "rd.example.com"},
		{"http://rd.example.com", "rd.example.com"}, {"rd.example.com/x", "rd.example.com"},
		{"rd example.com", "rd.example.com"},
	} {
		_, err := s.SaveServer(ctx, "lab", hosts[0], hosts[1], validKey, testIP)
		var in setup.InputError
		require.ErrorAs(t, err, &in, "%q", hosts)
	}
	// An unpadded key is accepted and stored in its canonical padded form.
	_, err := s.SaveServer(ctx, "", " rd.example.com ", "[2001:db8::1]:21117", strings.TrimRight(validKey, "="), testIP)
	require.NoError(t, err)
	srv, err := db.New(s.Pool).GetServer(ctx)
	require.NoError(t, err)
	require.Equal(t, validKey, srv.PublicKey)
	require.Equal(t, "rd.example.com", srv.IDHost)
	require.Equal(t, "default", srv.Name)

	entries, _, err := audit.List(ctx, db.New(s.Pool), audit.Filter{Action: "setup.server_saved"})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "server", entries[0].TargetType)
	require.Equal(t, srv.ID.String(), entries[0].TargetID)
	raw, _ := json.Marshal(entries[0].Details)
	require.JSONEq(t, `{"name":"default","id_host":"rd.example.com","relay_host":"[2001:db8::1]:21117","public_key":"`+validKey+`"}`, string(raw))
}

func TestSaveServerHostValidation(t *testing.T) {
	s, _ := newService(t)
	ctx := context.Background()
	long := strings.Repeat("a", 63)
	for _, tc := range []struct {
		host string
		ok   bool
	}{
		{"rd.example.com", true},
		{"rd.example.com:21116", true},
		{"rd", true},
		{"my-host.example", true},
		{"192.0.2.1", true},
		{"192.0.2.1:21117", true},
		{"2001:db8::1", true},
		{"[2001:db8::1]", true},
		{"[2001:db8::1]:21116", true},
		{long + "." + long + "." + long + "." + strings.Repeat("a", 61), true},  // 253
		{long + "." + long + "." + long + "." + strings.Repeat("a", 62), false}, // 254
		{strings.Repeat("a", 64) + ".example.com", false},                       // label > 63
		{":", false},
		{":21116", false},
		{"[", false},
		{"[]", false},
		{"[]:21116", false},
		{"-", false},
		{"-rd.example.com", false},
		{"rd-.example.com", false},
		{"rd..example.com", false},
		{".rd.example.com", false},
		{"rd.example.com.", false},
		{"rd_x.example.com", false},
		{"rd.example.com:", false},
		{"rd.example.com:0", false},
		{"rd.example.com:65536", false},
		{"rd.example.com:+1", false},
		{"rd.example.com:abc", false},
		{"a:b:c", false},
		{"[192.0.2.1]:21116", false},
		{"[fe80::1%eth0]:21116", false},
		{"http://rd.example.com", false},
		{"rd.example.com/x", false},
		{"rd example.com", false},
	} {
		_, err := s.SaveServer(ctx, "lab", tc.host, "relay.example.com", validKey, testIP)
		if tc.ok {
			require.NoError(t, err, "%q", tc.host)
			continue
		}
		var in setup.InputError
		require.ErrorAs(t, err, &in, "%q", tc.host)
		_, err = s.SaveServer(ctx, "lab", "rd.example.com", tc.host, validKey, testIP)
		require.ErrorAs(t, err, &in, "relay %q", tc.host)
	}
}
