package wire_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
)

func TestHeartbeatResponseOmitsEmpty(t *testing.T) {
	b, err := json.Marshal(wire.HeartbeatResponse{})
	require.NoError(t, err)
	assert.Equal(t, "{}", string(b))
}

func TestHeartbeatSysinfoFlag(t *testing.T) {
	b, err := json.Marshal(wire.HeartbeatResponse{Sysinfo: true})
	require.NoError(t, err)
	assert.JSONEq(t, `{"sysinfo":true}`, string(b))
}

func TestHeartbeatResponseStrategy(t *testing.T) {
	ts := int64(1791300000)
	b, err := json.Marshal(wire.HeartbeatResponse{
		Disconnect: []int32{3},
		ModifiedAt: &ts,
		Strategy:   &wire.Strategy{ConfigOptions: map[string]string{"enable-file-transfer": "N"}},
	})
	require.NoError(t, err)
	assert.JSONEq(t, `{"disconnect":[3],"modified_at":1791300000,"strategy":{"config_options":{"enable-file-transfer":"N"}}}`, string(b))
}

func TestParseSysinfoPresets(t *testing.T) {
	s, err := wire.ParseSysinfo([]byte(`{"id":"1","uuid":"dQ==","hostname":"pc1","os":"windows / Windows 11","preset-address-book-name":"Ops","preset-x":7}`))
	require.NoError(t, err)
	assert.Equal(t, "pc1", s.Hostname)
	assert.Equal(t, "windows / Windows 11", s.OS)
	assert.Equal(t, map[string]string{"preset-address-book-name": "Ops"}, s.Presets)
}

func TestParseSysinfoRejectsNonObject(t *testing.T) {
	_, err := wire.ParseSysinfo([]byte(`[1]`))
	require.Error(t, err)
}

func TestAuthBodyAlwaysHasUserInfo(t *testing.T) {
	b, err := json.Marshal(wire.AuthBody{})
	require.NoError(t, err)
	var out struct {
		User struct {
			Info json.RawMessage `json:"info"`
		} `json:"user"`
	}
	require.NoError(t, json.Unmarshal(b, &out))
	assert.True(t, len(out.User.Info) > 0 && string(out.User.Info) != "null", "user.info must be an object, got %s", out.User.Info)
	// serde's #[serde(default)] covers a missing key, not null: Vec/HashMap must be [] and {}.
	assert.JSONEq(t, `{"email_verification":false,"email_alarm_notification":false,"login_device_whitelist":[],"other":{}}`, string(out.User.Info))
}

func TestConnAuditPeerTuple(t *testing.T) {
	var a wire.ConnAudit
	require.NoError(t, json.Unmarshal([]byte(`{"id":"1","uuid":"u","conn_id":4,"session_id":18446744073709551615,"nonce":"n","peer":["987654321","alice"],"type":0}`), &a))
	assert.Equal(t, []string{"987654321", "alice"}, a.Peer)
	assert.Equal(t, uint64(18446744073709551615), a.SessionID)
	require.NotNil(t, a.Type)
	assert.Equal(t, 0, *a.Type)
}

func TestLegacyABRoundTrip(t *testing.T) {
	inner := `{"tags":["work"],"peers":[{"id":"123","username":"u","hostname":"h","platform":"Windows","alias":"","tags":["work"],"hash":"x"}],"tag_colors":"{\"work\":4280391411}"}`
	ab := wire.LegacyAB{Data: inner}
	d, err := ab.Decode()
	require.NoError(t, err)
	require.Len(t, d.Peers, 1)
	assert.Equal(t, "123", d.Peers[0].ID)
	colors, err := d.Colors()
	require.NoError(t, err)
	assert.Equal(t, int64(4280391411), colors["work"])
}

func TestLoginOptions(t *testing.T) {
	assert.Equal(t, []string{"oidc/authentik"}, wire.LoginOptions([]string{"authentik"}))
	assert.Equal(t, []string{}, wire.LoginOptions(nil))
}

func TestDecodeToleratesUnknownFields(t *testing.T) {
	var h wire.HeartbeatRequest
	require.NoError(t, json.Unmarshal([]byte(`{"id":"1","uuid":"u","ver":1005000,"modified_at":0,"future_field":1}`), &h))
	assert.Equal(t, int64(1005000), h.Ver)
}

func TestWriteError(t *testing.T) {
	rec := httptest.NewRecorder()
	wire.WriteError(rec, http.StatusUnauthorized, "bad token")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.JSONEq(t, `{"error":"bad token"}`, rec.Body.String())
}

// Preset passwords (preset-address-book-password, and any other preset key
// ending in "-password", in any case) are never kept.
func TestParseSysinfoDropsPresetPasswords(t *testing.T) {
	s, err := wire.ParseSysinfo([]byte(`{"id":"1","uuid":"dQ==",` +
		`"preset-address-book-name":"Ops","preset-address-book-password":"s3cret",` +
		`"preset-other-PASSWORD":"x","preset-password-hint":"kept"}`))
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"preset-address-book-name": "Ops", "preset-password-hint": "kept"}, s.Presets)
}
