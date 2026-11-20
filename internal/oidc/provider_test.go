package oidc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/oidc/oidctest"
)

func TestProviderTokenAndClaims(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	now := time.Now().UTC()
	fake.Now = func() time.Time { return now }
	fake.Claims["email"] = "kilgore@example.com"
	fake.Claims["email_verified"] = true
	fake.Claims["groups"] = "/team/owners"
	fake.Info["name"] = "Kilgore Trout"
	s := Settings{Issuer: fake.URL(), ClientID: "test-client", ClientSecret: "test-secret", GroupsClaim: "groups"}
	p, err := BuildProvider(context.Background(), s, "https://admin.example.com", fake.Server.Client(), func() time.Time { return now })
	require.NoError(t, err)
	authURL := p.AuthCodeURL("state", "nonce", "verifier")
	response, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(authURL)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, "openid email profile groups", fake.Auth.Get("scope"))
	location, err := url.Parse(response.Header.Get("Location"))
	require.NoError(t, err)
	c, err := p.ExchangeClaims(context.Background(), location.Query().Get("code"), "verifier", "nonce", s.GroupsClaim)
	require.NoError(t, err)
	require.Equal(t, "Kilgore Trout", c.Name)
	require.Equal(t, "test-access", c.AccessToken)
	encoded, err := json.Marshal(c)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "test-access")
	require.Equal(t, []string{"/team/owners"}, c.Groups)
	fake.Claims["iat"] = now.Add(5 * time.Minute).Unix()
	_, err = p.ExchangeClaims(context.Background(), "test-code", "verifier", "nonce", s.GroupsClaim)
	require.Error(t, err)
}

func TestMicrosoftScopes(t *testing.T) {
	for _, tc := range []struct {
		issuer string
		want   bool
	}{
		{"https://login.microsoftonline.com/tenant/v2.0", true},
		{"https://login.microsoftonline.com.evil.example/tenant", false},
		{"https://login.microsoftonline.com:8443/tenant", false},
		{"https://accounts.example.com", false},
	} {
		scopes := requestedScopes(tc.issuer, nil)
		require.Equal(t, tc.want, slices.Contains(scopes, "User.Read"), tc.issuer)
	}
}

func TestProviderRejectsInvalidTokensAndClockSkew(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*oidctest.Provider, time.Time)
		valid  bool
	}{
		{"nonce", func(p *oidctest.Provider, _ time.Time) { p.Claims["nonce"] = "wrong" }, false},
		{"audience", func(p *oidctest.Provider, _ time.Time) { p.Claims["aud"] = "wrong" }, false},
		{"issuer", func(p *oidctest.Provider, _ time.Time) { p.Claims["iss"] = "https://wrong.example" }, false},
		{"signature", func(p *oidctest.Provider, _ time.Time) { p.BadSignature = true }, false},
		{"iat 30 seconds", func(p *oidctest.Provider, now time.Time) { p.Claims["iat"] = now.Add(30 * time.Second).Unix() }, true},
		{"iat 5 minutes", func(p *oidctest.Provider, now time.Time) { p.Claims["iat"] = now.Add(5 * time.Minute).Unix() }, false},
		{"nbf 5 minutes", func(p *oidctest.Provider, now time.Time) { p.Claims["nbf"] = now.Add(5 * time.Minute).Unix() }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := oidctest.New()
			defer fake.Close()
			now := time.Now().UTC()
			fake.Now = func() time.Time { return now }
			fake.Info["groups"] = []string{"authors"}
			s := Settings{Issuer: fake.URL(), ClientID: "test-client", ClientSecret: "test-secret", GroupsClaim: "groups"}
			p, err := BuildProvider(context.Background(), s, "https://admin.example.com", fake.Server.Client(), func() time.Time { return now })
			require.NoError(t, err)
			response, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(p.AuthCodeURL("state", "nonce", "verifier"))
			require.NoError(t, err)
			response.Body.Close()
			tc.change(fake, now)
			_, err = p.ExchangeClaims(context.Background(), "test-code", "verifier", "nonce", "groups")
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestProviderGroupsScopeConditional(t *testing.T) {
	fake := oidctest.New()
	defer fake.Close()
	fake.Scopes = []string{"openid", "email", "profile"}
	p, err := BuildProvider(context.Background(), Settings{Issuer: fake.URL(), ClientID: "test-client"},
		"https://admin.example.com", fake.Server.Client(), time.Now)
	require.NoError(t, err)
	response, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(p.AuthCodeURL("s", "n", "verifier"))
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, "openid email profile", fake.Auth.Get("scope"))
}

func TestProviderEmailVerificationStaysWithEmailSource(t *testing.T) {
	for _, tc := range []struct {
		name         string
		token, info  map[string]any
		wantEmail    string
		wantVerified bool
	}{
		{"token email without verification", map[string]any{"email": "token@example.com"}, map[string]any{"email": "info@example.com", "email_verified": true}, "token@example.com", false},
		{"userinfo email ignores token verification", map[string]any{"email_verified": true}, map[string]any{"email": "info@example.com", "email_verified": false}, "info@example.com", false},
		{"userinfo pair", map[string]any{}, map[string]any{"email": "info@example.com", "email_verified": true}, "info@example.com", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := oidctest.New()
			defer fake.Close()
			fake.Claims, fake.Info = tc.token, tc.info
			p, err := BuildProvider(context.Background(), Settings{Issuer: fake.URL(), ClientID: "test-client", ClientSecret: "test-secret"}, "https://admin.example", fake.Server.Client(), time.Now)
			require.NoError(t, err)
			resp, err := (&http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Get(p.AuthCodeURL("state", "nonce", "verifier"))
			require.NoError(t, err)
			resp.Body.Close()
			claims, err := p.ExchangeClaims(context.Background(), "test-code", "verifier", "nonce", "groups")
			require.NoError(t, err)
			require.Equal(t, tc.wantEmail, claims.Email)
			require.Equal(t, tc.wantVerified, claims.EmailVerified)
		})
	}
}

func TestProviderCacheSingleFlightAndNegativeTTL(t *testing.T) {
	var gets atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets.Add(1)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer s.Close()
	settings := Settings{Issuer: s.URL, ClientID: "client"}
	now := time.Now()
	clock := func() time.Time { return now }
	var cache ProviderCache
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = cache.Get(context.Background(), settings, "https://admin.example", s.Client(), clock)
		}()
	}
	wg.Wait()
	require.EqualValues(t, 1, gets.Load())
	_, err := cache.Get(context.Background(), settings, "https://admin.example", s.Client(), clock)
	require.Error(t, err)
	require.EqualValues(t, 1, gets.Load())
	now = now.Add(31 * time.Second)
	_, err = cache.Get(context.Background(), settings, "https://admin.example", s.Client(), clock)
	require.Error(t, err)
	require.EqualValues(t, 2, gets.Load())
}
