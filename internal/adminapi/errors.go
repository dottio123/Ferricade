package adminapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/devices"
)

const codePatternTaken = "pattern_taken" // 409

const codeReauthRequired = "reauthentication_required" // 403

// Error codes of the admin API. Each is used with one HTTP status.
const (
	codeBadRequest         = "bad_request"          // 400
	codeValidationError    = "validation_error"     // 400
	codeWeakPassword       = "weak_password"        // 400
	codeInvalidKey         = "invalid_key"          // 400
	codeInvalidCode        = "invalid_code"         // 400
	codeCodeAlreadyUsed    = "code_already_used"    // 400
	codeUnauthenticated    = "unauthenticated"      // 401
	codeCSRF               = "csrf"                 // 403
	codeMFARequired        = "mfa_required"         // 403
	codeTOTPEnrollRequired = "totp_enroll_required" // 403
	codeForbidden          = "forbidden"            // 403
	codeNotFound           = "not_found"            // 404
	codeIncomplete         = "incomplete"           // 409
	codeBadTransition      = "bad_transition"       // 409
	codeCycle              = "cycle"                // 409
	codeNotEmpty           = "not_empty"            // 409
	codeLastOwner          = "last_owner"           // 409
	codeUsernameTaken      = "username_taken"       // 409
	codeNameTaken          = "name_taken"           // 409
	codeInUse              = "in_use"               // 409
	codeDefaultPolicy      = "default_policy"       // 409
	codeWindowOpen         = "window_open"          // 409
	codePushOff            = "push_off"             // 409
	codeAlwaysReachable    = "always_reachable"     // 409
	codeAccessLocked       = "access_locked"        // 409
	codeLocked             = "locked"               // 423
	codeRateLimited        = "rate_limited"         // 429
	codeInternal           = "internal"             // 500
	codeBusy               = "busy"                 // 503
)

// maxBody caps admin request bodies.
const maxBody = 64 << 10

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

// writeJSON writes v as the JSON response body with status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes {"error":{"code":code,"message":msg}} with status.
func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: msg}})
}

// writeInternal logs err with the request ID and writes the 500 response,
// which carries the request ID but no detail.
func (a *api) writeInternal(w http.ResponseWriter, r *http.Request, err error) {
	id := requestIDFrom(r.Context())
	a.log.Error("admin api: internal error", "request_id", id, "method", r.Method, "path", r.URL.Path, "err", err)
	writeJSON(w, http.StatusInternalServerError, errorBody{Error: errorDetail{
		Code: codeInternal, Message: "internal error", RequestID: id,
	}})
}

// writeBusy answers 503 "busy" with Retry-After: 1, for a request refused
// because no password-hashing slot freed up in time (auth.ErrBusy).
func writeBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeError(w, http.StatusServiceUnavailable, codeBusy, "server busy, retry")
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, codeNotFound, "not found")
}

// decode reads a JSON object from the request body into v. Unknown fields,
// trailing data and bodies over maxBody are rejected. On failure it writes a
// 400 and returns false.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeLimit(w, r, v, maxBody)
}

// decodeLimit is decode with a body cap of limit bytes.
func decodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "request body must be a JSON object with the documented fields")
		return false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "request body has trailing data")
		return false
	}
	return true
}

// apiError is an error a handler's transaction returns to be answered as is.
type apiError struct {
	status    int
	code, msg string
}

func (e *apiError) Error() string { return e.code + ": " + e.msg }

// writeAPIError writes err when it is an *apiError and reports whether it was.
func writeAPIError(w http.ResponseWriter, err error) bool {
	var ae *apiError
	if !errors.As(err, &ae) {
		return false
	}
	writeError(w, ae.status, ae.code, ae.msg)
	return true
}

// writeDevicesError maps the devices package's errors to responses.
func (a *api) writeDevicesError(w http.ResponseWriter, r *http.Request, err error) {
	var input devices.InputError
	switch {
	case errors.Is(err, devices.ErrNotFound):
		notFound(w, r)
	case errors.Is(err, devices.ErrBadTransition):
		writeError(w, http.StatusConflict, codeBadTransition, "the device's state does not allow this change")
	case errors.Is(err, devices.ErrWindowOpen):
		writeError(w, http.StatusConflict, codeWindowOpen, "close the access window first")
	case errors.Is(err, devices.ErrCycle):
		writeError(w, http.StatusConflict, codeCycle, "a group cannot move under itself or one of its descendants")
	case errors.Is(err, devices.ErrNotEmpty):
		writeError(w, http.StatusConflict, codeNotEmpty, "the group still has child groups or devices")
	case errors.Is(err, devices.ErrNameTaken):
		writeError(w, http.StatusConflict, codeNameTaken, "the name is already in use")
	case errors.Is(err, devices.ErrInvalidCursor):
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid cursor")
	case errors.As(err, &input):
		writeError(w, http.StatusBadRequest, codeBadRequest, input.Error())
	default:
		a.writeInternal(w, r, err)
	}
}

// nullable is a JSON field that can be absent (set false), null (set true,
// v nil) or a value.
type nullable[T any] struct {
	set bool
	v   *T
}

func (n *nullable[T]) UnmarshalJSON(b []byte) error {
	n.set = true
	if string(b) == "null" {
		n.v = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	n.v = &v
	return nil
}

// patch returns nil when the field was absent, else a pointer to its value
// (itself nil for null).
func (n nullable[T]) patch() **T {
	if !n.set {
		return nil
	}
	return &n.v
}

// pathID parses the path parameter name as a UUID. Anything else cannot
// name a resource, so it writes 404.
func pathID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		notFound(w, r)
		return uuid.Nil, false
	}
	return id, true
}

// maxQueryParam bounds a free-text query parameter, and maxCursor a cursor,
// in bytes. The lists decode and check the cursors they issued.
const (
	maxQueryParam = 256
	maxCursor     = 1024
)

// queryText returns the query parameter name, which must be valid UTF-8
// without NUL of at most 256 bytes; otherwise it writes 400.
func queryText(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	v := r.URL.Query().Get(name)
	if len(v) > maxQueryParam || !utf8.ValidString(v) || strings.ContainsRune(v, 0) {
		writeError(w, http.StatusBadRequest, codeBadRequest, fmt.Sprintf("%s must be at most %d bytes of text", name, maxQueryParam))
		return "", false
	}
	return v, true
}

// queryUUID returns the query parameter name as a UUID, nil when it is
// absent; a malformed value writes 400.
func queryUUID(w http.ResponseWriter, r *http.Request, name string) (*uuid.UUID, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return nil, true
	}
	id, err := uuid.Parse(v)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, name+" must be a UUID")
		return nil, false
	}
	return &id, true
}

// page reads ?limit= (a positive integer; 0 when absent, which lists use as
// their default of 50; values over 200 are capped by the lists) and ?cursor=.
func page(w http.ResponseWriter, r *http.Request) (limit int, cursor string, ok bool) {
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, codeBadRequest, "limit must be a positive integer (at most 200 are returned)")
			return 0, "", false
		}
		limit = n
	}
	cursor = r.URL.Query().Get("cursor")
	if len(cursor) > maxCursor {
		writeError(w, http.StatusBadRequest, codeBadRequest, "invalid cursor")
		return 0, "", false
	}
	return limit, cursor, true
}

// listJSON is the shape of every list response. NextCursor is "" on the last
// page.
type listJSON[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor"`
}

// actor returns the signed-in user and client address as a devices.Actor.
func (a *api) actor(w http.ResponseWriter, r *http.Request) (devices.Actor, bool) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return devices.Actor{}, false
	}
	return devices.Actor{UserID: userFrom(r.Context()).ID, IP: ip}, true
}
