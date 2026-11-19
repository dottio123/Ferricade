// Package idalarms records RustDesk ID whitelist and lockout alarms and summarizes repeats.
package idalarms

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

type Alarm struct {
	ServerID    uuid.UUID
	DeviceID    string
	DeviceUUID  string
	BlockedID   string
	BlockedIP   string
	BlockedName string
	Reason      string
	ActorIP     netip.Addr
}

// Record ignores alarms unless they come from an approved device with its pinned UUID.
func (s *Service) Record(ctx context.Context, a Alarm) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		lookup := db.GetClientDeviceParams{ServerID: a.ServerID, RustdeskID: a.DeviceID}
		candidate, err := q.GetClientDevice(ctx, lookup)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (candidate.State != devices.StateApproved || candidate.UUID != a.DeviceUUID) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("idalarms: look up device: %w", err)
		}
		d, err := q.LockDeviceForBlockedAlarm(ctx, db.LockDeviceForBlockedAlarmParams{ServerID: a.ServerID, RustdeskID: a.DeviceID})
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (d.State != devices.StateApproved || d.UUID != a.DeviceUUID) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("idalarms: lock device: %w", err)
		}
		now := s.now()
		window, err := q.GetBlockedAlarmWindow(ctx, db.GetBlockedAlarmWindowParams{DeviceID: d.ID, BlockedID: a.BlockedID, Reason: a.Reason})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("idalarms: lock alarm window: %w", err)
		}
		expired := err == nil && !window.FirstSeen.Add(10*time.Minute).After(now)
		if expired {
			if window.RepeatCount > 0 {
				if err := repeated(ctx, q, window); err != nil {
					return err
				}
			}
			rows, err := q.DeleteBlockedAlarmWindow(ctx, db.DeleteBlockedAlarmWindowParams{DeviceID: d.ID, BlockedID: a.BlockedID, Reason: a.Reason})
			if err != nil {
				return fmt.Errorf("idalarms: delete expired window: %w", err)
			}
			if rows != 1 {
				return fmt.Errorf("idalarms: delete expired window: expected one row, got %d", rows)
			}
		}
		if err == nil && !expired {
			rows, err := q.IncrementBlockedAlarmWindow(ctx, db.IncrementBlockedAlarmWindowParams{DeviceID: d.ID, BlockedID: a.BlockedID, Reason: a.Reason, Now: now})
			if err != nil {
				return fmt.Errorf("idalarms: update alarm window: %w", err)
			}
			if rows != 1 {
				return fmt.Errorf("idalarms: update alarm window: expected one row, got %d", rows)
			}
			return nil
		}
		count, err := q.CountBlockedAlarmWindows(ctx, d.ID)
		if err != nil {
			return fmt.Errorf("idalarms: count alarm windows: %w", err)
		}
		if count >= 20 {
			// Share the per-device budget so adding alarm reasons cannot multiply audit growth.
			return recordOverflow(ctx, q, d.ID, now)
		}
		rows, err := q.InsertBlockedAlarmWindow(ctx, db.InsertBlockedAlarmWindowParams{DeviceID: d.ID, BlockedID: a.BlockedID, Reason: a.Reason, IP: a.BlockedIP, Name: a.BlockedName, Now: now})
		if err != nil {
			return fmt.Errorf("idalarms: open alarm window: %w", err)
		}
		if rows != 1 {
			return fmt.Errorf("idalarms: open alarm window: expected one row, got %d", rows)
		}
		action := "device.id_blocked"
		details := map[string]any{
			"id": a.BlockedID, "ip": a.BlockedIP, "name": a.BlockedName,
		}
		if a.Reason != "" {
			action = "device.login_locked_out"
			details = lockoutDetails(a.BlockedID, a.BlockedIP, a.BlockedName, a.Reason)
		}
		return audit.Record(ctx, q, audit.Event{ActorIP: a.ActorIP, Action: action, TargetType: "device", TargetID: d.ID.String(), Details: details})
	})
}

func recordOverflow(ctx context.Context, q *db.Queries, deviceID uuid.UUID, now time.Time) error {
	overflow, err := q.GetBlockedAlarmOverflow(ctx, deviceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("idalarms: lock overflow window: %w", err)
	}
	expired := err == nil && !overflow.FirstSeen.Add(10*time.Minute).After(now)
	if expired {
		if err := overflowSummary(ctx, q, overflow.DeviceID, overflow.AlarmCount, overflow.FirstSeen, overflow.LastSeen); err != nil {
			return err
		}
		rows, err := q.DeleteBlockedAlarmOverflow(ctx, deviceID)
		if err != nil {
			return fmt.Errorf("idalarms: delete expired overflow window: %w", err)
		}
		if rows != 1 {
			return fmt.Errorf("idalarms: delete expired overflow window: expected one row, got %d", rows)
		}
	}
	if err == nil && !expired {
		rows, err := q.IncrementBlockedAlarmOverflow(ctx, db.IncrementBlockedAlarmOverflowParams{DeviceID: deviceID, Now: now})
		if err != nil {
			return fmt.Errorf("idalarms: update overflow window: %w", err)
		}
		if rows != 1 {
			return fmt.Errorf("idalarms: update overflow window: expected one row, got %d", rows)
		}
		return nil
	}
	rows, err := q.InsertBlockedAlarmOverflow(ctx, db.InsertBlockedAlarmOverflowParams{DeviceID: deviceID, Now: now})
	if err != nil {
		return fmt.Errorf("idalarms: open overflow window: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("idalarms: open overflow window: expected one row, got %d", rows)
	}
	return nil
}

// SweepExpired writes one summary per expired window, then deletes it.
func (s *Service) SweepExpired(ctx context.Context) error {
	now := s.now()
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		windows, err := q.DeleteExpiredBlockedAlarmWindows(ctx, now)
		if err != nil {
			return fmt.Errorf("idalarms: delete expired windows: %w", err)
		}
		for _, w := range windows {
			if w.RepeatCount > 0 {
				if err := repeated(ctx, q, w); err != nil {
					return err
				}
			}
		}
		overflows, err := q.DeleteExpiredBlockedAlarmOverflow(ctx, now)
		if err != nil {
			return fmt.Errorf("idalarms: delete expired overflow windows: %w", err)
		}
		for _, w := range overflows {
			if err := overflowSummary(ctx, q, w.DeviceID, w.AlarmCount, w.FirstSeen, w.LastSeen); err != nil {
				return err
			}
		}
		return nil
	})
}

func repeated(ctx context.Context, q *db.Queries, w db.IDBlockedAlarmWindow) error {
	action := "device.id_blocked_repeated"
	details := map[string]any{"id": w.BlockedID}
	if w.Reason != "" {
		action = "device.login_locked_out_repeated"
		details = lockoutDetails(w.BlockedID, w.IP, w.Name, w.Reason)
	}
	details["count"], details["first_seen"], details["last_seen"] = w.RepeatCount, w.FirstSeen.UTC(), w.LastSeen.UTC()
	return audit.Record(ctx, q, audit.Event{ActorIP: netip.MustParseAddr("127.0.0.1"), Action: action, TargetType: "device", TargetID: w.DeviceID.String(), Details: details})
}

func lockoutDetails(id, ip, name, reason string) map[string]any {
	return map[string]any{"rustdesk_id": id, "ip": ip, "name": name, "reason": reason}
}

func overflowSummary(ctx context.Context, q *db.Queries, deviceID uuid.UUID, count int32, firstSeen, lastSeen time.Time) error {
	return audit.Record(ctx, q, audit.Event{ActorIP: netip.MustParseAddr("127.0.0.1"), Action: "device.id_blocked_overflow", TargetType: "device", TargetID: deviceID.String(), Details: map[string]any{
		"count": count, "first_seen": firstSeen.UTC(), "last_seen": lastSeen.UTC(),
	}})
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
