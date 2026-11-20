package servers

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/dottio123/ferricade/internal/connect"
)

// HealthCheck is one check in the most recently completed round.
type HealthCheck struct {
	Name    string    `json:"name"`
	OK      bool      `json:"ok"`
	Detail  string    `json:"detail"`
	Target  string    `json:"target"`
	Address string    `json:"address"`
	Reason  *string   `json:"reason"`
	Since   time.Time `json:"since"`
}

// Health is the latest completed server check round.
type Health struct {
	Status    string        `json:"status"`
	CheckedAt *time.Time    `json:"checked_at"`
	Checks    []HealthCheck `json:"checks"`
}

// Monitor keeps the latest round in memory. Record may be called concurrently
// by the background loop and the manual check endpoint.
type Monitor struct {
	Log              *slog.Logger
	Interval         time.Duration
	HBBSAddr         string
	ClientListenAddr string
	Dial             func(context.Context, string, string) (net.Conn, error)

	mu     sync.Mutex
	latest Health
}

// Record replaces the latest round and logs transitions.
func (m *Monitor) Record(checks []Check, at time.Time) {
	at = at.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := make(map[string]HealthCheck, len(m.latest.Checks))
	for _, c := range m.latest.Checks {
		previous[c.Name] = c
	}
	latest := Health{Status: "ok", CheckedAt: &at, Checks: make([]HealthCheck, 0, len(checks))}
	log := m.Log
	if log == nil {
		log = slog.Default()
	}
	for _, c := range checks {
		since := at
		old, seen := previous[c.Name]
		if seen && old.OK == c.OK {
			since = old.Since
		}
		var reason *string
		if !c.OK {
			reason = &c.Reason
		}
		latest.Checks = append(latest.Checks, HealthCheck{
			Name: c.Name, OK: c.OK, Detail: c.Detail, Target: c.Target,
			Address: c.Address, Reason: reason, Since: since,
		})
		if !c.OK {
			latest.Status = "degraded"
			if !seen || old.OK {
				log.Warn("rustdesk server check failed", "check", c.Name, "target", c.Target, "address", c.Address, "detail", c.Detail)
			}
		} else if seen && !old.OK {
			log.Info("rustdesk server check recovered", "check", c.Name)
		}
	}
	m.latest = latest
	log.Debug("rustdesk server check", "status", latest.Status, "checks", len(latest.Checks))
}

// Latest returns an independent snapshot for an HTTP response.
func (m *Monitor) Latest() Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.latest.CheckedAt == nil {
		return Health{Status: "unknown", Checks: []HealthCheck{}}
	}
	copy := m.latest
	at := *m.latest.CheckedAt
	copy.CheckedAt = &at
	copy.Checks = append([]HealthCheck{}, m.latest.Checks...)
	return copy
}

// Run checks immediately and then at each interval until canceled. A profile
// is loaded each round so edits to the server profile take effect without a restart.
func (m *Monitor) Run(ctx context.Context, load func(context.Context) (id, relay, apiURL string, ok bool, err error)) {
	interval := m.Interval
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log := m.Log
	if log == nil {
		log = slog.Default()
	}
	dial := m.Dial
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	round := func() {
		id, relay, apiURL, ok, err := load(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Error("rustdesk server profile load failed", "err", err)
			}
			return
		}
		if !ok || ctx.Err() != nil {
			return
		}
		checks := Run(ctx, id, relay, connect.ConfiguredAPIAddr(apiURL, id, m.ClientListenAddr), m.HBBSAddr, dial)
		if ctx.Err() == nil {
			m.Record(checks, time.Now())
		}
	}
	round()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			round()
		}
	}
}
