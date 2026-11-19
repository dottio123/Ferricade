package policies

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

type Policy struct {
	ID                   uuid.UUID
	Name                 string
	IsDefault            bool
	Settings             Settings
	UpdatedAt            time.Time
	UpdatedBy            *uuid.UUID
	UpdatedByDisplayName *string
}

type Resolved struct {
	Policy          Policy
	Source          string
	SourceGroupID   *uuid.UUID
	SourceGroupName string
}

var (
	ErrNotFound        = errors.New("policies: not found")
	ErrNameTaken       = errors.New("policies: name taken")
	ErrInUse           = errors.New("policies: policy in use")
	ErrDefaultPolicy   = errors.New("policies: default policy protected")
	ErrWindowOpen      = errors.New("policies: access window already open")
	ErrPushOff         = errors.New("policies: policy push off")
	ErrAlwaysReachable = errors.New("policies: policy always reachable")
	ErrNotApproved     = errors.New("policies: device not approved")
)

type WindowRow struct {
	ID                uuid.UUID
	DeviceID          uuid.UUID
	OpenedBy          *uuid.UUID
	OpenedAt          time.Time
	EndsAt            *time.Time
	DisconnectOnClose bool
}

type Status struct {
	PushEnabled           bool
	Resolved              Resolved
	Effective             Settings
	State                 string
	Connect               string
	AlwaysReachable       bool
	Window                *WindowRow
	CloseUnconfirmedSince *time.Time
}

func windowFromRow(w db.AccessWindow) WindowRow {
	return WindowRow{ID: w.ID, DeviceID: w.DeviceID, OpenedBy: w.OpenedBy,
		OpenedAt: w.OpenedAt.UTC(), EndsAt: w.EndsAt, DisconnectOnClose: w.DisconnectOnClose}
}

func resolveDeviceWithQueries(ctx context.Context, q *db.Queries, deviceID uuid.UUID) (Resolved, error) {
	r, err := q.ResolveDevicePolicy(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Resolved{}, ErrNotFound
	}
	if err != nil {
		return Resolved{}, fmt.Errorf("policies: resolve device: %w", err)
	}
	return resolved(r.ID, r.Name, r.IsDefault, r.Settings, r.UpdatedAt, r.UpdatedBy, r.Source, r.SourceGroupID, r.SourceGroupName)
}

func (s *Service) OpenWindow(ctx context.Context, a devices.Actor, deviceID uuid.UUID, minutes *int, disconnectOnClose bool) (WindowRow, error) {
	if minutes != nil && *minutes != 60 && *minutes != 240 && *minutes != 480 {
		return WindowRow{}, &ValidationError{Field: "duration_minutes", Msg: "not an allowed value"}
	}
	var out WindowRow
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		dev, err := q.GetWindowDeviceForUpdate(ctx, deviceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("policies: lock window device: %w", err)
		}
		if dev.State != devices.StateApproved {
			return ErrNotApproved
		}
		push, err := q.GetPolicyPushForShare(ctx)
		if err != nil {
			return fmt.Errorf("policies: get push: %w", err)
		}
		if !push.PushEnabled {
			return ErrPushOff
		}
		policy, err := resolveDeviceWithQueries(ctx, q, deviceID)
		if err != nil {
			return err
		}
		if AlwaysReachable(policy.Policy.Settings) {
			return ErrAlwaysReachable
		}
		_, err = q.GetOpenAccessWindow(ctx, deviceID)
		if err == nil {
			return ErrWindowOpen
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("policies: get open window: %w", err)
		}
		now := s.now()
		var ends *time.Time
		if minutes != nil {
			v := now.Add(time.Duration(*minutes) * time.Minute)
			ends = &v
		}
		row, err := q.OpenAccessWindow(ctx, db.OpenAccessWindowParams{DeviceID: deviceID, OpenedBy: &a.UserID, OpenedAt: now, EndsAt: ends, DisconnectOnClose: disconnectOnClose})
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return ErrWindowOpen
			}
			return fmt.Errorf("policies: open window: %w", err)
		}
		out = windowFromRow(row)
		return record(ctx, q, a, "access_window.opened", "device", deviceID.String(), map[string]any{"window_id": row.ID, "duration_minutes": minutes, "disconnect_on_close": disconnectOnClose})
	})
	return out, err
}

func (s *Service) CloseWindow(ctx context.Context, a devices.Actor, deviceID uuid.UUID, disconnect bool) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if _, err := q.GetWindowDeviceForUpdate(ctx, deviceID); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("policies: lock window device: %w", err)
		}
		w, err := q.GetOpenAccessWindowForUpdate(ctx, deviceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("policies: get open window: %w", err)
		}
		now, reason := s.now(), "manual"
		if err := q.CloseAccessWindow(ctx, db.CloseAccessWindowParams{ID: w.ID, ClosedAt: &now, ClosedBy: &a.UserID, Reason: &reason}); err != nil {
			return fmt.Errorf("policies: close window: %w", err)
		}
		var sessions int64
		if disconnect {
			sessions, err = q.RequestDeviceSessionsDisconnect(ctx, db.RequestDeviceSessionsDisconnectParams{DeviceID: deviceID, Now: &now, RequestedBy: &a.UserID})
			if err != nil {
				return fmt.Errorf("policies: request device disconnect: %w", err)
			}
		}
		return record(ctx, q, a, "access_window.closed", "device", deviceID.String(), map[string]any{"window_id": w.ID, "reason": reason, "disconnect": disconnect, "sessions": sessions})
	})
}

func (s *Service) statusWithQueries(ctx context.Context, q *db.Queries, deviceID uuid.UUID) (Status, error) {
	dev, err := q.GetWindowDevice(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Status{}, ErrNotFound
	}
	if err != nil {
		return Status{}, fmt.Errorf("policies: get window device: %w", err)
	}
	r, err := resolveDeviceWithQueries(ctx, q, deviceID)
	if err != nil {
		return Status{}, err
	}
	st := Status{PushEnabled: dev.PushEnabled, Resolved: r, AlwaysReachable: AlwaysReachable(r.Policy.Settings)}
	device, err := q.GetDevice(ctx, deviceID)
	if err != nil {
		return Status{}, fmt.Errorf("policies: get device: %w", err)
	}
	now := s.now()
	open, err := q.GetOpenAccessWindow(ctx, deviceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Status{}, fmt.Errorf("policies: get open window: %w", err)
	}
	var effectiveWindow *Window
	if err == nil {
		w := windowFromRow(open)
		st.Window = &w
		effectiveWindow = &Window{EndsAt: open.EndsAt}
	}
	st.Effective = Effective(r.Policy.Settings, effectiveWindow, now)
	switch {
	case !dev.PushEnabled || st.AlwaysReachable || device.State != devices.StateApproved:
		st.Connect = "unrestricted"
	case effectiveWindow != nil && effectiveWindow.OpenAt(now):
		st.Connect = "window"
	case r.Policy.Settings["approve-mode"] == "click" || r.Policy.Settings["approve-mode"] == "password-click":
		st.Connect = "attended"
	default:
		st.Connect = "locked"
	}
	versionSettings := make(Settings, len(st.Effective)+1)
	for key, value := range st.Effective {
		versionSettings[key] = value
	}
	allowRows, err := q.ListEffectiveDeviceIDAllowList(ctx, deviceID)
	if err != nil {
		return Status{}, fmt.Errorf("policies: resolve device ID allow list: %w", err)
	}
	versionSettings["id-whitelist"] = idAllowListValue(allowRows)
	current := Version(versionSettings)
	if !dev.PushEnabled {
		st.State = "off"
	} else if dev.StrategyVersionSeen != nil && *dev.StrategyVersionSeen == current {
		st.State = "applied"
	} else {
		st.State = "pending"
	}
	closed, err := q.GetLatestUnconfirmedClose(ctx, deviceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Status{}, fmt.Errorf("policies: get unconfirmed close: %w", err)
	}
	if err == nil && closed != nil {
		v := closed.UTC()
		st.CloseUnconfirmedSince = &v
	}
	return st, nil
}

func (s *Service) DeviceStatus(ctx context.Context, deviceID uuid.UUID) (Status, error) {
	return s.statusWithQueries(ctx, db.New(s.Pool), deviceID)
}

// CanConnect reports whether policy blocks a connection, using the caller's query scope.
func (s *Service) CanConnect(ctx context.Context, q *db.Queries, deviceID uuid.UUID) (bool, error) {
	dev, err := q.GetWindowDevice(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, fmt.Errorf("policies: get connect device: %w", err)
	}
	r, err := resolveDeviceWithQueries(ctx, q, deviceID)
	if err != nil {
		return false, err
	}
	if !dev.PushEnabled || AlwaysReachable(r.Policy.Settings) || dev.State != devices.StateApproved {
		return false, nil
	}
	w, err := q.GetOpenAccessWindow(ctx, deviceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("policies: get connect window: %w", err)
	}
	if err == nil && (&Window{EndsAt: w.EndsAt}).OpenAt(s.now()) {
		return false, nil
	}
	return r.Policy.Settings["approve-mode"] != "click" && r.Policy.Settings["approve-mode"] != "password-click", nil
}

func idAllowListValue(rows []db.ListEffectiveDeviceIDAllowListRow) string {
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].SourceOrder != rows[j].SourceOrder {
			return rows[i].SourceOrder < rows[j].SourceOrder
		}
		if rows[i].Depth != rows[j].Depth {
			return rows[i].Depth > rows[j].Depth
		}
		return rows[i].Ordinal < rows[j].Ordinal
	})
	ids, seen := []string{}, map[string]struct{}{}
	for _, allow := range rows {
		key := strings.ToLower(allow.ID)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		ids = append(ids, allow.ID)
	}
	return strings.Join(ids, ",")
}

func (s *Service) SweepExpired(ctx context.Context) error {
	now := s.now()
	var candidateErrors []error
	rows, err := db.New(s.Pool).ListExpiredAccessWindows(ctx, now)
	if err != nil {
		return fmt.Errorf("policies: list expired windows: %w", err)
	}
	for _, candidate := range rows {
		err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
			if _, err := q.GetWindowDeviceForUpdate(ctx, candidate.DeviceID); err != nil {
				return fmt.Errorf("policies: lock expired device: %w", err)
			}
			w, err := q.GetOpenAccessWindowForUpdate(ctx, candidate.DeviceID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("policies: get expired window: %w", err)
			}
			if w.ID != candidate.ID || w.EndsAt == nil || w.EndsAt.After(now) {
				return nil
			}
			reason, closed := "expired", w.EndsAt.UTC()
			if err := q.CloseAccessWindow(ctx, db.CloseAccessWindowParams{ID: w.ID, ClosedAt: &closed, Reason: &reason}); err != nil {
				return fmt.Errorf("policies: close expired window: %w", err)
			}
			var sessions int64
			if w.DisconnectOnClose {
				sessions, err = q.RequestDeviceSessionsDisconnect(ctx, db.RequestDeviceSessionsDisconnectParams{DeviceID: w.DeviceID, Now: &now})
				if err != nil {
					return fmt.Errorf("policies: request expired disconnect: %w", err)
				}
			}
			// Audit requires an IP even for a background system actor.
			return audit.Record(ctx, q, audit.Event{ActorIP: netip.MustParseAddr("127.0.0.1"), Action: "access_window.closed", TargetType: "device", TargetID: w.DeviceID.String(), Details: map[string]any{"window_id": w.ID, "reason": reason, "disconnect": w.DisconnectOnClose, "sessions": sessions}})
		})
		if err != nil {
			candidateErrors = append(candidateErrors, fmt.Errorf("policies: close expired window %s: %w", candidate.ID, err))
		}
	}
	latest, err := db.New(s.Pool).ListUnconfirmedAccessWindowAlerts(ctx, now)
	if err != nil {
		return fmt.Errorf("policies: list closed windows: %w", err)
	}
	for _, w := range latest {
		err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
			details, err := json.Marshal(map[string]any{"window_id": w.ID, "closed_at": w.ClosedAt})
			if err != nil {
				return fmt.Errorf("policies: encode alert: %w", err)
			}
			return q.OpenAccessWindowAlert(ctx, db.OpenAccessWindowAlertParams{DeviceID: w.DeviceID, WindowID: w.ID, Now: now, Details: details})
		})
		if err != nil {
			candidateErrors = append(candidateErrors, fmt.Errorf("policies: open unconfirmed alert for %s: %w", w.ID, err))
		}
	}
	if err := db.New(s.Pool).ResolveConfirmedAccessWindowAlerts(ctx, &now); err != nil {
		candidateErrors = append(candidateErrors, fmt.Errorf("policies: resolve confirmed alerts: %w", err))
	}
	return errors.Join(candidateErrors...)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func policyFromRow(r db.ClientPolicy) (Policy, error) {
	p := Policy{ID: r.ID, Name: r.Name, IsDefault: r.IsDefault, UpdatedAt: r.UpdatedAt.UTC(), UpdatedBy: r.UpdatedBy}
	if err := json.Unmarshal(r.Settings, &p.Settings); err != nil {
		return Policy{}, fmt.Errorf("policies: decode settings: %w", err)
	}
	return p, nil
}

func (s *Service) List(ctx context.Context) ([]Policy, error) {
	rows, err := db.New(s.Pool).ListPoliciesWithActors(ctx)
	if err != nil {
		return nil, fmt.Errorf("policies: list: %w", err)
	}
	out := make([]Policy, 0, len(rows))
	for _, row := range rows {
		p, err := policyFromRow(db.ClientPolicy{ID: row.ID, Name: row.Name, Settings: row.Settings, IsDefault: row.IsDefault,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, UpdatedBy: row.UpdatedBy})
		if err != nil {
			return nil, err
		}
		p.UpdatedByDisplayName = row.UpdatedByDisplayName
		out = append(out, p)
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Policy, error) {
	row, err := db.New(s.Pool).GetPolicy(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, ErrNotFound
	}
	if err != nil {
		return Policy{}, fmt.Errorf("policies: get: %w", err)
	}
	return policyFromRow(row)
}

func checkName(name string) error {
	if n := utf8.RuneCountInString(name); n < 1 || n > 100 {
		return &ValidationError{Field: "name", Msg: "must contain 1 to 100 characters"}
	}
	return nil
}

func (s *Service) Create(ctx context.Context, a devices.Actor, name string, set Settings) (Policy, error) {
	if err := Validate(set); err != nil {
		return Policy{}, err
	}
	if err := checkName(name); err != nil {
		return Policy{}, err
	}
	encoded, err := json.Marshal(set)
	if err != nil {
		return Policy{}, fmt.Errorf("policies: encode settings: %w", err)
	}
	var result Policy
	err = store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		row, err := q.CreatePolicy(ctx, db.CreatePolicyParams{Name: name, Settings: encoded, UpdatedAt: s.now(), UpdatedBy: &a.UserID})
		if err != nil {
			return policyWriteError(err)
		}
		result, err = policyFromRow(row)
		if err != nil {
			return err
		}
		return record(ctx, q, a, "policy.created", "policy", row.ID.String(), map[string]any{"name": row.Name})
	})
	return result, err
}

func (s *Service) Update(ctx context.Context, a devices.Actor, id uuid.UUID, name *string, set *Settings) (Policy, error) {
	if set != nil {
		if err := Validate(*set); err != nil {
			return Policy{}, err
		}
	}
	if name != nil {
		if err := checkName(*name); err != nil {
			return Policy{}, err
		}
	}
	var result Policy
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		current, err := q.GetPolicy(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("policies: get for update: %w", err)
		}
		if current.IsDefault && name != nil && *name != current.Name {
			return ErrDefaultPolicy
		}
		nextName := current.Name
		if name != nil {
			nextName = *name
		}
		encoded := current.Settings
		if set != nil {
			encoded, err = json.Marshal(*set)
			if err != nil {
				return fmt.Errorf("policies: encode settings: %w", err)
			}
		}
		row, err := q.UpdatePolicy(ctx, db.UpdatePolicyParams{ID: id, Name: nextName, Settings: encoded, UpdatedAt: s.now(), UpdatedBy: &a.UserID})
		if err != nil {
			return policyWriteError(err)
		}
		result, err = policyFromRow(row)
		if err != nil {
			return err
		}
		return record(ctx, q, a, "policy.updated", "policy", id.String(), map[string]any{"name": row.Name})
	})
	return result, err
}

func (s *Service) Delete(ctx context.Context, a devices.Actor, id uuid.UUID) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		row, err := q.GetPolicy(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("policies: get for delete: %w", err)
		}
		if row.IsDefault {
			return ErrDefaultPolicy
		}
		count, err := q.CountGroupsUsingPolicy(ctx, &id)
		if err != nil {
			return fmt.Errorf("policies: count groups: %w", err)
		}
		if count > 0 {
			return ErrInUse
		}
		affected, err := q.DeletePolicy(ctx, id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				return ErrInUse
			}
			return fmt.Errorf("policies: delete: %w", err)
		}
		if affected == 0 {
			return ErrNotFound
		}
		return record(ctx, q, a, "policy.deleted", "policy", id.String(), map[string]any{"name": row.Name})
	})
}

func (s *Service) PushEnabled(ctx context.Context) (bool, time.Time, *uuid.UUID, error) {
	row, err := db.New(s.Pool).GetPolicyPush(ctx)
	if err != nil {
		return false, time.Time{}, nil, fmt.Errorf("policies: get push switch: %w", err)
	}
	return row.PushEnabled, row.UpdatedAt.UTC(), row.UpdatedBy, nil
}

func (s *Service) SetPushEnabled(ctx context.Context, a devices.Actor, enabled bool) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		current, err := q.GetPolicyPushForUpdate(ctx)
		if err != nil {
			return fmt.Errorf("policies: get push switch: %w", err)
		}
		if !enabled {
			open, err := q.HasOpenAccessWindows(ctx)
			if err != nil {
				return fmt.Errorf("policies: check open windows: %w", err)
			}
			if open {
				return ErrWindowOpen
			}
		}
		if err := q.SetPolicyPush(ctx, db.SetPolicyPushParams{PushEnabled: enabled, UpdatedAt: s.now(), UpdatedBy: &a.UserID}); err != nil {
			return fmt.Errorf("policies: set push switch: %w", err)
		}
		if current.PushEnabled == enabled {
			return nil
		}
		action := "policy_push.disabled"
		if enabled {
			action = "policy_push.enabled"
		}
		return record(ctx, q, a, action, "settings", "policy_push", nil)
	})
}

func (s *Service) SetGroupPolicy(ctx context.Context, a devices.Actor, groupID uuid.UUID, policyID *uuid.UUID) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		if policyID != nil {
			if _, err := q.GetPolicy(ctx, *policyID); errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			} else if err != nil {
				return fmt.Errorf("policies: get group policy: %w", err)
			}
		}
		count, err := q.SetGroupPolicy(ctx, db.SetGroupPolicyParams{ID: groupID, PolicyID: policyID})
		if err != nil {
			return fmt.Errorf("policies: set group policy: %w", err)
		}
		if count == 0 {
			return ErrNotFound
		}
		return record(ctx, q, a, "group.policy_changed", "group", groupID.String(), map[string]any{"policy_id": policyID})
	})
}

func resolved(id uuid.UUID, name string, isDefault bool, settings []byte, updatedAt time.Time, updatedBy *uuid.UUID, source string, groupID *uuid.UUID, groupName *string) (Resolved, error) {
	p := Policy{ID: id, Name: name, IsDefault: isDefault, UpdatedAt: updatedAt.UTC(), UpdatedBy: updatedBy}
	if err := json.Unmarshal(settings, &p.Settings); err != nil {
		return Resolved{}, fmt.Errorf("policies: decode resolved settings: %w", err)
	}
	r := Resolved{Policy: p, Source: source, SourceGroupID: groupID}
	if groupName != nil {
		r.SourceGroupName = *groupName
	}
	return r, nil
}

func (s *Service) ResolveDevice(ctx context.Context, deviceID uuid.UUID) (Resolved, error) {
	r, err := db.New(s.Pool).ResolveDevicePolicy(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Resolved{}, ErrNotFound
	}
	if err != nil {
		return Resolved{}, fmt.Errorf("policies: resolve device: %w", err)
	}
	return resolved(r.ID, r.Name, r.IsDefault, r.Settings, r.UpdatedAt, r.UpdatedBy, r.Source, r.SourceGroupID, r.SourceGroupName)
}

func (s *Service) ResolveGroup(ctx context.Context, groupID uuid.UUID) (Resolved, error) {
	r, err := db.New(s.Pool).ResolveGroupPolicy(ctx, groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Resolved{}, ErrNotFound
	}
	if err != nil {
		return Resolved{}, fmt.Errorf("policies: resolve group: %w", err)
	}
	return resolved(r.ID, r.Name, r.IsDefault, r.Settings, r.UpdatedAt, r.UpdatedBy, r.Source, r.SourceGroupID, r.SourceGroupName)
}

func (s *Service) Strategy(ctx context.Context, serverID uuid.UUID, rustdeskID, devUUID string, reported int64) (*wire.Strategy, *int64, error) {
	q := db.New(s.Pool)
	row, err := q.GetDeviceStrategyInputs(ctx, db.GetDeviceStrategyInputsParams{ServerID: serverID, RustdeskID: rustdeskID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("policies: get device strategy inputs: %w", err)
	}
	if !row.PushEnabled || row.State != devices.StateApproved || row.UUID != devUUID {
		return nil, nil, nil
	}
	allowRows, err := q.ListEffectiveDeviceIDAllowList(ctx, row.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("policies: resolve ID allow list: %w", err)
	}
	return s.strategyFromInputs(ctx, q, strategyInputs{ID: row.ID, State: row.State, UUID: row.UUID,
		StrategyVersionSeen: row.StrategyVersionSeen, PushEnabled: row.PushEnabled, Settings: row.Settings,
		WindowID: row.WindowID, EndsAt: row.EndsAt, UnconfirmedClose: row.UnconfirmedClose}, allowRows, reported)
}

type strategyInputs struct {
	ID                  uuid.UUID
	State, UUID         string
	StrategyVersionSeen *int64
	PushEnabled         bool
	Settings            []byte
	WindowID            *uuid.UUID
	EndsAt              *time.Time
	UnconfirmedClose    bool
}

func (s *Service) StrategyForDevice(ctx context.Context, deviceID uuid.UUID, devUUID string, reported int64) (*wire.Strategy, *int64, error) {
	q := db.New(s.Pool)
	row, err := q.GetDeviceStrategyInputsByID(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("policies: get device strategy inputs: %w", err)
	}
	if !row.PushEnabled || row.State != devices.StateApproved || row.UUID != devUUID {
		return nil, nil, nil
	}
	var allowRows []db.ListEffectiveDeviceIDAllowListRow
	allowBytes, err := jsonBytes(row.AllowList)
	if err != nil {
		return nil, nil, fmt.Errorf("policies: encode strategy ID allow list: %w", err)
	}
	if err := json.Unmarshal(allowBytes, &allowRows); err != nil {
		return nil, nil, fmt.Errorf("policies: decode strategy ID allow list: %w", err)
	}
	return s.strategyFromInputs(ctx, q, strategyInputs{ID: row.ID, State: row.State, UUID: row.UUID,
		StrategyVersionSeen: row.StrategyVersionSeen, PushEnabled: row.PushEnabled, Settings: row.Settings,
		WindowID: row.WindowID, EndsAt: row.EndsAt, UnconfirmedClose: row.UnconfirmedClose}, allowRows, reported)
}

func jsonBytes(v any) ([]byte, error) {
	switch value := v.(type) {
	case []byte:
		return value, nil
	case string:
		return []byte(value), nil
	default:
		return json.Marshal(value)
	}
}

func (s *Service) strategyFromInputs(ctx context.Context, q *db.Queries, row strategyInputs, allowRows []db.ListEffectiveDeviceIDAllowListRow, reported int64) (*wire.Strategy, *int64, error) {
	var settings Settings
	if err := json.Unmarshal(row.Settings, &settings); err != nil {
		return nil, nil, fmt.Errorf("policies: decode strategy settings: %w", err)
	}
	var window *Window
	if row.EndsAt != nil {
		window = &Window{EndsAt: row.EndsAt}
	} else if row.WindowID != nil {
		window = &Window{}
	}
	now := s.now()
	eff := Effective(settings, window, now)
	eff["id-whitelist"] = idAllowListValue(allowRows)
	v := Version(eff)
	if row.UnconfirmedClose && reported == v && (window == nil || !window.OpenAt(now)) {
		if err := q.ConfirmAccessWindowCloses(ctx, db.ConfirmAccessWindowClosesParams{DeviceID: row.ID, Now: &now}); err != nil {
			return nil, nil, fmt.Errorf("policies: confirm access window closes: %w", err)
		}
	}
	if row.StrategyVersionSeen == nil || *row.StrategyVersionSeen != reported {
		if err := q.SetStrategyVersionSeen(ctx, db.SetStrategyVersionSeenParams{ID: row.ID, Reported: reported}); err != nil {
			return nil, nil, fmt.Errorf("policies: set strategy version seen: %w", err)
		}
	}
	return &wire.Strategy{ConfigOptions: eff}, &v, nil
}

func policyWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrNameTaken
	}
	return fmt.Errorf("policies: write: %w", err)
}

func record(ctx context.Context, q *db.Queries, a devices.Actor, action, target, id string, details map[string]any) error {
	return audit.Record(ctx, q, audit.Event{
		ActorUserID: &a.UserID, ActorIP: a.IP, Action: action,
		TargetType: target, TargetID: id, Details: details,
	})
}
