package connect

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ClientConfig is the server configuration a RustDesk client imports.
type ClientConfig struct {
	Host  string `json:"host"`
	Relay string `json:"relay"`
	API   string `json:"api"`
	Key   string `json:"key"`
}

func reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// ConfigString encodes c the way RustDesk clients decode it: JSON, URL-safe
// base64 without padding, then reversed.
func ConfigString(c ClientConfig) string {
	j, _ := json.Marshal(c) // a struct of strings cannot fail to marshal
	return reverse(base64.RawURLEncoding.EncodeToString(j))
}

// DecodeConfigString is the inverse of ConfigString. It also accepts padded input.
func DecodeConfigString(s string) (ClientConfig, error) {
	var c ClientConfig
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(reverse(s), "="))
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return ClientConfig{}, err
	}
	return c, nil
}

// InstallSnippets returns per-OS commands that import c into an installed
// client. They need administrator or root rights (the client's --config
// option requires an installed client).
func InstallSnippets(c ClientConfig) map[string]string {
	s := ConfigString(c)
	return map[string]string{
		"windows": `& "$env:ProgramFiles\RustDesk\rustdesk.exe" --config ` + s,
		"macos":   "sudo /Applications/RustDesk.app/Contents/MacOS/RustDesk --config " + s,
		"linux":   "sudo rustdesk --config " + s,
	}
}

const defaultAPIPort = "21114"

// APIAddr returns the client API address: the ID host (without its own port)
// plus the port from clientListenAddr, defaulting to 21114.
func APIAddr(idHost, clientListenAddr string) string {
	host := idHost
	if h, _, err := net.SplitHostPort(idHost); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	port := defaultAPIPort
	if _, p, err := net.SplitHostPort(clientListenAddr); err == nil && p != "" {
		port = p
	}
	return net.JoinHostPort(host, port)
}

// APIURL returns the client API base URL for the RustDesk client configuration.
func APIURL(idHost, clientListenAddr string) string {
	return "http://" + APIAddr(idHost, clientListenAddr)
}

// ValidateAPIURL accepts an empty override or an HTTPS origin for the client API.
func ValidateAPIURL(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(value, "#") || (u.Path != "" && u.Path != "/") {
		return "", errors.New("must be an https://host[:port] address without path, query, fragment or user info")
	}
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 || port == 21114 {
			return "", errors.New("port must be between 1 and 65535 and cannot be 21114")
		}
	}
	return strings.TrimSuffix(value, "/"), nil
}

// ConfiguredAPIURL selects the stored client API URL or the derived HTTP address.
func ConfiguredAPIURL(apiURL, idHost, clientListenAddr string) string {
	if apiURL != "" {
		return apiURL
	}
	return APIURL(idHost, clientListenAddr)
}

// ConfiguredAPIAddr returns the dial address behind a configured URL or default.
func ConfiguredAPIAddr(apiURL, idHost, clientListenAddr string) string {
	if apiURL == "" {
		return APIAddr(idHost, clientListenAddr)
	}
	u, _ := url.Parse(apiURL) // Stored URLs are validated before entering the profile.
	port := u.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(u.Hostname(), port)
}
