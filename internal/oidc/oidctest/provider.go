// Package oidctest provides a small signing OIDC server for flow tests.
package oidctest

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"time"
)

type Provider struct {
	Server       *httptest.Server
	Key          *rsa.PrivateKey
	mu           sync.Mutex
	Nonce        string
	Auth         url.Values
	Claims       map[string]any
	Info         map[string]any
	Now          func() time.Time
	Scopes       []string
	BadSignature bool
	Photo        []byte
}

func New() *Provider {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	p := &Provider{Key: key, Claims: map[string]any{}, Info: map[string]any{}, Now: time.Now,
		Scopes: []string{"openid", "email", "profile", "groups"}}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	return p
}

func (p *Provider) Close()      { p.Server.Close() }
func (p *Provider) URL() string { return p.Server.URL }

func (p *Provider) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": p.URL(), "authorization_endpoint": p.URL() + "/authorize",
			"token_endpoint": p.URL() + "/token", "jwks_uri": p.URL() + "/keys",
			"userinfo_endpoint": p.URL() + "/userinfo", "scopes_supported": p.Scopes,
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/keys":
		e := big.NewInt(int64(p.Key.PublicKey.E)).Bytes()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(p.Key.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(e),
		}}})
	case "/authorize":
		p.mu.Lock()
		p.Auth = r.URL.Query()
		p.Nonce = p.Auth.Get("nonce")
		p.mu.Unlock()
		u, err := url.Parse(r.URL.Query().Get("redirect_uri"))
		if err != nil {
			http.Error(w, "bad redirect", 400)
			return
		}
		q := u.Query()
		q.Set("code", "test-code")
		q.Set("state", r.URL.Query().Get("state"))
		u.RawQuery = q.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
	case "/token":
		if r.FormValue("code") != "test-code" {
			http.Error(w, "bad code", 400)
			return
		}
		p.mu.Lock()
		claims := map[string]any{"iss": p.URL(), "sub": "sub-1", "aud": "test-client",
			"iat": p.Now().Unix(), "exp": p.Now().Add(time.Hour).Unix(), "nonce": p.Nonce}
		for k, v := range p.Claims {
			claims[k] = v
		}
		p.mu.Unlock()
		key := p.Key
		if p.BadSignature {
			key, _ = rsa.GenerateKey(rand.Reader, 2048)
		}
		body, _ := json.Marshal(claims)
		header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "test", "typ": "JWT"})
		unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
		hash := sha256.Sum256([]byte(unsigned))
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if err != nil {
			http.Error(w, "sign", 500)
			return
		}
		token := unsigned + "." + base64.RawURLEncoding.EncodeToString(sig)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "test-access", "token_type": "Bearer",
			"expires_in": 3600, "id_token": token})
	case "/userinfo":
		p.mu.Lock()
		defer p.mu.Unlock()
		info := map[string]any{"sub": "sub-1"}
		for k, v := range p.Info {
			info[k] = v
		}
		_ = json.NewEncoder(w).Encode(info)
	case "/photo":
		if len(p.Photo) == 0 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(p.Photo)
	default:
		http.Error(w, fmt.Sprintf("unknown path %s", r.URL.Path), 404)
	}
}
