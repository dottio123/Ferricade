package adminapi

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/oauth2"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/httpx"
	"github.com/dottio123/ferricade/internal/oidc"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type oidcFlow struct {
	State, Nonce, Verifier, Next string
	Exp                          time.Time
}

const oidcFlowAAD = "ferricade/oidc-flow/v1"

func oidcCookieName(dev bool) string {
	if dev {
		return "ferricade_oidc"
	}
	return "__Host-ferricade_oidc"
}

func (a *api) flowCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: oidcCookieName(a.d.Cfg.DevInsecure), Value: value,
		Path: "/", Secure: !a.d.Cfg.DevInsecure, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}

func (a *api) oidcPublic(w http.ResponseWriter, r *http.Request) {
	s, err := oidc.Load(r.Context(), db.New(a.d.Pool), a.d.Sealer)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Enabled     bool   `json:"enabled"`
		DisplayName string `json:"display_name"`
	}{s.Enabled, s.DisplayName})
}

func randomFlowValue() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func redirectSSO(w http.ResponseWriter, r *http.Request, code string) {
	redirectOIDC(w, "/sign-in?sso_error="+code)
}

func redirectOIDC(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
}

func (a *api) oidcStart(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	key := httpx.LimitKey(ip)
	if !a.d.IPLimiter.Begin(key) {
		redirectSSO(w, r, "rate_limited")
		return
	}
	failed := false
	defer func() { a.d.IPLimiter.End(key, failed) }()
	s, err := oidc.Load(r.Context(), db.New(a.d.Pool), a.d.Sealer)
	if err != nil || !s.Enabled || oidc.ValidateIssuer(s, a.d.Cfg.DevInsecure) != nil {
		failed = true
		redirectSSO(w, r, "provider_error")
		return
	}
	p, err := a.oidcProviders.Get(r.Context(), s, a.d.Cfg.PublicURL.String(), a.d.OIDCClient, a.now)
	if err != nil {
		failed = true
		redirectSSO(w, r, "provider_error")
		return
	}
	state, err := randomFlowValue()
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	nonce, err := randomFlowValue()
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	flow := oidcFlow{State: state, Nonce: nonce, Verifier: oauth2.GenerateVerifier(),
		Next: safeOIDCNext(r.URL.Query().Get("next")), Exp: a.now().Add(5 * time.Minute)}
	raw, err := json.Marshal(flow)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	sealed, err := a.d.Sealer.SealWithAAD(raw, []byte(oidcFlowAAD))
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	http.SetCookie(w, a.flowCookie(base64.RawURLEncoding.EncodeToString(sealed), 300))
	redirectOIDC(w, p.AuthCodeURL(state, nonce, flow.Verifier))
}

func (a *api) oidcCallback(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	key := httpx.LimitKey(ip)
	if !a.d.IPLimiter.Begin(key) {
		redirectSSO(w, r, "rate_limited")
		return
	}
	failed := true
	defer func() { a.d.IPLimiter.End(key, failed) }()
	s, err := oidc.Load(r.Context(), db.New(a.d.Pool), a.d.Sealer)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("load OIDC settings: %w", err))
		return
	}
	if !s.Enabled {
		a.log.Debug("oidc callback refused", "class", "disabled", "request_id", requestIDFrom(r.Context()))
		http.SetCookie(w, a.flowCookie("", -1))
		redirectSSO(w, r, "provider_error")
		return
	}
	var flow oidcFlow
	cookie, err := r.Cookie(oidcCookieName(a.d.Cfg.DevInsecure))
	http.SetCookie(w, a.flowCookie("", -1))
	if err != nil {
		a.log.Debug("oidc callback refused", "class", "expired", "request_id", requestIDFrom(r.Context()))
		redirectSSO(w, r, "expired")
		return
	}
	sealed, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		a.log.Debug("oidc callback refused", "class", "expired", "request_id", requestIDFrom(r.Context()))
		redirectSSO(w, r, "expired")
		return
	}
	raw, err := a.d.Sealer.OpenWithAAD(sealed, []byte(oidcFlowAAD))
	if err != nil || json.Unmarshal(raw, &flow) != nil || !a.now().Before(flow.Exp) ||
		flow.State == "" || flow.State != r.URL.Query().Get("state") {
		a.log.Debug("oidc callback refused", "class", "expired", "request_id", requestIDFrom(r.Context()))
		redirectSSO(w, r, "expired")
		return
	}
	if r.URL.Query().Get("error") != "" || r.URL.Query().Get("code") == "" {
		a.oidcFail(w, r, ip, nil, oidc.Claims{}, "provider_error", "provider_error")
		return
	}
	if oidc.ValidateIssuer(s, a.d.Cfg.DevInsecure) != nil {
		a.log.Warn("oidc callback failed", "class", "provider", "request_id", requestIDFrom(r.Context()))
		a.oidcFail(w, r, ip, nil, oidc.Claims{}, "provider_error", "provider_error")
		return
	}
	p, err := a.oidcProviders.Get(r.Context(), s, a.d.Cfg.PublicURL.String(), a.d.OIDCClient, a.now)
	if err != nil {
		a.log.Warn("oidc callback failed", "class", "provider", "request_id", requestIDFrom(r.Context()))
		a.oidcFail(w, r, ip, nil, oidc.Claims{}, "provider_error", "provider_error")
		return
	}
	claims, err := p.ExchangeClaims(r.Context(), r.URL.Query().Get("code"), flow.Verifier, flow.Nonce, s.GroupsClaim)
	if err != nil {
		a.log.Warn("oidc callback failed", "class", oidcErrorClass(err), "request_id", requestIDFrom(r.Context()))
		a.oidcFail(w, r, ip, nil, oidc.Claims{}, "provider_error", "provider_error")
		return
	}
	var out oidc.Outcome
	identity := map[string]any{"issuer": s.Issuer, "sub": claims.Subject, "email": claims.Email}
	err = store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		var err error
		out, err = oidc.Resolve(r.Context(), q, s, s.Issuer, claims, a.now())
		if err != nil {
			return err
		}
		if out.Refusal != "" {
			return nil
		}
		if out.Created {
			if err := audit.Record(r.Context(), q, audit.Event{ActorUserID: &out.UserID, ActorIP: ip, Action: "user.created",
				TargetType: targetUser, TargetID: out.UserID.String(), Details: map[string]any{"via": "oidc", "issuer": s.Issuer, "sub": claims.Subject, "email": claims.Email}}); err != nil {
				return err
			}
		}
		if !out.Created && claims.Email != "" {
			filled, err := q.FillOIDCEmail(r.Context(), db.FillOIDCEmailParams{
				ID: out.UserID, Email: claims.Email, EmailUnverified: !claims.EmailVerified,
			})
			if err != nil {
				return fmt.Errorf("fill oidc email: %w", err)
			}
			if filled != 0 {
				if err := audit.Record(r.Context(), q, audit.Event{ActorUserID: &out.UserID, ActorIP: ip,
					Action: "user.updated", TargetType: targetUser, TargetID: out.UserID.String(),
					Details: map[string]any{"email": map[string]string{"from": "", "to": claims.Email}, "via": "oidc"}}); err != nil {
					return err
				}
			}
		}
		if out.Linked {
			if err := audit.Record(r.Context(), q, audit.Event{ActorUserID: &out.UserID, ActorIP: ip,
				Action: "user.oidc_linked", TargetType: targetUser, TargetID: out.UserID.String(), Details: identity}); err != nil {
				return err
			}
		}
		if !out.Created && out.RoleFrom != out.RoleTo {
			if out.RoleFrom == "user" || out.RoleTo == "user" {
				if err := q.DeleteUserGrants(r.Context(), out.UserID); err != nil {
					return fmt.Errorf("delete user grants: %w", err)
				}
				if err := q.NotifyGrantsChanged(r.Context(), out.UserID); err != nil {
					return fmt.Errorf("notify grants changed: %w", err)
				}
			}
			if err := audit.Record(r.Context(), q, audit.Event{ActorUserID: &out.UserID, ActorIP: ip,
				Action: "user.updated", TargetType: targetUser, TargetID: out.UserID.String(),
				Details: map[string]any{"role": map[string]string{"from": out.RoleFrom, "to": out.RoleTo}, "via": "oidc"}}); err != nil {
				return err
			}
			if out.RoleFrom == "owner" || out.RoleFrom == "user" || out.RoleTo == "user" {
				if err := a.d.Sessions.DeleteForUser(r.Context(), q, out.UserID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		a.log.Warn("oidc callback failed", "class", "resolve", "request_id", requestIDFrom(r.Context()))
		a.oidcFail(w, r, ip, nil, claims, "provider_error", "provider_error")
		return
	}
	if out.Refusal != "" {
		a.oidcFail(w, r, ip, &out, claims, out.Refusal, out.Reason)
		return
	}
	if claims.Picture != "" {
		data, typ, err := oidc.FetchPhoto(r.Context(), a.d.OIDCClient, claims.Picture, a.d.Cfg.DevInsecure, claims.AccessToken)
		if err != nil {
			u, _ := url.Parse(claims.Picture)
			if u != nil {
				u.RawQuery = ""
				u.ForceQuery = false
				u.Fragment = ""
				u.User = nil
				a.log.Warn("oidc photo fetch failed", "url", u.String(), "request_id", requestIDFrom(r.Context()))
			}
		} else if err := db.New(a.d.Pool).SetUserAvatar(r.Context(), db.SetUserAvatarParams{ID: out.UserID,
			Avatar: data, AvatarType: &typ}); err != nil {
			a.log.Warn("oidc photo store failed", "request_id", requestIDFrom(r.Context()))
		}
	}
	var token string
	var sess auth.Session
	err = store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		var err error
		token, sess, err = a.d.Sessions.Create(r.Context(), q, out.UserID, ip, r.UserAgent())
		if err != nil {
			return err
		}
		token, sess, err = a.d.Sessions.Rotate(r.Context(), q, token, true)
		if err != nil {
			return err
		}
		if old, ok := authFrom(r.Context()); ok {
			if err := a.d.Sessions.Delete(r.Context(), q, old.token); err != nil {
				return err
			}
		}
		return audit.Record(r.Context(), q, audit.Event{ActorUserID: &out.UserID, ActorIP: ip,
			Action: actionLogin, TargetType: targetUser, TargetID: out.UserID.String(),
			Details: map[string]any{"method": "oidc", "issuer": s.Issuer, "sub": claims.Subject, "email": claims.Email}})
	})
	if err != nil {
		a.log.Warn("oidc callback failed", "class", "session", "request_id", requestIDFrom(r.Context()))
		a.oidcFail(w, r, ip, &out, claims, "provider_error", "provider_error")
		return
	}
	a.setSessionCookie(w, token, sess)
	a.log.Info("oidc sign-in ok", "user_id", out.UserID.String(), "ip", ip.String(), "request_id", requestIDFrom(r.Context()))
	failed = false
	next := safeOIDCNext(flow.Next)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=%s"><a href="%s">Continue</a>`, html.EscapeString(next), html.EscapeString(next))
}

func (a *api) oidcFail(w http.ResponseWriter, r *http.Request, ip netip.Addr, out *oidc.Outcome, c oidc.Claims, code, reason string) {
	var id *uuid.UUID
	if out != nil && out.UserID != uuid.Nil {
		id = &out.UserID
	}
	err := store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		if id != nil && out != nil && out.MatchedByOIDC && reason != "last_owner" && (code == "not_allowed" || code == "disabled") {
			if err := a.d.Sessions.DeleteForUser(r.Context(), q, *id); err != nil {
				return err
			}
		}
		target := ""
		if id != nil {
			target = id.String()
		}
		return audit.Record(r.Context(), q, audit.Event{ActorUserID: id, ActorIP: ip, Action: actionLoginFailed,
			TargetType: targetUser, TargetID: target,
			Details: map[string]any{"method": "oidc", "reason": reason, "sub": c.Subject, "email": c.Email}})
	})
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	redirectSSO(w, r, code)
}

func oidcErrorClass(err error) string {
	switch {
	case strings.HasPrefix(err.Error(), "exchange oidc code"):
		return "exchange"
	case strings.Contains(err.Error(), "userinfo"):
		return "userinfo"
	default:
		return "verify"
	}
}

// safeOIDCNext follows the web sign-in path rules and rejects auth and API paths.
func safeOIDCNext(raw string) string {
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "/\\") {
		return "/"
	}
	for _, c := range raw {
		if c < 0x20 || c == 0x7f {
			return "/"
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" || strings.Contains(u.Path, "\\") {
		return "/"
	}
	query, err := url.QueryUnescape(u.RawQuery)
	if err != nil {
		return "/"
	}
	for _, value := range []string{u.Path, query, u.Fragment} {
		for _, c := range value {
			if c < 0x20 || c == 0x7f {
				return "/"
			}
		}
	}
	parts := strings.Split(u.Path, "/")
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case ".":
			continue
		case "..":
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		default:
			stack = append(stack, part)
		}
	}
	path := strings.Join(stack, "/")
	if path == "" {
		path = "/"
	}
	escaped := (&url.URL{Path: path}).EscapedPath()
	if strings.HasPrefix(path, "//") || strings.HasPrefix(path, "/\\") || strings.HasPrefix(escaped, "//") || strings.HasPrefix(escaped, "/\\") {
		return "/"
	}
	for _, blocked := range []string{"/sign-in", "/enroll-totp", "/first-run", "/admin/api", "/api", "/healthz", "/setup"} {
		if path == blocked || strings.HasPrefix(path, blocked+"/") {
			return "/"
		}
	}
	return escaped + func() string {
		if u.RawQuery != "" {
			return "?" + u.RawQuery
		}
		return ""
	}() + func() string {
		if u.Fragment != "" {
			return "#" + u.EscapedFragment()
		}
		return ""
	}()
}
