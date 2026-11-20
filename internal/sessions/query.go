package sessions

import (
	"context"
	"errors"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/dottio123/ferricade/internal/keysetcursor"
	"github.com/dottio123/ferricade/internal/store/db"
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

var (
	// ErrInvalidCursor is returned by List for a cursor it did not issue.
	ErrInvalidCursor = errors.New("sessions: invalid cursor")
	// ErrInvalidRange is returned by Stats for a range other than 7d or 30d.
	ErrInvalidRange = errors.New("sessions: invalid range")
	// ErrUnknownZone is returned by Stats for a zone the database does not know.
	ErrUnknownZone = errors.New("sessions: unknown time zone")
)

// Filter narrows List. Zero values mean "no filter". Since is inclusive and
// Until exclusive, both on started_at. Limit defaults to 50 and is capped at
// 200. Cursor is the value List returned with the previous page.
type Filter struct {
	DeviceID  *uuid.UUID
	ScopeUser *uuid.UUID
	Active    *bool
	// Authenticated keeps the sessions whose peer authenticated (true) or
	// did not (false).
	Authenticated *bool
	Since, Until  time.Time
	Limit         int
	Cursor        string
}

// Session is one remote session with the name of its device. Type is the API
// name (see TypeName). DurationSeconds runs to EndedAt, or to now while the
// session is open.
type Session struct {
	ID, DeviceID   uuid.UUID
	DeviceName     string
	RustdeskID     string
	PeerRustdeskID string
	PeerName       string
	Type           string
	ClientIP       *netip.Addr
	StartedAt      time.Time
	AuthedAt       *time.Time
	EndedAt        *time.Time
	EndReason      *string
	// DisconnectRequestedAt is when an admin asked for the session to be
	// disconnected; nil when nobody did.
	DisconnectRequestedAt *time.Time
	DurationSeconds       int64
}

// TypeName is the API name of a session type code: 0 remote, 1 file_transfer,
// 2 port_forward, 3 camera, 4 terminal; nil or any other code is unknown.
func TypeName(t *int16) string {
	if t != nil {
		switch *t {
		case 0:
			return "remote"
		case 1:
			return "file_transfer"
		case 2:
			return "port_forward"
		case 3:
			return "camera"
		case 4:
			return "terminal"
		}
	}
	return "unknown"
}

// deviceName is what the console calls a device: its alias, else its
// hostname, else its RustDesk ID.
func deviceName(alias, hostname, rustdeskID string) string {
	switch {
	case alias != "":
		return alias
	case hostname != "":
		return hostname
	}
	return rustdeskID
}

func seconds(from time.Time, to *time.Time, now time.Time) int64 {
	end := now
	if to != nil {
		end = *to
	}
	return max(0, int64(end.Sub(from)/time.Second))
}

// List returns sessions newest first (by started_at) and the cursor for the
// next page, which is empty on the last page.
func (s *Service) List(ctx context.Context, f Filter) ([]Session, string, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)

	p := db.ListRemoteSessionsParams{
		DeviceID:      f.DeviceID,
		ScopeUser:     f.ScopeUser,
		Active:        f.Active,
		Authenticated: f.Authenticated,
		// One extra row tells us whether another page exists.
		RowLimit: int32(limit + 1),
	}
	if !f.Since.IsZero() {
		p.Since = &f.Since
	}
	if !f.Until.IsZero() {
		p.Until = &f.Until
	}
	if f.Cursor != "" {
		at, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return nil, "", err
		}
		p.CursorAt, p.CursorID = &at, &id
	}
	rows, err := db.New(s.Pool).ListRemoteSessions(ctx, p)
	if err != nil {
		return nil, "", wrap("list", err)
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.StartedAt, last.ID)
	}

	now := s.now()
	out := make([]Session, len(rows))
	for i, r := range rows {
		out[i] = Session{
			ID: r.ID, DeviceID: r.DeviceID, DeviceName: deviceName(r.Alias, r.Hostname, r.RustdeskID),
			RustdeskID: r.RustdeskID, PeerRustdeskID: r.PeerRustdeskID, PeerName: r.PeerName,
			Type: TypeName(r.Type), ClientIP: r.ClientIP, StartedAt: r.StartedAt.UTC(),
			AuthedAt: utc(r.AuthedAt), EndedAt: utc(r.EndedAt), EndReason: r.EndReason,
			DisconnectRequestedAt: utc(r.DisconnectRequestedAt),
			DurationSeconds:       seconds(r.StartedAt, r.EndedAt, now),
		}
	}
	return out, next, nil
}

func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// DayStats is the sessions that started on one calendar day (YYYY-MM-DD).
type DayStats struct {
	Day          string
	Count        int64
	TotalSeconds int64
}

// DeviceStats is one device's sessions in the range.
type DeviceStats struct {
	DeviceID     uuid.UUID
	DeviceName   string
	Count        int64
	TotalSeconds int64
}

// Stats summarises the authenticated sessions started in the range (a
// connection whose peer never authenticated is left out). A session belongs
// to the day it started on, in the caller's time zone, and its whole duration
// counts there; an open session counts up to now.
type Stats struct {
	Range          string
	TZ             string
	PerDay         []DayStats
	AverageSeconds int64
	TopDevices     []DeviceStats
}

// Stats returns the statistics for rng ("7d" or "30d", else ErrInvalidRange):
// one entry per day, today last, including days without sessions, and the
// five devices with the most session time.
func (s *Service) Stats(ctx context.Context, rng string, loc *time.Location, scope ...*uuid.UUID) (Stats, error) {
	var scopeUser *uuid.UUID
	if len(scope) > 0 {
		scopeUser = scope[0]
	}
	var days int
	switch rng {
	case "7d":
		days = 7
	case "30d":
		days = 30
	default:
		return Stats{}, ErrInvalidRange
	}
	now := s.now()
	y, m, d := now.In(loc).Date()
	start := time.Date(y, m, d-(days-1), 0, 0, 0, 0, loc)

	q := db.New(s.Pool)
	rows, err := q.RemoteSessionsPerDay(ctx, db.RemoteSessionsPerDayParams{
		Tz: loc.String(), Now: now, RangeStart: start, ScopeUser: scopeUser,
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22023" { // invalid_parameter_value: Go knew the zone, Postgres does not
		return Stats{}, ErrUnknownZone
	}
	if err != nil {
		return Stats{}, wrap("stats per day", err)
	}
	byDay := make(map[string]db.RemoteSessionsPerDayRow, len(rows))
	for _, r := range rows {
		byDay[r.Day] = r
	}
	st := Stats{Range: rng, TZ: loc.String(), PerDay: make([]DayStats, days)}
	var count, total int64
	for i := range st.PerDay {
		// Noon, so a zone whose midnight does not exist that day cannot shift it.
		day := time.Date(y, m, d-(days-1)+i, 12, 0, 0, 0, loc).Format(time.DateOnly)
		r := byDay[day]
		st.PerDay[i] = DayStats{Day: day, Count: r.Count, TotalSeconds: r.TotalSeconds}
		count += r.Count
		total += r.TotalSeconds
	}
	if count > 0 {
		st.AverageSeconds = (total + count/2) / count
	}

	top, err := q.RemoteSessionsTopDevices(ctx, db.RemoteSessionsTopDevicesParams{Now: now, RangeStart: start, ScopeUser: scopeUser})
	if err != nil {
		return Stats{}, wrap("stats top devices", err)
	}
	st.TopDevices = make([]DeviceStats, len(top))
	for i, r := range top {
		st.TopDevices[i] = DeviceStats{
			DeviceID: r.DeviceID, DeviceName: deviceName(r.Alias, r.Hostname, r.RustdeskID),
			Count: r.Count, TotalSeconds: r.TotalSeconds,
		}
	}
	return st, nil
}

// The cursor is base64url of "<unix microseconds>.<uuid>" of the last listed
// session; Postgres timestamps have microsecond precision, so it round-trips.
func encodeCursor(at time.Time, id uuid.UUID) string {
	return keysetcursor.Encode(at, id)
}

func decodeCursor(s string) (time.Time, uuid.UUID, error) {
	at, id, err := keysetcursor.Decode(s)
	if err != nil {
		return time.Time{}, uuid.Nil, ErrInvalidCursor
	}
	// A forged value outside timestamptz's range would make the query fail.
	if at.Year() < 2000 || at.Year() > 9999 {
		return time.Time{}, uuid.Nil, ErrInvalidCursor
	}
	return at, id, nil
}
