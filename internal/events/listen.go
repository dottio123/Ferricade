package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// channel is the Postgres notification channel the database triggers write to.
const channel = "ferricade_events"

// TypeGroupRulesUpdated tells staff to refetch hostname grouping rules.
const TypeGroupRulesUpdated = "group_rules.updated"

// TypeIDAllowListUpdated tells staff to refetch all ID allow lists.
const TypeIDAllowListUpdated = "id_allow_list.updated"

// Reconnect backoff of Listen.
const (
	minBackoff = time.Second
	maxBackoff = 30 * time.Second
	// connectTimeout bounds one connection attempt.
	connectTimeout = 10 * time.Second
	// applicationName names the listener's connection in pg_stat_activity.
	applicationName = "ferricade-events"
)

// Actions of the audit entries written when a device enrolls or is deleted
// (devices.ActionEnrolled and ActionDeleted; repeated here because devices is
// not a dependency of this package).
const (
	actionDeviceEnrolled = "device.enrolled"
	actionDeviceDeleted  = "device.deleted"
)

// notification is the payload of a ferricade_events notification, as built by
// the triggers in the migrations; kind says which fields are set.
type notification struct {
	Kind string `json:"kind"` // audit, session, device or prefs

	AuditID     string `json:"audit_id"`
	ActorUserID string `json:"actor_user_id"`
	Action      string `json:"action"`
	TargetType  string `json:"target_type"`
	TargetID    string `json:"target_id"`

	Op        string `json:"op"` // started, updated or ended (session); updated (device)
	SessionID string `json:"session_id"`
	DeviceID  string `json:"device_id"`

	UserID string `json:"user_id"`
}

// Listen publishes to hub the changes the database announces on the
// ferricade_events channel, until ctx ends. LISTEN belongs to one connection, so
// it opens its own with the pool's settings instead of holding a pool
// connection for good. When that connection fails it reconnects, waiting 1 s
// and doubling up to 30 s while attempts fail, and logs each reconnect at
// WARN. Notifications sent while it is disconnected are lost, so after each
// reconnect (not the first connect) it calls hub.Resync.
func Listen(ctx context.Context, pool *pgxpool.Pool, hub *Hub, log *slog.Logger) {
	cfg := pool.Config().ConnConfig // a copy
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = applicationName
	backoff := minBackoff
	listened := false
	attempt := 0
	listening := func() {
		backoff = minBackoff
		attempt = 0
		// Whatever was announced while disconnected is lost: make every
		// subscriber refetch.
		if listened {
			hub.Resync()
		}
		listened = true
	}
	for {
		err := listenOnce(ctx, cfg, hub, log, listening)
		if ctx.Err() != nil {
			return
		}
		attempt++
		log.Warn("event listener: reconnecting", "attempt", attempt, "err", err, "retry_in", backoff.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// listenOnce connects, listens and publishes notifications until the
// connection fails or ctx ends. It calls listening once LISTEN has succeeded.
func listenOnce(ctx context.Context, cfg *pgx.ConnConfig, hub *Hub, log *slog.Logger, listening func()) error {
	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	conn, err := pgx.ConnectConfig(cctx, cfg)
	cancel()
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), connectTimeout)
		defer cancel()
		_ = conn.Close(cctx)
	}()
	if _, err := conn.Exec(ctx, "LISTEN "+channel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	listening()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification: %w", err)
		}
		for _, e := range mapNotification(n.Payload, log) {
			hub.Publish(e)
		}
	}
}

// mapNotification turns one notification payload into the events it means.
func mapNotification(payload string, log *slog.Logger) []Event {
	var n notification
	if err := json.Unmarshal([]byte(payload), &n); err != nil {
		log.Warn("event listener: undecodable notification", "err", err)
		return nil
	}
	switch n.Kind {
	case "audit":
		out := []Event{{Type: TypeAuditCreated, AuditID: n.AuditID, ActorUserID: n.ActorUserID, TargetType: n.TargetType}}
		if n.Action == "group.rule_added" || n.Action == "group.rule_removed" || n.Action == "group.deleted" {
			out = append(out, Event{Type: TypeGroupRulesUpdated})
		}
		if n.Action == "id_allow_list.updated" {
			out = append(out, Event{Type: TypeIDAllowListUpdated})
		}
		if n.TargetType == "device" && n.TargetID != "" {
			if n.Action == actionDeviceDeleted {
				// Not also device.updated: that would send clients to refetch a
				// device that is gone.
				return append(out, Event{Type: TypeDeviceDeleted, DeviceID: n.TargetID})
			}
			out = append(out, Event{Type: TypeDeviceUpdated, DeviceID: n.TargetID})
			if n.Action == actionDeviceEnrolled {
				out = append(out, Event{Type: TypeDeviceEnrolled, DeviceID: n.TargetID})
			}
		}
		return out
	case "session":
		var typ string
		switch n.Op {
		case "started":
			typ = TypeSessionStarted
		case "updated":
			typ = TypeSessionUpdated
		case "ended":
			typ = TypeSessionEnded
		default:
			log.Warn("event listener: session notification of unknown op", "op", n.Op)
			return nil
		}
		return []Event{{Type: typ, SessionID: n.SessionID, DeviceID: n.DeviceID}}
	case "device":
		if n.Op != "updated" {
			log.Warn("event listener: device notification of unknown op", "op", n.Op)
			return nil
		}
		return []Event{{Type: TypeDeviceUpdated, DeviceID: n.DeviceID}}
	case "prefs":
		return []Event{{Type: TypePreferencesUpdated, UserID: n.UserID}}
	case "grants":
		return []Event{{Type: TypeGrantsChanged, UserID: n.UserID}}
	default:
		log.Warn("event listener: notification of unknown kind", "kind", n.Kind)
		return nil
	}
}
