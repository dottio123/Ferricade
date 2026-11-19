package oidc

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const maxPhotoBytes = 256 << 10

var graphPhotoHost = "graph.microsoft.com"

func allowedPhotoURL(raw string, devInsecure bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && devInsecure
}

func publicPhotoIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() || addr.IsMulticast() {
		return false
	}
	if addr.Is4() {
		for _, prefix := range [...]string{"100.64.0.0/10", "198.18.0.0/15"} {
			if netip.MustParsePrefix(prefix).Contains(addr) {
				return false
			}
		}
	}
	return true
}

func publicPhotoTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("photo host has no addresses")
		}
		for _, ip := range ips {
			if !publicPhotoIP(ip) {
				return nil, fmt.Errorf("photo host resolved to a non-public address")
			}
		}
		var dialErr error
		for _, ip := range ips {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			dialErr = err
		}
		return nil, dialErr
	}
	return transport
}

// FetchPhoto sends the access token only to Microsoft Graph picture URLs.
// The caller's client supplies its transport only; cookies and redirect policy
// are deliberately replaced.
func FetchPhoto(ctx context.Context, client *http.Client, rawURL string, devInsecure bool, accessToken string) ([]byte, string, error) {
	if !allowedPhotoURL(rawURL, devInsecure) {
		return nil, "", fmt.Errorf("photo URL is not allowed")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	transport := http.DefaultTransport
	if client != nil && client.Transport != nil {
		transport = client.Transport
	} else if !devInsecure {
		transport = publicPhotoTransport()
	}
	clean := &http.Client{Transport: transport, Timeout: 5 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 3 || !allowedPhotoURL(req.URL.String(), devInsecure) {
				return fmt.Errorf("photo redirect is not allowed")
			}
			if req.URL.Scheme != "https" || req.URL.Host != graphPhotoHost || req.URL.Host != via[0].URL.Host {
				req.Header.Del("Authorization")
			}
			return nil
		}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("make photo request: %w", err)
	}
	if req.URL.Scheme == "https" && req.URL.Host == graphPhotoHost && accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	resp, err := clean.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("fetch photo: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("photo status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxPhotoBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("read photo: %w", err)
	}
	if len(data) > maxPhotoBytes {
		return nil, "", fmt.Errorf("photo exceeds size limit")
	}
	typ := strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0])
	switch typ {
	case "image/png", "image/jpeg", "image/webp":
		return data, typ, nil
	default:
		return nil, "", fmt.Errorf("photo type is not allowed")
	}
}
