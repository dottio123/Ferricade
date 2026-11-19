package oidc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store/db"
)

type TestResult struct {
	TestedAt              time.Time `json:"tested_at"`
	OK                    bool      `json:"ok"`
	Error                 *string   `json:"error"`
	AuthorizationEndpoint *string   `json:"authorization_endpoint"`
	TokenEndpoint         *string   `json:"token_endpoint"`
	UserinfoEndpoint      *string   `json:"userinfo_endpoint"`
	GroupsScopeSupported  bool      `json:"groups_scope_supported"`
}

type Settings struct {
	Enabled         bool        `json:"enabled"`
	DisplayName     string      `json:"display_name"`
	Issuer          string      `json:"issuer"`
	ClientID        string      `json:"client_id"`
	ClientSecret    string      `json:"-"`
	ClientSecretSet bool        `json:"client_secret_set"`
	GroupsClaim     string      `json:"groups_claim"`
	OwnerGroups     []string    `json:"owner_groups"`
	AdminGroups     []string    `json:"admin_groups"`
	UserGroups      []string    `json:"user_groups"`
	JITEnabled      bool        `json:"jit_enabled"`
	LastTest        *TestResult `json:"last_test"`
	UpdatedAt       *time.Time  `json:"updated_at"`
}

type Patch struct {
	Enabled      *bool     `json:"enabled"`
	DisplayName  *string   `json:"display_name"`
	Issuer       *string   `json:"issuer"`
	ClientID     *string   `json:"client_id"`
	ClientSecret *string   `json:"client_secret"`
	GroupsClaim  *string   `json:"groups_claim"`
	OwnerGroups  *[]string `json:"owner_groups"`
	AdminGroups  *[]string `json:"admin_groups"`
	UserGroups   *[]string `json:"user_groups"`
	JITEnabled   *bool     `json:"jit_enabled"`
}

func (p *Patch) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields == nil {
		return errors.New("settings patch must be an object")
	}
	for name, value := range fields {
		switch name {
		case "enabled", "display_name", "issuer", "client_id", "client_secret", "groups_claim", "owner_groups", "admin_groups", "user_groups", "jit_enabled":
		default:
			return fmt.Errorf("unknown field %q", name)
		}
		if string(value) == "null" {
			return fmt.Errorf("%s must not be null", name)
		}
	}
	type plain Patch
	return json.Unmarshal(data, (*plain)(p))
}

type ValidationError struct{ Field, Message string }

func (e *ValidationError) Error() string  { return e.Field + ": " + e.Message }
func invalid(field, message string) error { return &ValidationError{field, message} }

func Load(ctx context.Context, q *db.Queries, sealer *auth.Sealer) (Settings, error) {
	r, err := q.GetOIDCSettings(ctx)
	if err != nil {
		return Settings{}, fmt.Errorf("load oidc settings: %w", err)
	}
	return fromRow(r, sealer)
}

func fromRow(r db.OidcSetting, sealer *auth.Sealer) (Settings, error) {
	s := Settings{Enabled: r.Enabled, DisplayName: r.DisplayName, Issuer: r.Issuer, ClientID: r.ClientID,
		ClientSecretSet: len(r.ClientSecretEnc) > 0, GroupsClaim: r.GroupsClaim, OwnerGroups: r.OwnerGroups,
		AdminGroups: r.AdminGroups, UserGroups: r.UserGroups, JITEnabled: r.JitEnabled, UpdatedAt: r.UpdatedAt}
	if s.OwnerGroups == nil {
		s.OwnerGroups = []string{}
	}
	if s.AdminGroups == nil {
		s.AdminGroups = []string{}
	}
	if s.UserGroups == nil {
		s.UserGroups = []string{}
	}
	if len(r.ClientSecretEnc) > 0 {
		plain, err := sealer.Open(r.ClientSecretEnc)
		if err != nil {
			return Settings{}, fmt.Errorf("open oidc secret: %w", err)
		}
		s.ClientSecret = string(plain)
	}
	if len(r.LastTestResult) > 0 {
		var result TestResult
		if err := json.Unmarshal(r.LastTestResult, &result); err != nil {
			return Settings{}, fmt.Errorf("decode oidc test: %w", err)
		}
		s.LastTest = &result
	}
	return s, nil
}

// Save uses the caller's transactional Queries so the change and audit commit together.
func Save(ctx context.Context, q *db.Queries, sealer *auth.Sealer, patch Patch, actor devices.Actor, devInsecure ...bool) (Settings, []string, error) {
	if patch.DisplayName != nil && *patch.DisplayName == "" {
		return Settings{}, nil, invalid("display_name", "must not be empty")
	}
	if patch.ClientSecret != nil && *patch.ClientSecret == "" {
		return Settings{}, nil, invalid("client_secret", "must not be empty")
	}
	row, err := q.GetOIDCSettingsForUpdate(ctx)
	if err != nil {
		return Settings{}, nil, fmt.Errorf("lock oidc settings: %w", err)
	}
	before, err := fromRow(row, sealer)
	if err != nil {
		return Settings{}, nil, err
	}
	next := before
	changed := []string{}
	set := func(name string, old, value any) {
		if !reflect.DeepEqual(old, value) {
			changed = append(changed, name)
		}
	}
	if patch.Enabled != nil {
		set("enabled", next.Enabled, *patch.Enabled)
		next.Enabled = *patch.Enabled
	}
	if patch.DisplayName != nil {
		set("display_name", next.DisplayName, *patch.DisplayName)
		next.DisplayName = *patch.DisplayName
	}
	if patch.Issuer != nil {
		set("issuer", next.Issuer, *patch.Issuer)
		next.Issuer = *patch.Issuer
	}
	if patch.ClientID != nil {
		set("client_id", next.ClientID, *patch.ClientID)
		next.ClientID = *patch.ClientID
	}
	if patch.ClientSecret != nil {
		set("client_secret", next.ClientSecret, *patch.ClientSecret)
		next.ClientSecret = *patch.ClientSecret
		next.ClientSecretSet = true
	}
	if patch.GroupsClaim != nil {
		set("groups_claim", next.GroupsClaim, *patch.GroupsClaim)
		next.GroupsClaim = *patch.GroupsClaim
	}
	if patch.OwnerGroups != nil {
		set("owner_groups", next.OwnerGroups, *patch.OwnerGroups)
		next.OwnerGroups = *patch.OwnerGroups
	}
	if patch.AdminGroups != nil {
		set("admin_groups", next.AdminGroups, *patch.AdminGroups)
		next.AdminGroups = *patch.AdminGroups
	}
	if patch.UserGroups != nil {
		set("user_groups", next.UserGroups, *patch.UserGroups)
		next.UserGroups = *patch.UserGroups
	}
	if patch.JITEnabled != nil {
		set("jit_enabled", next.JITEnabled, *patch.JITEnabled)
		next.JITEnabled = *patch.JITEnabled
	}
	allowHTTP := len(devInsecure) > 0 && devInsecure[0]
	if err := validateMode(next, allowHTTP); err != nil {
		return Settings{}, nil, err
	}
	secret := row.ClientSecretEnc
	if patch.ClientSecret != nil && next.ClientSecret != before.ClientSecret {
		secret, err = sealer.Seal([]byte(next.ClientSecret))
		if err != nil {
			return Settings{}, nil, fmt.Errorf("seal oidc secret: %w", err)
		}
	}
	row, err = q.UpdateOIDCSettings(ctx, db.UpdateOIDCSettingsParams{Enabled: next.Enabled, DisplayName: next.DisplayName,
		Issuer: next.Issuer, ClientID: next.ClientID, ClientSecretEnc: secret, GroupsClaim: next.GroupsClaim,
		OwnerGroups: next.OwnerGroups, AdminGroups: next.AdminGroups, UserGroups: next.UserGroups, JitEnabled: next.JITEnabled, UpdatedBy: &actor.UserID})
	if err != nil {
		return Settings{}, nil, fmt.Errorf("update oidc settings: %w", err)
	}
	if err = audit.Record(ctx, q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP, Action: "settings.oidc_updated",
		TargetType: "settings", TargetID: "oidc", Details: map[string]any{"changed": changed}}); err != nil {
		return Settings{}, nil, err
	}
	next.UpdatedAt = row.UpdatedAt
	return next, changed, nil
}

func validate(s Settings) error {
	return validateMode(s, false)
}

// ValidateIssuer checks stored settings against the server's current transport mode.
func ValidateIssuer(s Settings, devInsecure bool) error {
	return validateMode(s, devInsecure)
}

func validateMode(s Settings, devInsecure bool) error {
	for _, f := range []struct {
		name, value string
		min, max    int
	}{{"display_name", s.DisplayName, 0, 64}, {"issuer", s.Issuer, 0, 512}, {"client_id", s.ClientID, 0, 256}, {"client_secret", s.ClientSecret, 0, 1024}, {"groups_claim", s.GroupsClaim, 1, 128}} {
		if len(f.value) < f.min || len(f.value) > f.max {
			return invalid(f.name, "invalid length")
		}
	}
	for _, g := range []struct {
		name   string
		values []string
	}{{"owner_groups", s.OwnerGroups}, {"admin_groups", s.AdminGroups}, {"user_groups", s.UserGroups}} {
		if len(g.values) > 32 {
			return invalid(g.name, "too many groups")
		}
		for _, value := range g.values {
			if len(value) < 1 || len(value) > 256 {
				return invalid(g.name, "invalid group")
			}
		}
	}
	if s.Issuer != "" {
		u, err := url.Parse(s.Issuer)
		if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (devInsecure || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
			return invalid("issuer", "must be an absolute HTTPS URL or localhost HTTP URL")
		}
	}
	if s.Enabled {
		if s.Issuer == "" {
			return invalid("issuer", "required when enabled")
		}
		if s.ClientID == "" {
			return invalid("client_id", "required when enabled")
		}
		if s.ClientSecret == "" {
			return invalid("client_secret", "required when enabled")
		}
		if len(s.OwnerGroups)+len(s.AdminGroups)+len(s.UserGroups) == 0 {
			return invalid("owner_groups", "owner_groups, admin_groups or user_groups required when enabled")
		}
	}
	return nil
}

func Discover(ctx context.Context, client *http.Client, issuer string, now time.Time) TestResult {
	r := TestResult{TestedAt: now.UTC()}
	fail := func(code string) TestResult { r.Error = &code; return r }
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(issuer, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		return fail("unreachable")
	}
	resp, err := client.Do(req)
	if err != nil {
		return fail("unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail("bad_status")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if err != nil {
		return fail("unreachable")
	}
	if len(body) > 1<<20 {
		return fail("not_json")
	}
	var doc struct {
		Issuer                string   `json:"issuer"`
		AuthorizationEndpoint string   `json:"authorization_endpoint"`
		TokenEndpoint         string   `json:"token_endpoint"`
		UserinfoEndpoint      string   `json:"userinfo_endpoint"`
		ScopesSupported       []string `json:"scopes_supported"`
	}
	if err = json.Unmarshal(body, &doc); err != nil {
		return fail("not_json")
	}
	if doc.Issuer != issuer {
		return fail("issuer_mismatch")
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" {
		return fail("missing_endpoints")
	}
	r.OK = true
	r.AuthorizationEndpoint = &doc.AuthorizationEndpoint
	r.TokenEndpoint = &doc.TokenEndpoint
	if doc.UserinfoEndpoint != "" {
		r.UserinfoEndpoint = &doc.UserinfoEndpoint
	}
	for _, scope := range doc.ScopesSupported {
		if scope == "groups" {
			r.GroupsScopeSupported = true
		}
	}
	return r
}

func IsValidation(err error) (*ValidationError, bool) {
	var e *ValidationError
	return e, errors.As(err, &e)
}
