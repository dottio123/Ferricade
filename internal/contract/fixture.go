// Package contract checks recorded or derived client API traffic against
// the wire types.
package contract

import "encoding/json"

// Fixture is one client API exchange. Source is "derived" (written from a
// reading of the client source) or "captured" (recorded from a real client).
type Fixture struct {
	Source        string            `json:"source"`
	ClientVersion string            `json:"client_version"`
	Ref           string            `json:"ref,omitempty"`
	Method        string            `json:"method"`
	Path          string            `json:"path"`
	Query         map[string]string `json:"query,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	Body          json.RawMessage   `json:"body,omitempty"`
	Response      json.RawMessage   `json:"response,omitempty"`
	ResponseText  string            `json:"response_text,omitempty"`
	// ResponseEmpty means the server answers 2xx with no body (the client treats any body as a failure, e.g. audit/conn).
	ResponseEmpty bool `json:"response_empty,omitempty"`
}
