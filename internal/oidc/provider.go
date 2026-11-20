package oidc

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	coreoidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type Provider struct {
	oidc   *coreoidc.Provider
	config oauth2.Config
	client *http.Client
	now    func() time.Time
}

func BuildProvider(ctx context.Context, s Settings, publicURL string, client *http.Client, now func() time.Time) (*Provider, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if now == nil {
		now = time.Now
	}
	ctx = coreoidc.ClientContext(ctx, client)
	provider, err := coreoidc.NewProvider(ctx, s.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discover provider: %w", err)
	}
	var discovery struct {
		Scopes []string `json:"scopes_supported"`
	}
	if err := provider.Claims(&discovery); err != nil {
		return nil, fmt.Errorf("decode provider scopes: %w", err)
	}
	scopes := requestedScopes(s.Issuer, discovery.Scopes)
	return &Provider{oidc: provider, client: client, now: now,
		config: oauth2.Config{ClientID: s.ClientID, ClientSecret: s.ClientSecret,
			RedirectURL: strings.TrimSuffix(publicURL, "/") + "/admin/api/v1/auth/oidc/callback",
			Endpoint:    provider.Endpoint(), Scopes: scopes}}, nil
}

func requestedScopes(issuer string, supported []string) []string {
	scopes := []string{coreoidc.ScopeOpenID, "email", "profile"}
	if issuerURL, err := url.Parse(issuer); err == nil && issuerURL.Host == "login.microsoftonline.com" {
		scopes = append(scopes, "User.Read")
	}
	for _, scope := range supported {
		if scope == "groups" {
			scopes = append(scopes, "groups")
			break
		}
	}
	return scopes
}

func (p *Provider) AuthCodeURL(state, nonce, verifier string) string {
	return p.config.AuthCodeURL(state, coreoidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier))
}

func (p *Provider) ExchangeClaims(ctx context.Context, code, verifier, nonce, groupsClaim string) (Claims, error) {
	ctx = coreoidc.ClientContext(ctx, p.client)
	token, err := p.config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Claims{}, fmt.Errorf("exchange oidc code: %w", err)
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok || rawID == "" {
		return Claims{}, fmt.Errorf("oidc id token missing")
	}
	// The verifier handles the signature, issuer, audience and expiry. Its clock
	// is shifted back for the allowed 60-second expiry leeway; issued-at and
	// not-before are checked below against the forward leeway.
	verifierID := p.oidc.Verifier(&coreoidc.Config{ClientID: p.config.ClientID,
		Now: func() time.Time { return p.now().Add(-60 * time.Second) }})
	idToken, err := verifierID.Verify(ctx, rawID)
	if err != nil {
		return Claims{}, fmt.Errorf("verify oidc token: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := idToken.Claims(&fields); err != nil {
		return Claims{}, fmt.Errorf("decode oidc claims: %w", err)
	}
	var tokenNonce string
	if err := json.Unmarshal(fields["nonce"], &tokenNonce); err != nil || subtle.ConstantTimeCompare([]byte(tokenNonce), []byte(nonce)) != 1 {
		return Claims{}, fmt.Errorf("oidc nonce mismatch")
	}
	for _, key := range []string{"iat", "nbf"} {
		if raw, ok := fields[key]; ok {
			var unix int64
			if err := json.Unmarshal(raw, &unix); err != nil || time.Unix(unix, 0).After(p.now().Add(60*time.Second)) {
				return Claims{}, fmt.Errorf("oidc %s outside clock leeway", key)
			}
		}
	}
	if groupsClaim == "" {
		groupsClaim = "groups"
	}
	_, tokenHasEmail := fields["email"]
	tokenVerified, tokenHasVerified := fields["email_verified"]
	needInfo := false
	for _, key := range []string{"email", "email_verified", "name", "preferred_username", "picture", groupsClaim} {
		if _, ok := fields[key]; !ok {
			needInfo = true
			break
		}
	}
	if needInfo {
		info, err := p.oidc.UserInfo(ctx, oauth2.StaticTokenSource(token))
		if err != nil {
			return Claims{}, fmt.Errorf("fetch oidc userinfo: %w", err)
		}
		var extra map[string]json.RawMessage
		if err := info.Claims(&extra); err != nil {
			return Claims{}, fmt.Errorf("decode oidc userinfo: %w", err)
		}
		if info.Subject != idToken.Subject {
			return Claims{}, fmt.Errorf("oidc userinfo subject mismatch")
		}
		for key, value := range extra {
			if _, ok := fields[key]; !ok {
				fields[key] = value
			}
		}
		if tokenHasEmail {
			if tokenHasVerified {
				fields["email_verified"] = tokenVerified
			} else {
				delete(fields, "email_verified")
			}
		} else {
			if verified, ok := extra["email_verified"]; ok {
				fields["email_verified"] = verified
			} else {
				delete(fields, "email_verified")
			}
		}
	}
	c := Claims{Subject: idToken.Subject}
	c.AccessToken = token.AccessToken
	for _, f := range []struct {
		key string
		dst *string
	}{{"email", &c.Email}, {"name", &c.Name}, {"preferred_username", &c.PreferredUsername}, {"picture", &c.Picture}} {
		if raw, ok := fields[f.key]; ok && string(raw) != "null" {
			if err := json.Unmarshal(raw, f.dst); err != nil {
				return Claims{}, fmt.Errorf("invalid oidc %s", f.key)
			}
		}
	}
	if raw, ok := fields["email_verified"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &c.EmailVerified); err != nil {
			return Claims{}, fmt.Errorf("invalid oidc email_verified")
		}
	}
	if raw, ok := fields[groupsClaim]; ok && string(raw) != "null" {
		c.GroupsClaimPresent = true
		if err := json.Unmarshal(raw, &c.Groups); err != nil {
			var single string
			if err := json.Unmarshal(raw, &single); err != nil {
				return Claims{}, fmt.Errorf("invalid oidc groups")
			}
			c.Groups = []string{single}
		}
	}
	return c, nil
}

type ProviderCache struct {
	mu         sync.Mutex
	key        string
	p          *Provider
	err        error
	retryAfter time.Time
	inflight   map[string]*providerCall
}

type providerCall struct {
	done chan struct{}
	p    *Provider
	err  error
}

func (c *ProviderCache) Get(ctx context.Context, s Settings, publicURL string, client *http.Client, now func() time.Time) (*Provider, error) {
	if now == nil {
		now = time.Now
	}
	key := s.Issuer + "\x00" + s.ClientID + "\x00" + publicURL
	if s.UpdatedAt != nil {
		key += "\x00" + s.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	c.mu.Lock()
	if key == c.key && (c.p != nil || c.err != nil && now().Before(c.retryAfter)) {
		p, err := c.p, c.err
		c.mu.Unlock()
		return p, err
	}
	if call := c.inflight[key]; call != nil {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.p, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if c.inflight == nil {
		c.inflight = make(map[string]*providerCall)
	}
	call := &providerCall{done: make(chan struct{})}
	c.inflight[key] = call
	c.key, c.p, c.err = key, nil, nil
	c.mu.Unlock()
	p, err := BuildProvider(ctx, s, publicURL, client, now)
	c.mu.Lock()
	call.p, call.err = p, err
	if c.key == key {
		c.p, c.err = p, err
		if err != nil {
			c.retryAfter = now().Add(30 * time.Second)
		}
	}
	delete(c.inflight, key)
	close(call.done)
	c.mu.Unlock()
	return p, err
}
