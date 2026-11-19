// Package recorder is a stand-in client API server for the lab: it answers
// just enough for a RustDesk client to keep talking and writes every request
// as a contract.Fixture, with secrets redacted.
package recorder

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/contract"
)

const maxBody = 1 << 20

type handler struct {
	mu            sync.Mutex
	enc           *json.Encoder
	clientVersion string
}

// New returns a handler that writes one fixture per line to out.
func New(out io.Writer, clientVersion string) http.Handler {
	return &handler{enc: json.NewEncoder(out), clientVersion: clientVersion}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f := contract.Fixture{
		Source:        "captured",
		ClientVersion: h.clientVersion,
		Method:        r.Method,
		Path:          r.URL.Path,
	}
	if q := r.URL.Query(); len(q) > 0 {
		f.Query = map[string]string{}
		for k := range q {
			f.Query[k] = q.Get(k)
		}
	}
	if a := r.Header.Get("Authorization"); a != "" {
		v := redacted
		if scheme, _, ok := strings.Cut(a, " "); ok {
			v = scheme + " " + redacted
		}
		f.Headers = map[string]string{"Authorization": v}
	}

	// Content-Type is ignored on purpose: the client posts /api/login without one.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		h.write(f)
		wire.WriteError(w, http.StatusRequestEntityTooLarge, "body too large")
		return
	case err != nil:
		h.write(f)
		wire.WriteError(w, http.StatusBadRequest, "unreadable body")
		return
	}
	if len(body) > 0 {
		if json.Valid(body) {
			f.Body = Redact(body)
		} else {
			f.Body, _ = json.Marshal(string(body))
		}
	}

	rp := respond(r, body)
	if rp.text != nil {
		f.ResponseText = *rp.text
	} else {
		b, _ := json.Marshal(rp.json)
		f.Response = Redact(b)
	}
	h.write(f)

	if rp.text != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(rp.status)
		_, _ = io.WriteString(w, *rp.text)
		return
	}
	wire.WriteJSON(w, rp.status, rp.json)
}

type reply struct {
	status int
	json   any
	text   *string // plain-text reply instead of JSON; may be empty
}

func jsonReply(v any) reply    { return reply{status: http.StatusOK, json: v} }
func textReply(s string) reply { return reply{status: http.StatusOK, text: &s} }
func notFound() reply {
	return reply{status: http.StatusNotFound, json: wire.ErrorBody{Error: "not found"}}
}
func emptyPage() wire.Page[any] { return wire.Page[any]{Data: []any{}} }

// labUser stands in for any account: the address book and device lists are
// only requested by a signed-in client.
func labUser(name string) wire.UserPayload {
	if name == "" {
		name = "lab"
	}
	return wire.UserPayload{Name: name, DisplayName: name, Status: wire.UserStatusNormal}
}

const emptyLegacyAB = `{"tags":[],"peers":[],"tag_colors":"{}"}`

// respond picks the minimal reply that keeps a client talking.
func respond(r *http.Request, body []byte) reply {
	p := r.URL.Path
	switch {
	case p == "/api/heartbeat":
		return jsonReply(struct{}{})
	case p == "/api/sysinfo":
		return textReply(wire.SysinfoUpdated)
	case p == "/api/login-options":
		return jsonReply([]string{})
	case p == "/api/login":
		var req wire.LoginRequest
		_ = json.Unmarshal(body, &req)
		return jsonReply(wire.AuthBody{AccessToken: "lab-token", Type: wire.AuthTypeAccessToken, User: labUser(req.Username)})
	case p == "/api/currentUser":
		return jsonReply(labUser(""))
	case p == "/api/logout":
		return jsonReply(struct{}{})
	case p == "/api/users", p == "/api/peers", p == "/api/device-group/accessible":
		return jsonReply(emptyPage())
	case p == "/api/ab" && r.Method == http.MethodGet:
		return jsonReply(wire.LegacyAB{Data: emptyLegacyAB})
	case p == "/api/ab" && r.Method == http.MethodPost:
		return textReply("")
	case strings.HasPrefix(p, "/api/audit/"):
		return jsonReply(struct{}{})
	default:
		// Includes /api/ab/personal and /api/ab/settings: a 404 keeps the
		// client on the legacy address book API.
		return notFound()
	}
}

func (h *handler) write(f contract.Fixture) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = h.enc.Encode(f)
}
