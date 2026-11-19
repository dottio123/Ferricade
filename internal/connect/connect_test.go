package connect

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func reverseStr(s string) string {
	r := []byte(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// Only '+' in a base64 key is escaped: the client reads the query with Dart's
// Uri.queryParameters, which turns '+' into a space. The command passes the
// raw key, quoted, because the client splits it off "?key=" itself.
func TestLinkVia(t *testing.T) {
	srv := Server{Host: "203.0.113.14", Key: "yCv+7mEgYqt9RiQjZxBwXiNgk9z941/2dZpDUV7UUHE="}
	const q = "?key=yCv%2B7mEgYqt9RiQjZxBwXiNgk9z941/2dZpDUV7UUHE="
	cases := []struct {
		id, action string
		relay      bool
		want       string
	}{
		{"526371378", "connect", false, "rustdesk://526371378@203.0.113.14" + q},
		{"526371378", "connect", true, "rustdesk://526371378/r@203.0.113.14" + q},
		{"526371378", "file-transfer", false, "rustdesk://file-transfer/526371378@203.0.113.14" + q},
		{"526371378", "terminal", true, "rustdesk://terminal/526371378/r@203.0.113.14" + q},
	}
	for _, c := range cases {
		got, err := LinkVia(srv, c.id, c.action, c.relay)
		if err != nil || got != c.want {
			t.Errorf("LinkVia(%q,%q,%v) = %q, %v; want %q", c.id, c.action, c.relay, got, err, c.want)
		}
	}
	withPort, err := LinkVia(Server{Host: "rd.example.com:21116", Key: srv.Key}, "526371378", "connect", false)
	if err != nil || withPort != "rustdesk://526371378@rd.example.com:21116"+q {
		t.Errorf("host with port: %q, %v", withPort, err)
	}
	if got, err := LinkVia(Server{}, "526371378", "connect", true); err != nil || got != "rustdesk://526371378/r" {
		t.Errorf("empty server: %q, %v; want the plain link", got, err)
	}
	if got, err := LinkVia(Server{Host: "rd.example.com", Key: "abc/def=="}, "526371378", "connect", false); err != nil || got != "rustdesk://526371378@rd.example.com?key=abc/def==" {
		t.Errorf("key without plus: %q, %v; want raw slash and padding", got, err)
	}
	for _, bad := range []Server{
		{Host: "a@b", Key: srv.Key}, {Host: "a?b", Key: srv.Key}, {Host: "a/b", Key: srv.Key},
		{Host: "a b", Key: srv.Key}, {Host: "h", Key: "not base64!"}, {Host: "h", Key: ""},
	} {
		if _, err := LinkVia(bad, "526371378", "connect", false); !errors.Is(err, ErrInvalid) {
			t.Errorf("LinkVia(%+v) err = %v; want ErrInvalid", bad, err)
		}
		if _, err := CommandVia(bad, "526371378", "connect", false); !errors.Is(err, ErrInvalid) {
			t.Errorf("CommandVia(%+v) err = %v; want ErrInvalid", bad, err)
		}
	}
}

func TestCommandVia(t *testing.T) {
	srv := Server{Host: "203.0.113.14", Key: "yCv+7mEgYqt9RiQjZxBwXiNgk9z941/2dZpDUV7UUHE="}
	got, err := CommandVia(srv, "526371378", "connect", true)
	want := `rustdesk --connect "526371378/r@203.0.113.14?key=yCv+7mEgYqt9RiQjZxBwXiNgk9z941/2dZpDUV7UUHE="`
	if err != nil || got != want {
		t.Errorf("CommandVia = %q, %v; want %q", got, err, want)
	}
	if got, err := CommandVia(Server{}, "526371378", "terminal", false); err != nil || got != "rustdesk --terminal 526371378" {
		t.Errorf("empty server: %q, %v", got, err)
	}
}

func TestLink(t *testing.T) {
	cases := []struct {
		id, action string
		relay      bool
		want       string
	}{
		{"123456789", "connect", false, "rustdesk://123456789"},
		{"123456789", "connect", true, "rustdesk://123456789/r"},
		{"123456789", "file-transfer", true, "rustdesk://file-transfer/123456789/r"},
		{"123456789", "port-forward", false, "rustdesk://port-forward/123456789"},
		{"abc_-1", "terminal", false, "rustdesk://terminal/abc_-1"},
	}
	for _, c := range cases {
		got, err := Link(c.id, c.action, c.relay)
		if err != nil || got != c.want {
			t.Errorf("Link(%q,%q,%v) = %q, %v; want %q", c.id, c.action, c.relay, got, err, c.want)
		}
	}
	bad := []struct{ id, action string }{
		{"1;rm", "connect"}, {"123", "rdp"}, {"12", "connect"}, {"", "connect"},
		{"123/../x", "connect"}, {strings.Repeat("a", 65), "connect"}, {"123456789", ""},
	}
	for _, c := range bad {
		if _, err := Link(c.id, c.action, false); !errors.Is(err, ErrInvalid) {
			t.Errorf("Link(%q,%q) err = %v; want ErrInvalid", c.id, c.action, err)
		}
		if _, err := Command(c.id, c.action, false); !errors.Is(err, ErrInvalid) {
			t.Errorf("Command(%q,%q) err = %v; want ErrInvalid", c.id, c.action, err)
		}
	}
}

func TestCommand(t *testing.T) {
	cases := []struct {
		id, action string
		relay      bool
		want       string
	}{
		{"123456789", "terminal", true, "rustdesk --terminal 123456789/r"},
		{"123456789", "connect", false, "rustdesk --connect 123456789"},
		{"123456789", "file-transfer", false, "rustdesk --file-transfer 123456789"},
	}
	for _, c := range cases {
		got, err := Command(c.id, c.action, c.relay)
		if err != nil || got != c.want {
			t.Errorf("Command(%q,%q,%v) = %q, %v; want %q", c.id, c.action, c.relay, got, err, c.want)
		}
	}
}

func TestConfigStringRoundTrip(t *testing.T) {
	c := ClientConfig{Host: "rd.example.com", Relay: "rd.example.com:21117", API: "http://rd.example.com:21114", Key: "a+b/c=="}
	s := ConfigString(c)
	if strings.Contains(s, "=") {
		t.Errorf("encoded string has padding: %q", s)
	}
	got, err := DecodeConfigString(s)
	if err != nil || got != c {
		t.Errorf("round trip = %+v, %v; want %+v", got, err, c)
	}
	if _, err := DecodeConfigString("!!!not base64"); err == nil {
		t.Error("expected error for invalid input")
	}
	if _, err := DecodeConfigString(reverseStr(base64.RawURLEncoding.EncodeToString([]byte("not json")))); err == nil {
		t.Error("expected error for non-JSON payload")
	}
}

func TestConfigStringKnownValue(t *testing.T) {
	c := ClientConfig{Host: "h", Relay: "r", API: "a", Key: "k"}
	want := reverseStr(base64.RawURLEncoding.EncodeToString([]byte(`{"host":"h","relay":"r","api":"a","key":"k"}`)))
	if got := ConfigString(c); got != want {
		t.Errorf("ConfigString = %q; want %q", got, want)
	}
}

func TestInstallSnippetsContainConfig(t *testing.T) {
	c := ClientConfig{Host: "h", Relay: "r", API: "a", Key: "k"}
	s := ConfigString(c)
	snips := InstallSnippets(c)
	if len(snips) != 3 {
		t.Fatalf("got %d snippets, want 3", len(snips))
	}
	for _, k := range []string{"windows", "macos", "linux"} {
		v, ok := snips[k]
		if !ok {
			t.Errorf("missing snippet %q", k)
			continue
		}
		if !strings.Contains(v, s) || !strings.Contains(v, "--config") {
			t.Errorf("snippet %q = %q lacks config or --config", k, v)
		}
	}
	if want := `& "$env:ProgramFiles\RustDesk\rustdesk.exe" --config ` + s; snips["windows"] != want {
		t.Errorf("windows = %q; want %q", snips["windows"], want)
	}
	if want := "sudo /Applications/RustDesk.app/Contents/MacOS/RustDesk --config " + s; snips["macos"] != want {
		t.Errorf("macos = %q; want %q", snips["macos"], want)
	}
	if want := "sudo rustdesk --config " + s; snips["linux"] != want {
		t.Errorf("linux = %q; want %q", snips["linux"], want)
	}
}

func TestAPIURL(t *testing.T) {
	cases := []struct{ host, listen, want string }{
		{"rd.example.com", ":21114", "http://rd.example.com:21114"},
		{"rd.example.com:21116", ":9000", "http://rd.example.com:9000"},
		{"rd.example.com", "0.0.0.0:9000", "http://rd.example.com:9000"},
		{"rd.example.com", "", "http://rd.example.com:21114"},
		{"rd.example.com", "garbage", "http://rd.example.com:21114"},
		{"[2001:db8::1]:21116", ":21114", "http://[2001:db8::1]:21114"},
		{"2001:db8::1", ":21114", "http://[2001:db8::1]:21114"},
	}
	for _, c := range cases {
		if got := APIURL(c.host, c.listen); got != c.want {
			t.Errorf("APIURL(%q,%q) = %q; want %q", c.host, c.listen, got, c.want)
		}
	}
}

func TestAPIAddr(t *testing.T) {
	cases := []struct{ host, listen, want string }{
		{"rd.example.com", ":21114", "rd.example.com:21114"},
		{"rd.example.com:21116", ":9000", "rd.example.com:9000"},
		{"[2001:db8::1]:21116", ":21114", "[2001:db8::1]:21114"},
	}
	for _, c := range cases {
		if got := APIAddr(c.host, c.listen); got != c.want {
			t.Errorf("APIAddr(%q,%q) = %q; want %q", c.host, c.listen, got, c.want)
		}
	}
}

func TestValidateAPIURL(t *testing.T) {
	cases := []struct {
		name, input, want string
		valid             bool
	}{
		{"empty", "", "", true},
		{"https host", "https://rustdesk.example.com", "https://rustdesk.example.com", true},
		{"https port", "https://rustdesk.example.com:8443", "https://rustdesk.example.com:8443", true},
		{"trailing slash", "https://rustdesk.example.com/", "https://rustdesk.example.com", true},
		{"http", "http://rustdesk.example.com", "", false},
		{"path", "https://rustdesk.example.com/path", "", false},
		{"query", "https://rustdesk.example.com?x=1", "", false},
		{"fragment", "https://rustdesk.example.com#x", "", false},
		{"empty fragment", "https://rustdesk.example.com#", "", false},
		{"userinfo", "https://user@rustdesk.example.com", "", false},
		{"client api port", "https://rustdesk.example.com:21114", "", false},
		{"garbage", "not a URL", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAPIURL(tc.input)
			if tc.valid && err != nil {
				t.Fatalf("ValidateAPIURL(%q): %v", tc.input, err)
			}
			if !tc.valid && err == nil {
				t.Fatalf("ValidateAPIURL(%q) succeeded", tc.input)
			}
			if got != tc.want {
				t.Fatalf("ValidateAPIURL(%q) = %q; want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestConfiguredAPIAddress(t *testing.T) {
	if got := ConfiguredAPIURL("", "rd.example.com", ":21114"); got != "http://rd.example.com:21114" {
		t.Fatalf("default API URL = %q", got)
	}
	if got := ConfiguredAPIURL("https://api.example.com", "rd.example.com", ":21114"); got != "https://api.example.com" {
		t.Fatalf("configured API URL = %q", got)
	}
	for _, tc := range []struct{ apiURL, want string }{
		{"https://api.example.com", "api.example.com:443"},
		{"https://api.example.com:8443", "api.example.com:8443"},
		{"https://[2001:db8::1]", "[2001:db8::1]:443"},
	} {
		if got := ConfiguredAPIAddr(tc.apiURL, "rd.example.com", ":21114"); got != tc.want {
			t.Errorf("ConfiguredAPIAddr(%q) = %q; want %q", tc.apiURL, got, tc.want)
		}
	}
}
