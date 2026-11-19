package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

// HeaderRequestID is the HTTP header carrying the server-generated request ID.
const HeaderRequestID = "X-Request-ID"

type requestIDKey struct{}

// RequestIDFrom returns the request ID stored in ctx, or "".
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// RequestID gives every request a fresh 16-byte hex ID in the context and in
// the X-Request-ID response header. An incoming X-Request-ID header is ignored
// so log lines cannot be forged; if an outer middleware already assigned an ID
// in the context, it is preserved.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestIDFrom(r.Context()) != "" {
			next.ServeHTTP(w, r)
			return
		}
		var raw [16]byte
		_, _ = rand.Read(raw[:]) // crypto/rand.Read never fails
		id := hex.EncodeToString(raw[:])
		w.Header().Set(HeaderRequestID, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// StatusWriter wraps an http.ResponseWriter to record the written status code
// while preserving http.Flusher and http.ResponseController unwrapping.
type StatusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

// NewStatusWriter wraps w, defaulting Status() to 200 if nothing is written.
func NewStatusWriter(w http.ResponseWriter) *StatusWriter {
	return &StatusWriter{ResponseWriter: w, status: http.StatusOK}
}

func (s *StatusWriter) WriteHeader(code int) {
	if s.wroteHeader {
		return
	}
	s.status = code
	s.wroteHeader = true
	s.ResponseWriter.WriteHeader(code)
}

func (s *StatusWriter) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.WriteHeader(http.StatusOK)
	}
	return s.ResponseWriter.Write(b)
}

func (s *StatusWriter) Status() int { return s.status }

func (s *StatusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *StatusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
