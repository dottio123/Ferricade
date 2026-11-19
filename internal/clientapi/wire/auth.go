package wire

import "encoding/json"

// DeviceInfo describes the device asking to sign in.
type DeviceInfo struct {
	OS   string `json:"os"`
	Type string `json:"type"` // "client" or "browser"
	Name string `json:"name"`
}

// LoginRequest is POST /api/login, sent with no Content-Type header.
type LoginRequest struct {
	Username         string     `json:"username"`
	Password         string     `json:"password"`
	ID               string     `json:"id"`
	UUID             string     `json:"uuid"`
	AutoLogin        bool       `json:"autoLogin"`
	Type             string     `json:"type"`
	VerificationCode string     `json:"verificationCode"`
	TfaCode          string     `json:"tfaCode"`
	Secret           string     `json:"secret"`
	DeviceInfo       DeviceInfo `json:"deviceInfo"`
}

// AuthBody answers /api/login and a finished /api/oidc/auth-query.
type AuthBody struct {
	AccessToken string      `json:"access_token"`
	Type        string      `json:"type"`
	TfaType     string      `json:"tfa_type"`
	Secret      string      `json:"secret"`
	User        UserPayload `json:"user"`
}

// UserPayload is also the /api/currentUser response.
type UserPayload struct {
	Name          string   `json:"name"`
	DisplayName   string   `json:"display_name"`
	Avatar        string   `json:"avatar"`
	Email         string   `json:"email"`
	Note          string   `json:"note"`
	Status        int      `json:"status"`
	Info          UserInfo `json:"info"` // required by the Rust client: no serde default
	IsAdmin       bool     `json:"is_admin"`
	ThirdAuthType string   `json:"third_auth_type,omitempty"`
}

// UserInfo must marshal its list and map as [] and {}: the Rust client
// rejects null for them.
type UserInfo struct {
	EmailVerification      bool              `json:"email_verification"`
	EmailAlarmNotification bool              `json:"email_alarm_notification"`
	LoginDeviceWhitelist   []json.RawMessage `json:"login_device_whitelist"`
	Other                  map[string]string `json:"other"`
}

func (u UserInfo) MarshalJSON() ([]byte, error) {
	type plain UserInfo
	p := plain(u)
	if p.LoginDeviceWhitelist == nil {
		p.LoginDeviceWhitelist = []json.RawMessage{}
	}
	if p.Other == nil {
		p.Other = map[string]string{}
	}
	return json.Marshal(p)
}

// OIDCAuthRequest is POST /api/oidc/auth.
type OIDCAuthRequest struct {
	Op         string     `json:"op"`
	ID         string     `json:"id"`
	UUID       string     `json:"uuid"`
	DeviceInfo DeviceInfo `json:"deviceInfo"`
	APIDomain  string     `json:"apiDomain"`
}

// OIDCAuthResponse gives the browser URL and the code the client polls
// GET /api/oidc/auth-query?code=&id=&uuid= with, once a second for 3 minutes.
type OIDCAuthResponse struct {
	Code string `json:"code"`
	URL  string `json:"url"`
}

const (
	AuthTypeAccessToken = "access_token"
	AuthTypeEmailCheck  = "email_check"
	AuthTypeTfaCheck    = "tfa_check"

	// OIDCPending must be the error text while the browser sign-in is
	// unfinished; any other error ends the client's polling.
	OIDCPending = "No authed oidc is found"

	UserStatusDisabled   = 0
	UserStatusNormal     = 1
	UserStatusUnverified = -1
)

// LoginOptions builds the GET /api/login-options body.
func LoginOptions(providers []string) []string {
	out := make([]string, 0, len(providers))
	for _, p := range providers {
		out = append(out, "oidc/"+p)
	}
	return out
}
