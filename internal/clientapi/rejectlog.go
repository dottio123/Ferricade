package clientapi

import (
	"log/slog"
	"sync"
	"time"
	"unicode/utf8"
)

// rejectLogEvery is how often each reason for refusing a client record may
// be logged: a broken or hostile client posting in a loop must not flood the
// log, but an operator must still see that records are being refused.
const rejectLogEvery = 10 * time.Second

// maxLoggedID caps the RustDesk ID written to the log, in characters.
const maxLoggedID = 64

// rejectLog logs refused client records at WARN, at most once per reason per
// rejectLogEvery, with how many were not logged since the last line. It logs
// the reason, the RustDesk ID and the client address only: never the uuid,
// the nonce or the body.
type rejectLog struct {
	log *slog.Logger
	now func() time.Time

	mu      sync.Mutex
	reasons map[string]*rejectReason
}

type rejectReason struct {
	last       time.Time
	suppressed int
}

func newRejectLog(log *slog.Logger, now func() time.Time) *rejectLog {
	return &rejectLog{log: log, now: now, reasons: map[string]*rejectReason{}}
}

// reject records one refused record of msg's kind for reason; rustdeskID and
// requestID may be "".
func (l *rejectLog) reject(msg, reason, rustdeskID, ip, requestID string) {
	now := l.now()
	l.mu.Lock()
	r, ok := l.reasons[reason]
	if !ok {
		r = &rejectReason{}
		l.reasons[reason] = r
	}
	if ok && now.Sub(r.last) < rejectLogEvery {
		r.suppressed++
		l.mu.Unlock()
		return
	}
	suppressed := r.suppressed
	r.last, r.suppressed = now, 0
	l.mu.Unlock()

	attrs := []any{"reason", reason, "ip", ip, "suppressed", suppressed}
	if requestID != "" {
		attrs = append(attrs, "request_id", requestID)
	}
	if rustdeskID != "" {
		attrs = append(attrs, "rustdesk_id", clipID(rustdeskID))
	}
	l.log.Warn(msg, attrs...)
}

// clipID cuts a client-supplied ID to maxLoggedID characters, and replaces
// it when it is not valid UTF-8.
func clipID(s string) string {
	if !utf8.ValidString(s) {
		return "(invalid utf-8)"
	}
	if utf8.RuneCountInString(s) <= maxLoggedID {
		return s
	}
	return string([]rune(s)[:maxLoggedID]) + "…"
}
