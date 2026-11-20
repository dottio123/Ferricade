package config_test

import (
	"encoding/base64"
	"log/slog"
	"reflect"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/config"
)

func TestLogExportDirIsNotReadFromEnvironment(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"LOG_EXPORT_DIR": "/tmp/not-allowed"})))
	require.NoError(t, err)
	field := reflect.ValueOf(c).FieldByName("LogExportDir")
	require.True(t, field.IsValid(), "Config.LogExportDir must exist")
	require.Empty(t, field.String())
}

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// base returns a valid environment; overrides replace or, for an empty
// value, remove entries.
func base(overrides ...map[string]string) map[string]string {
	m := map[string]string{
		"PUBLIC_URL":   "https://admin.example.com",
		"DATABASE_URL": "postgres://x",
		"SECRET_KEY":   base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
	for _, o := range overrides {
		for k, v := range o {
			m[k] = v
		}
	}
	return m
}

func TestLoadDefaults(t *testing.T) {
	c, err := config.Load(env(base()))
	require.NoError(t, err)
	assert.Equal(t, ":21114", c.ClientListenAddr)
	assert.Equal(t, "", c.HBBSAddr, "online query is off until HBBS_ADDR is set")
	assert.Equal(t, "https://admin.example.com", c.PublicURL.String())
	assert.Empty(t, c.TrustedProxies)
}

func TestLoadV2Defaults(t *testing.T) {
	c, err := config.Load(env(base()))
	require.NoError(t, err)
	assert.Equal(t, ":21114", c.ClientListenAddr)
	assert.Equal(t, ":21120", c.AdminListenAddr)
	assert.Equal(t, "postgres://x", c.DatabaseURL)
	assert.Equal(t, 500, c.MaxPendingDevices)
	assert.False(t, c.DevInsecure)
	assert.Len(t, c.SecretKey, 32)
}

func TestLoadOverridesPorts(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{
		"CLIENT_LISTEN_ADDR": ":9000",
		"ADMIN_LISTEN_ADDR":  ":9001",
		"HBBS_ADDR":          "hbbs:31115",
	})))
	require.NoError(t, err)
	assert.Equal(t, ":9000", c.ClientListenAddr)
	assert.Equal(t, ":9001", c.AdminListenAddr)
	assert.Equal(t, "hbbs:31115", c.HBBSAddr)
}

func TestLoadIgnoresLegacyListenAddr(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"LISTEN_ADDR": ":9000"})))
	require.NoError(t, err)
	assert.Equal(t, ":21114", c.ClientListenAddr)
}

func TestLoadRequiresPublicURL(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"PUBLIC_URL": ""})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "PUBLIC_URL")
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"DATABASE_URL": ""})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "DATABASE_URL")
}

func TestLoadSecretKeyEncodings(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	for name, enc := range map[string]string{
		"std padded":   base64.StdEncoding.EncodeToString(key),
		"raw unpadded": base64.RawStdEncoding.EncodeToString(key),
	} {
		c, err := config.Load(env(base(map[string]string{"SECRET_KEY": enc})))
		require.NoError(t, err, name)
		assert.Equal(t, key, c.SecretKey, name)
	}
}

func TestLoadSecretKeyTooShort(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"SECRET_KEY": base64.StdEncoding.EncodeToString(make([]byte, 24))})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SECRET_KEY")
	assert.Contains(t, err.Error(), "openssl rand -base64 32")

	_, err = config.Load(env(base(map[string]string{"SECRET_KEY": "not base64 !!"})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SECRET_KEY")

	_, err = config.Load(env(base(map[string]string{"SECRET_KEY": ""})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SECRET_KEY")
}

func TestLoadHTTPPublicURLNeedsAllowHTTP(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "http://a.example.com"})))
	require.Error(t, err)
	assert.EqualError(t, err, "PUBLIC_URL uses http: use https, or set ALLOW_HTTP=1 for a LAN-only install")

	c, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "http://a.example.com", "ALLOW_HTTP": "1"})))
	require.NoError(t, err)
	assert.True(t, c.DevInsecure)

	c, err = config.Load(env(base(map[string]string{"PUBLIC_URL": "http://a.example.com", "DEV_INSECURE": "1"})))
	require.NoError(t, err)
	assert.True(t, c.DevInsecure)

	c, err = config.Load(env(base(map[string]string{"DEV_INSECURE": "true"})))
	require.NoError(t, err)
	assert.False(t, c.DevInsecure, "only 1 enables DEV_INSECURE")
}

func TestLoadMaxPending(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"MAX_PENDING_DEVICES": "50"})))
	require.NoError(t, err)
	assert.Equal(t, 50, c.MaxPendingDevices)

	for _, v := range []string{"0", "-1", "x"} {
		_, err := config.Load(env(base(map[string]string{"MAX_PENDING_DEVICES": v})))
		require.Error(t, err, v)
		assert.Contains(t, err.Error(), "MAX_PENDING_DEVICES", v)
	}
}

func TestLoadRejectsBadScheme(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "ftp://a.example.com"})))
	require.Error(t, err)
}

func TestLoadTrimsTrailingSlash(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "https://a.example.com/"})))
	require.NoError(t, err)
	assert.Equal(t, "https://a.example.com", c.PublicURL.String())
}

func TestLoadRejectsHTTPS21114(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "https://a.example.com:21114"})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "21114")
}

func TestLoadAllowsHTTP21114(t *testing.T) {
	_, err := config.Load(env(base(map[string]string{"PUBLIC_URL": "http://a.example.com:21114", "DEV_INSECURE": "1"})))
	require.NoError(t, err)
}

func TestLoadParsesTrustedProxies(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"TRUSTED_PROXIES": "10.0.0.0/8, 192.168.1.1/32"})))
	require.NoError(t, err)
	require.Len(t, c.TrustedProxies, 2)
	assert.Equal(t, "10.0.0.0/8", c.TrustedProxies[0].String())

	_, err = config.Load(env(base(map[string]string{"TRUSTED_PROXIES": "nope"})))
	require.Error(t, err)
}

func TestLoadHBBSAddrDefaultsPort(t *testing.T) {
	c, err := config.Load(env(base(map[string]string{"HBBS_ADDR": "hbbs"})))
	require.NoError(t, err)
	assert.Equal(t, "hbbs:21115", c.HBBSAddr)
}

// hbbs treats loopback peers on its NAT port as a plain-text admin console
// (rustdesk-server handle_listener2), so an online query from there never answers.
func TestLoadRejectsLoopbackHBBS(t *testing.T) {
	for _, a := range []string{"127.0.0.1:21115", "localhost:21115", "[::1]:21115", "127.0.0.2"} {
		_, err := config.Load(env(base(map[string]string{"HBBS_ADDR": a})))
		require.Error(t, err, a)
		assert.Contains(t, err.Error(), "loopback", a)
	}
}

func TestLoadLogSettings(t *testing.T) {
	c, err := config.Load(env(base()))
	require.NoError(t, err)
	assert.Equal(t, slog.LevelInfo, c.LogLevel)
	assert.Equal(t, "text", c.LogFormat)

	for raw, want := range map[string]slog.Level{
		"debug":  slog.LevelDebug,
		"DEBUG":  slog.LevelDebug,
		" info ": slog.LevelInfo,
		"Warn":   slog.LevelWarn,
		"ERROR":  slog.LevelError,
	} {
		c, err := config.Load(env(base(map[string]string{"LOG_LEVEL": raw})))
		require.NoError(t, err, raw)
		assert.Equal(t, want, c.LogLevel, raw)
	}

	for raw, want := range map[string]string{
		"text":   "text",
		"TEXT":   "text",
		" json ": "json",
		"Json":   "json",
	} {
		c, err := config.Load(env(base(map[string]string{"LOG_FORMAT": raw})))
		require.NoError(t, err, raw)
		assert.Equal(t, want, c.LogFormat, raw)
	}

	for _, bad := range []string{"trace", "verbose", "1"} {
		_, err := config.Load(env(base(map[string]string{"LOG_LEVEL": bad})))
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "LOG_LEVEL", bad)
	}

	for _, bad := range []string{"yaml", "logfmt", "xml"} {
		_, err := config.Load(env(base(map[string]string{"LOG_FORMAT": bad})))
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "LOG_FORMAT", bad)
	}
}
