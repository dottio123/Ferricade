// Package connect builds RustDesk connect links, CLI commands, the client
// config string and client install snippets.
package connect

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// ErrInvalid is returned for an unknown action or a malformed RustDesk ID.
var ErrInvalid = errors.New("connect: invalid id or action")

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{3,64}$`)

var actions = map[string]bool{
	"connect":       true,
	"file-transfer": true,
	"port-forward":  true,
	"terminal":      true,
}

// target validates the inputs and returns the ID with the relay suffix applied.
func target(rustdeskID, action string, relay bool) (string, error) {
	if !actions[action] || !idPattern.MatchString(rustdeskID) {
		return "", ErrInvalid
	}
	if relay {
		return rustdeskID + "/r", nil
	}
	return rustdeskID, nil
}

// Server names the RustDesk ID server a link connects through, so the link
// works from a client whose own ID server is a different one (the public
// servers, say). The client reads "<id>@<host>?key=<key>" in Client::start.
type Server struct {
	Host string // ID server host, optionally with :port
	Key  string // base64 public key (id_ed25519.pub)
}

var (
	hostPattern = regexp.MustCompile(`^[A-Za-z0-9.:\[\]-]+$`)
	keyPattern  = regexp.MustCompile(`^[A-Za-z0-9+/]+=*$`)
)

// suffix returns "@host" and the key, or empties for a zero Server.
func (s Server) suffix() (string, string, error) {
	if s == (Server{}) {
		return "", "", nil
	}
	if !hostPattern.MatchString(s.Host) || !keyPattern.MatchString(s.Key) {
		return "", "", ErrInvalid
	}
	return "@" + s.Host, s.Key, nil
}

// Link returns the rustdesk:// URL for the action on the given ID.
func Link(rustdeskID, action string, relay bool) (string, error) {
	return LinkVia(Server{}, rustdeskID, action, relay)
}

// LinkVia is Link through srv: rustdesk://[<action>/]<id>[/r]@<host>?key=<key>.
// The key keeps '=' and '/' raw for the ID box, but escapes '+' because clicked
// links decode it as a space. A zero srv gives the plain Link.
func LinkVia(srv Server, rustdeskID, action string, relay bool) (string, error) {
	t, err := target(rustdeskID, action, relay)
	if err != nil {
		return "", err
	}
	at, key, err := srv.suffix()
	if err != nil {
		return "", err
	}
	u := "rustdesk://" + t + at
	if action != "connect" {
		u = "rustdesk://" + action + "/" + t + at
	}
	if key != "" {
		// Preserve base64 padding and slashes for the client's raw ID-box parser.
		u += "?key=" + strings.NewReplacer("%3D", "=", "%2F", "/").Replace(url.QueryEscape(key))
	}
	return u, nil
}

// Command returns the equivalent RustDesk command line.
func Command(rustdeskID, action string, relay bool) (string, error) {
	return CommandVia(Server{}, rustdeskID, action, relay)
}

// CommandVia is Command through srv. The id argument is quoted because it
// carries '?' and '='; the key stays raw, as the client splits it itself.
func CommandVia(srv Server, rustdeskID, action string, relay bool) (string, error) {
	t, err := target(rustdeskID, action, relay)
	if err != nil {
		return "", err
	}
	at, key, err := srv.suffix()
	if err != nil {
		return "", err
	}
	if at == "" {
		return "rustdesk --" + action + " " + t, nil
	}
	return "rustdesk --" + action + ` "` + t + at + "?key=" + key + `"`, nil
}
