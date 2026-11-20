package oidc

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFetchPhotoBlocksNonPublicIPs(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	for _, host := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]"} {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		_, _, err := FetchPhoto(ctx, nil, "https://"+host+":"+fmt.Sprint(port)+"/photo", false, "")
		cancel()
		require.Error(t, err, host)
	}
	require.NoError(t, listener.(*net.TCPListener).SetDeadline(time.Now().Add(100*time.Millisecond)))
	conn, err := listener.Accept()
	if conn != nil {
		conn.Close()
	}
	var netErr net.Error
	require.ErrorAs(t, err, &netErr)
	require.True(t, netErr.Timeout(), err)
}

func TestPublicPhotoAddress(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.1.1", "::ffff:100.64.0.1", "::ffff:198.18.0.1"} {
		addr := netip.MustParseAddr(raw)
		require.False(t, publicPhotoIP(addr), raw)
	}
	require.True(t, publicPhotoIP(netip.MustParseAddr("8.8.8.8")))
}

func TestFetchPhotoLimits(t *testing.T) {
	png := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 32)...)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		switch r.URL.Path {
		case "/large":
			w.Write(make([]byte, 256<<10+1))
		case "/text":
			w.Write([]byte("not an image"))
		case "/redirect":
			http.Redirect(w, r, "http://example.com/photo", http.StatusFound)
		default:
			w.Write(png)
		}
	}))
	defer s.Close()
	require.False(t, allowedPhotoURL("http://example.com/photo", false))
	require.False(t, allowedPhotoURL("http://localhost/photo", false))
	require.False(t, allowedPhotoURL("http://127.0.0.1/photo", false))
	_, _, err := FetchPhoto(context.Background(), s.Client(), "http://example.com/photo", false, "")
	require.Error(t, err)
	got, typ, err := FetchPhoto(context.Background(), s.Client(), s.URL+"/", true, "")
	require.NoError(t, err)
	require.Equal(t, png, got)
	require.Equal(t, "image/png", typ)
	for _, path := range []string{"large", "text", "redirect"} {
		_, _, err := FetchPhoto(context.Background(), s.Client(), s.URL+"/"+path, path != "redirect", "")
		require.Error(t, err, path)
	}
}

func TestFetchPhotoRejectsHTTPRedirectInProduction(t *testing.T) {
	httpTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10})
	}))
	defer httpTarget.Close()
	tlsSource := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, httpTarget.URL+"/photo", http.StatusFound)
	}))
	defer tlsSource.Close()
	_, _, err := FetchPhoto(context.Background(), tlsSource.Client(), tlsSource.URL, false, "")
	require.ErrorContains(t, err, "photo redirect is not allowed")
}

func TestFetchPhotoGraphBearerStaysOnGraph(t *testing.T) {
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.Header.Get("Authorization"))
		_, _ = w.Write(png)
	}))
	defer other.Close()
	graph := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer test-access", r.Header.Get("Authorization"))
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, other.URL, http.StatusFound)
			return
		}
		_, _ = w.Write(png)
	}))
	defer graph.Close()
	roots := x509.NewCertPool()
	roots.AddCert(graph.Certificate())
	roots.AddCert(other.Certificate())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}}
	old := graphPhotoHost
	graphPhotoHost = graph.Listener.Addr().String()
	defer func() { graphPhotoHost = old }()
	for _, raw := range []string{graph.URL, graph.URL + "/redirect"} {
		_, _, err := FetchPhoto(context.Background(), client, raw, false, "test-access")
		require.NoError(t, err)
	}
	_, _, err := FetchPhoto(context.Background(), client, other.URL, false, "test-access")
	require.NoError(t, err)
}
