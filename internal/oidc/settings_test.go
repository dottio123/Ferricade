package oidc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestSavePatchSecretAndValidation(t *testing.T) {
	ctx := context.Background()
	pool := store.NewTestDB(t)
	q := db.New(pool)
	sealer, err := auth.NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	hash := "hash"
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", Role: "owner", PasswordHash: &hash})
	require.NoError(t, err)
	actor := devices.Actor{UserID: user.ID, IP: netip.MustParseAddr("127.0.0.1")}
	secret := "first-secret"
	issuer := "https://idp.example.com/"
	clientID := "client"
	groups := []string{"owners"}
	enabled := true
	var saved Settings
	var changed []string
	err = store.Tx(ctx, pool, func(q *db.Queries) error {
		var e error
		saved, changed, e = Save(ctx, q, sealer, Patch{Enabled: &enabled, Issuer: &issuer, ClientID: &clientID, ClientSecret: &secret, OwnerGroups: &groups}, actor)
		return e
	})
	require.NoError(t, err)
	require.Equal(t, []string{"enabled", "issuer", "client_id", "client_secret", "owner_groups"}, changed)
	require.Equal(t, secret, saved.ClientSecret)
	raw, err := json.Marshal(saved)
	require.NoError(t, err)
	require.NotContains(t, string(raw), secret)
	var sealed []byte
	require.NoError(t, pool.QueryRow(ctx, "SELECT client_secret_enc FROM oidc_settings").Scan(&sealed))
	require.NotContains(t, string(sealed), secret)
	name := "My provider"
	err = store.Tx(ctx, pool, func(q *db.Queries) error {
		var e error
		saved, changed, e = Save(ctx, q, sealer, Patch{DisplayName: &name}, actor)
		return e
	})
	require.NoError(t, err)
	require.Equal(t, []string{"display_name"}, changed)
	require.Equal(t, secret, saved.ClientSecret)
	second := "second-secret"
	err = store.Tx(ctx, pool, func(q *db.Queries) error {
		var e error
		saved, changed, e = Save(ctx, q, sealer, Patch{ClientSecret: &second}, actor)
		return e
	})
	require.NoError(t, err)
	require.Equal(t, []string{"client_secret"}, changed)
	require.Equal(t, second, saved.ClientSecret)
	for _, test := range []struct {
		issuer string
		valid  bool
	}{{"https://example.com", true}, {"http://localhost:5556", true}, {"http://127.0.0.1:5556", true}, {"http://idp.lan", false}, {"garbage", false}} {
		t.Run(test.issuer, func(t *testing.T) {
			s := Settings{Issuer: test.issuer, GroupsClaim: "groups"}
			require.Equal(t, test.valid, validate(s) == nil)
		})
	}
	require.NoError(t, validateMode(Settings{Issuer: "http://dex:5556/dex", GroupsClaim: "groups"}, true))
	require.Error(t, validateMode(Settings{Issuer: "http://dex:5556/dex", GroupsClaim: "groups"}, false))
	for _, s := range []Settings{{Enabled: true, GroupsClaim: "groups"}, {Enabled: true, Issuer: issuer, GroupsClaim: "groups"}, {Enabled: true, Issuer: issuer, ClientID: clientID, GroupsClaim: "groups"}, {Enabled: true, Issuer: issuer, ClientID: clientID, ClientSecret: secret, GroupsClaim: "groups"}} {
		require.Error(t, validate(s))
	}
}

func TestUserGroupsValidation(t *testing.T) {
	s := Settings{Enabled: true, Issuer: "https://idp.example", ClientID: "client", ClientSecret: "secret", GroupsClaim: "groups", UserGroups: []string{"viewers"}}
	require.NoError(t, validate(s))
	for _, groups := range [][]string{{""}, {strings.Repeat("x", 257)}, make([]string, 33)} {
		s.UserGroups = groups
		err := validate(s)
		var validation *ValidationError
		require.ErrorAs(t, err, &validation)
		require.Equal(t, "user_groups", validation.Field)
	}
	s.UserGroups = nil
	require.EqualError(t, validate(s), "owner_groups: owner_groups, admin_groups or user_groups required when enabled")
	var patch Patch
	require.NoError(t, json.Unmarshal([]byte(`{"user_groups":["viewers"]}`), &patch))
	require.Equal(t, []string{"viewers"}, *patch.UserGroups)
}

func TestDiscover(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   string
		groups bool
	}{
		{"ok", 200, `{"issuer":"ISSUER","authorization_endpoint":"https://idp/auth","token_endpoint":"https://idp/token","scopes_supported":["openid","groups"]}`, "", true},
		{"status", 503, "", "bad_status", false},
		{"not_json", 200, "oops", "not_json", false},
		{"mismatch", 200, `{"issuer":"wrong"}`, "issuer_mismatch", false},
		{"endpoints", 200, `{"issuer":"ISSUER"}`, "missing_endpoints", false},
		{"too_large", 200, strings.Repeat("x", 1<<20+1), "not_json", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/.well-known/openid-configuration", r.URL.Path)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(strings.ReplaceAll(tc.body, "ISSUER", "http://"+r.Host+"/")))
			}))
			defer server.Close()
			got := Discover(context.Background(), server.Client(), server.URL+"/", now)
			require.Equal(t, now, got.TestedAt)
			require.Equal(t, tc.code == "", got.OK)
			require.Equal(t, tc.groups, got.GroupsScopeSupported)
			if tc.code == "" {
				require.Nil(t, got.Error)
			} else {
				require.Equal(t, tc.code, *got.Error)
			}
		})
	}
	got := Discover(context.Background(), &http.Client{Timeout: time.Second}, "http://127.0.0.1:1", now)
	require.Equal(t, "unreachable", *got.Error)
}
