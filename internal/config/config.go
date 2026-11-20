// Package config loads runtime settings from environment variables.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// Defaults follow the stock RustDesk port layout: clients derive
// http://<id-server>:21114 as their API server, and hbbs answers
// online queries on its NAT-test port, 21115.
const (
	DefaultClientListenAddr = ":21114"
	DefaultAdminListenAddr  = ":21120"
	DefaultHBBSPort         = "21115"
	DefaultMaxPending       = 500
)

// minSecretKeyBytes is the shortest decoded SECRET_KEY accepted.
const minSecretKeyBytes = 32

type Config struct {
	ClientListenAddr  string
	AdminListenAddr   string
	HBBSAddr          string
	DatabaseURL       string
	PublicURL         *url.URL
	TrustedProxies    []netip.Prefix
	SecretKey         []byte
	MaxPendingDevices int
	DevInsecure       bool
	LogLevel          slog.Level
	LogFormat         string
	// LogExportDir is set by the caller, never from the environment. Empty means /var/log/ferricade.
	LogExportDir string
}

// Load reads CLIENT_LISTEN_ADDR, ADMIN_LISTEN_ADDR, HBBS_ADDR, DATABASE_URL,
// PUBLIC_URL, TRUSTED_PROXIES, SECRET_KEY, MAX_PENDING_DEVICES,
// DEV_INSECURE, LOG_LEVEL and LOG_FORMAT through getenv.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		ClientListenAddr:  or(getenv("CLIENT_LISTEN_ADDR"), DefaultClientListenAddr),
		AdminListenAddr:   or(getenv("ADMIN_LISTEN_ADDR"), DefaultAdminListenAddr),
		DatabaseURL:       strings.TrimSpace(getenv("DATABASE_URL")),
		MaxPendingDevices: DefaultMaxPending,
		DevInsecure:       strings.TrimSpace(getenv("DEV_INSECURE")) == "1",
	}
	if c.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}

	key, err := secretKey(strings.TrimSpace(getenv("SECRET_KEY")))
	if err != nil {
		return Config{}, err
	}
	c.SecretKey = key

	if v := strings.TrimSpace(getenv("MAX_PENDING_DEVICES")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf("MAX_PENDING_DEVICES %q must be a positive integer", v)
		}
		c.MaxPendingDevices = n
	}

	hbbs, err := hbbsAddr(strings.TrimSpace(getenv("HBBS_ADDR")))
	if err != nil {
		return Config{}, err
	}
	c.HBBSAddr = hbbs

	raw := strings.TrimRight(strings.TrimSpace(getenv("PUBLIC_URL")), "/")
	if raw == "" {
		return Config{}, errors.New("PUBLIC_URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return Config{}, fmt.Errorf("PUBLIC_URL %q must be an absolute http or https URL", raw)
	}
	// The RustDesk client strips ":21114" from https API URLs, so clients
	// would call the wrong address.
	if u.Scheme == "https" && u.Port() == "21114" {
		return Config{}, errors.New("PUBLIC_URL must not use https on port 21114: RustDesk clients strip that port")
	}
	if u.Scheme == "http" && !c.DevInsecure {
		return Config{}, errors.New("PUBLIC_URL uses http: set DEV_INSECURE=1 to allow it (development only), or use https")
	}
	c.PublicURL = u

	if tp := strings.TrimSpace(getenv("TRUSTED_PROXIES")); tp != "" {
		for _, s := range strings.Split(tp, ",") {
			p, err := netip.ParsePrefix(strings.TrimSpace(s))
			if err != nil {
				return Config{}, fmt.Errorf("TRUSTED_PROXIES: %w", err)
			}
			c.TrustedProxies = append(c.TrustedProxies, p)
		}
	}

	lvl, err := parseLogLevel(getenv("LOG_LEVEL"))
	if err != nil {
		return Config{}, err
	}
	c.LogLevel = lvl

	fmtName, err := parseLogFormat(getenv("LOG_FORMAT"))
	if err != nil {
		return Config{}, err
	}
	c.LogFormat = fmtName

	return c, nil
}

func parseLogLevel(raw string) (slog.Level, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	switch v {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("LOG_LEVEL %q must be one of debug, info, warn, error", strings.TrimSpace(raw))
	}
}

func parseLogFormat(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	switch v {
	case "", "text":
		return "text", nil
	case "json":
		return "json", nil
	default:
		return "", fmt.Errorf("LOG_FORMAT %q must be text or json", strings.TrimSpace(raw))
	}
}

// secretKey decodes SECRET_KEY, standard base64 with or without padding, and
// requires at least 32 decoded bytes.
func secretKey(v string) ([]byte, error) {
	if v == "" {
		return nil, errors.New("SECRET_KEY is required: base64 of at least 32 random bytes")
	}
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(v)
	}
	if err != nil {
		return nil, errors.New("SECRET_KEY is not valid base64")
	}
	if len(b) < minSecretKeyBytes {
		return nil, fmt.Errorf("SECRET_KEY decodes to %d bytes, need at least %d", len(b), minSecretKeyBytes)
	}
	return b, nil
}

// hbbsAddr validates HBBS_ADDR, the target of online-status queries. Empty
// leaves them off. A missing port means 21115. Loopback is refused: hbbs
// treats loopback peers on that port as its plain-text admin console and
// never answers a protobuf query from them.
func hbbsAddr(v string) (string, error) {
	if v == "" {
		return "", nil
	}
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		host, port = strings.Trim(v, "[]"), DefaultHBBSPort
	}
	ip, ipErr := netip.ParseAddr(host)
	if strings.EqualFold(host, "localhost") || (ipErr == nil && ip.IsLoopback()) {
		return "", fmt.Errorf("HBBS_ADDR %q is a loopback address: hbbs only answers online queries from non-loopback peers; use the host's LAN or container address", v)
	}
	return net.JoinHostPort(host, port), nil
}

func or(v, def string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return def
}
