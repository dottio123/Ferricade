// Package devices owns device enrollment, identity and lifecycle.
//
// Service implements the device side of the client API's heartbeat and
// sysinfo calls (spec, "Client API behavior"): unknown devices enroll as
// pending, each device is pinned to the uuid it enrolled with, and rejected
// or archived devices are ignored. Its admin methods list, edit, approve,
// reject, archive and restore devices and resolve their alerts; Groups and
// Tags manage the group tree and tags. Every admin change is audited in its
// transaction.
package devices

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/clientapi/wire"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// Device states, as stored in devices.state.
const (
	StatePending  = "pending"
	StateApproved = "approved"
	StateRejected = "rejected"
	StateArchived = "archived"
)

// Audit actions written by the client API path.
const (
	ActionEnrolled      = "device.enrolled"
	ActionEnrollDropped = "device.enroll_dropped"
	ActionUUIDMismatch  = "device.uuid_mismatch"
)

// dropAuditEvery is the least time between two device.enroll_dropped events.
const dropAuditEvery = 10 * time.Minute

// Beater records a heartbeat in the online tracker.
type Beater interface {
	Beat(rustdeskID string, conns []int32)
}

// Service handles heartbeats and sysinfo for one server profile.
//
// MaxPending caps enrollment: an unknown device enrolls only while fewer than
// MaxPending devices are pending. The count and the insert run in one
// read-committed transaction serialized by server, so concurrent enrollments
// cannot overshoot the cap.
type Service struct {
	Pool       *pgxpool.Pool
	Beats      Beater
	MaxPending int
	Now        func() time.Time // defaults to time.Now
	Log        *slog.Logger
	// GroupPlacement runs within the approval transaction; the app wires the rules service.
	GroupPlacement func(context.Context, *db.Queries, string) ([]uuid.UUID, string, error)

	mu       sync.Mutex
	lastDrop time.Time // when device.enroll_dropped was last written
}

func (s *Service) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Heartbeat handles POST /api/heartbeat. A pending or approved device with
// its pinned uuid is beaten into the tracker and asked for sysinfo until one
// is stored; every other case gets an empty reply.
func (s *Service) Heartbeat(ctx context.Context, serverID uuid.UUID, hb wire.HeartbeatRequest, ip netip.Addr) (wire.HeartbeatResponse, error) {
	resp, _, err := s.HeartbeatWithDeviceID(ctx, serverID, hb, ip)
	return resp, err
}

// HeartbeatWithDeviceID returns the accepted device ID for other heartbeat work.
func (s *Service) HeartbeatWithDeviceID(ctx context.Context, serverID uuid.UUID, hb wire.HeartbeatRequest, ip netip.Addr) (wire.HeartbeatResponse, uuid.UUID, error) {
	var (
		resp     wire.HeartbeatResponse
		trusted  bool
		enrolled bool
		deviceID uuid.UUID
	)
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		d, ok, newlyEnrolled, err := s.identify(ctx, q, serverID, hb.ID, hb.UUID, ip)
		if err != nil || !ok {
			return err
		}
		trusted = true
		enrolled = newlyEnrolled
		deviceID = d.ID
		resp.Sysinfo = !d.HasSysinfo
		return nil
	})
	if err != nil {
		return wire.HeartbeatResponse{}, uuid.Nil, err
	}
	if enrolled {
		s.logger().Info("device enrolled", "rustdesk_id", hb.ID)
	}
	if trusted {
		s.Beats.Beat(hb.ID, hb.Conns)
	}
	return resp, deviceID, nil
}

// Sysinfo handles POST /api/sysinfo, storing the reported fields for a
// pending or approved device with its pinned uuid. The client is told
// SYSINFO_UPDATED whatever happens, so only errors are returned.
func (s *Service) Sysinfo(ctx context.Context, serverID uuid.UUID, si wire.SysinfoRequest, ip netip.Addr) error {
	presets := si.Presets
	if presets == nil {
		presets = map[string]string{} // stored as {}: NULL means "no sysinfo yet"
	}
	presetsJSON, err := json.Marshal(presets)
	if err != nil {
		return fmt.Errorf("devices: encode presets: %w", err)
	}
	var enrolled bool
	err = store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		d, ok, newlyEnrolled, err := s.identify(ctx, q, serverID, si.ID, si.UUID, ip)
		if err != nil || !ok {
			return err
		}
		enrolled = newlyEnrolled
		if _, err := q.StoreDeviceSysinfo(ctx, db.StoreDeviceSysinfoParams{
			ID: d.ID, UUID: si.UUID,
			Hostname: si.Hostname, OS: si.OS, CPU: si.CPU, Memory: si.Memory,
			ClientVersion: si.Version, Username: si.Username, Presets: presetsJSON,
		}); err != nil {
			return fmt.Errorf("devices: store sysinfo: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if enrolled {
		s.logger().Info("device enrolled", "rustdesk_id", si.ID)
	}
	return nil
}

// identify finds the device a request comes from, enrolling it when unknown.
// It reports ok only for a pending or approved device whose pinned uuid
// matches devUUID. A uuid mismatch on such a device opens an alert.
func (s *Service) identify(ctx context.Context, q *db.Queries, serverID uuid.UUID, rustdeskID, devUUID string, ip netip.Addr) (db.GetClientDeviceRow, bool, bool, error) {
	d, found, enrolled, err := s.findOrEnroll(ctx, q, serverID, rustdeskID, devUUID, ip)
	if err != nil || !found {
		return d, false, false, err
	}
	if d.State != StatePending && d.State != StateApproved {
		return d, false, false, nil
	}
	if d.UUID != devUUID {
		return d, false, false, s.flagMismatch(ctx, q, d.ID, devUUID, ip)
	}
	return d, true, enrolled, nil
}

// Lookup returns the ID of the device rustdeskID on serverID, with ok true
// only when it is approved and pinned to devUUID. Unlike the heartbeat it
// never enrolls, flags a uuid mismatch or writes anything, so other client
// calls (such as audit/conn) cannot create devices or alerts.
func Lookup(ctx context.Context, q *db.Queries, serverID uuid.UUID, rustdeskID, devUUID string) (uuid.UUID, bool, error) {
	d, err := q.GetClientDevice(ctx, db.GetClientDeviceParams{ServerID: serverID, RustdeskID: rustdeskID})
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("devices: look up %q: %w", rustdeskID, err)
	}
	if d.State != StateApproved || d.UUID != devUUID {
		return uuid.Nil, false, nil
	}
	return d.ID, true, nil
}

// findOrEnroll returns the device with rustdeskID, enrolling it as pending
// when it is unknown. found is false when the pending cap stopped enrollment.
func (s *Service) findOrEnroll(ctx context.Context, q *db.Queries, serverID uuid.UUID, rustdeskID, devUUID string, ip netip.Addr) (db.GetClientDeviceRow, bool, bool, error) {
	key := db.GetClientDeviceParams{ServerID: serverID, RustdeskID: rustdeskID}
	d, err := q.GetClientDevice(ctx, key)
	if err == nil {
		return d, true, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return d, false, false, fmt.Errorf("devices: look up %q: %w", rustdeskID, err)
	}
	if err := q.LockDeviceEnrollment(ctx, serverID); err != nil {
		return d, false, false, fmt.Errorf("devices: lock enrollment: %w", err)
	}
	// Another first heartbeat may have enrolled this ID while we waited.
	d, err = q.GetClientDevice(ctx, key)
	if err == nil {
		return d, true, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return d, false, false, fmt.Errorf("devices: look up %q after enrollment lock: %w", rustdeskID, err)
	}

	pending, err := q.CountPendingDevices(ctx, serverID)
	if err != nil {
		return d, false, false, fmt.Errorf("devices: count pending: %w", err)
	}
	if pending >= int64(s.MaxPending) {
		return d, false, false, s.recordDrop(ctx, q, serverID, rustdeskID, ip)
	}

	id, err := q.EnrollDevice(ctx, db.EnrollDeviceParams{ServerID: serverID, RustdeskID: rustdeskID, UUID: devUUID})
	switch {
	case err == nil:
		if err := audit.Record(ctx, q, audit.Event{
			ActorIP: ip, Action: ActionEnrolled, TargetType: "device", TargetID: id.String(),
			Details: map[string]any{"rustdesk_id": rustdeskID},
		}); err != nil {
			return d, false, false, err
		}
		return db.GetClientDeviceRow{ID: id, UUID: devUUID, State: StatePending}, true, true, nil
	case errors.Is(err, pgx.ErrNoRows):
		// A concurrent request enrolled it first; its row is committed now.
		d, err = q.GetClientDevice(ctx, key)
		if err != nil {
			return d, false, false, fmt.Errorf("devices: look up %q after conflict: %w", rustdeskID, err)
		}
		return d, true, false, nil
	default:
		return d, false, false, fmt.Errorf("devices: enroll %q: %w", rustdeskID, err)
	}
}

// flagMismatch opens a uuid_mismatch alert on the device unless one is
// already open, and audits only a newly opened alert.
func (s *Service) flagMismatch(ctx context.Context, q *db.Queries, deviceID uuid.UUID, seenUUID string, ip netip.Addr) error {
	details, err := json.Marshal(map[string]string{"seen_uuid": seenUUID, "ip": ip.String()})
	if err != nil {
		return fmt.Errorf("devices: encode alert details: %w", err)
	}
	_, err = q.OpenUUIDMismatchAlert(ctx, db.OpenUUIDMismatchAlertParams{DeviceID: deviceID, Details: details})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // an alert is already open
	}
	if err != nil {
		return fmt.Errorf("devices: open uuid_mismatch alert: %w", err)
	}
	return audit.Record(ctx, q, audit.Event{
		ActorIP: ip, Action: ActionUUIDMismatch, TargetType: "device", TargetID: deviceID.String(),
		Details: map[string]any{"seen_uuid": seenUUID},
	})
}

// recordDrop audits an enrollment refused by the pending cap, at most once
// per dropAuditEvery. The throttle is in memory, so a restart resets it, and
// a failed write still uses up the slot.
func (s *Service) recordDrop(ctx context.Context, q *db.Queries, serverID uuid.UUID, rustdeskID string, ip netip.Addr) error {
	now := s.now()
	s.mu.Lock()
	if !s.lastDrop.IsZero() && now.Sub(s.lastDrop) < dropAuditEvery {
		s.mu.Unlock()
		return nil
	}
	s.lastDrop = now
	s.mu.Unlock()

	return audit.Record(ctx, q, audit.Event{
		ActorIP: ip, Action: ActionEnrollDropped, TargetType: "server", TargetID: serverID.String(),
		Details: map[string]any{"rustdesk_id": rustdeskID},
	})
}

func (s *Service) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// Audit actions written by the admin methods.
const (
	ActionApproved      = "device.approved"
	ActionRejected      = "device.rejected"
	ActionArchived      = "device.archived"
	ActionRestored      = "device.restored"
	ActionReopened      = "device.reopened"
	ActionDeleted       = "device.deleted"
	ActionUpdated       = "device.updated"
	ActionAlertResolved = "device.alert_resolved"
)

const (
	targetDevice = "device"
	// Field limits, in characters.
	maxAliasLen = 128
	maxNoteLen  = 4096
	// List page sizes.
	defaultLimit = 50
	maxLimit     = 200
)

// Errors of the admin methods.
var (
	ErrNotFound      = errors.New("devices: not found")
	ErrBadTransition = errors.New("devices: state change not allowed")
	ErrWindowOpen    = errors.New("devices: access window open")
	ErrInvalidCursor = errors.New("devices: invalid cursor")
	ErrCycle         = errors.New("devices: a group cannot move under itself or its descendants")
	ErrNotEmpty      = errors.New("devices: group still has child groups or devices")
	ErrNameTaken     = errors.New("devices: name already in use")
	errAlertNoUUID   = errors.New("devices: alert has no seen_uuid")
)

// allowedTransition holds the state moves an admin may make, as {from, to}.
var allowedTransition = map[[2]string]bool{
	{StatePending, StateApproved}:  true,
	{StatePending, StateRejected}:  true,
	{StateApproved, StateArchived}: true,
	{StateRejected, StateApproved}: true,
	{StateArchived, StateApproved}: true, // restore
	{StateRejected, StatePending}:  true, // reopen: the undo of a reject
	{StateApproved, StatePending}:  true, // reopen: the undo of an approve
}

// InputError is a request field that fails validation, such as an unknown
// group or tag. Its text is meant for the admin.
type InputError string

func (e InputError) Error() string { return string(e) }

// Actor is who performs an admin change, for the audit log.
type Actor struct {
	UserID uuid.UUID
	IP     netip.Addr
}

func (a Actor) event(action, targetType, targetID string, details map[string]any) audit.Event {
	id := a.UserID
	return audit.Event{
		ActorUserID: &id, ActorIP: a.IP, Action: action,
		TargetType: targetType, TargetID: targetID, Details: details,
	}
}

// Device is a device as the admin API sees it, with its tags (by name) and
// its unresolved alerts (oldest first).
type Device struct {
	ID            uuid.UUID
	ServerID      uuid.UUID
	RustdeskID    string
	UUID          string
	State         string
	Alias         string
	Hostname      string
	OS            string
	CPU           string
	Memory        string
	ClientVersion string
	Username      string
	Note          string
	GroupID       *uuid.UUID
	FirstSeenAt   time.Time
	LastSeenAt    time.Time
	ApprovedBy    *uuid.UUID
	ApprovedAt    *time.Time
	UpdatedAt     time.Time
	Tags          []Tag
	OpenAlerts    []Alert
}

// Alert is an unresolved device alert. For uuid_mismatch, SeenUUID is the
// uuid the client sent and IP the address it came from.
type Alert struct {
	ID             uuid.UUID
	Kind           string
	SeenUUID       string
	IP             string
	CreatedAt      time.Time
	WindowClosedAt *time.Time
	Groups         []GroupRef
}

type GroupRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

func deviceFromRow(r db.Device) Device {
	return Device{
		ID: r.ID, ServerID: r.ServerID, RustdeskID: r.RustdeskID, UUID: r.UUID, State: r.State,
		Alias: r.Alias, Hostname: r.Hostname, OS: r.OS, CPU: r.CPU, Memory: r.Memory,
		ClientVersion: r.ClientVersion, Username: r.Username, Note: r.Note, GroupID: r.GroupID,
		FirstSeenAt: r.FirstSeenAt.UTC(), LastSeenAt: r.LastSeenAt.UTC(),
		ApprovedBy: r.ApprovedBy, ApprovedAt: utcPtr(r.ApprovedAt), UpdatedAt: r.UpdatedAt.UTC(),
		Tags: []Tag{}, OpenAlerts: []Alert{},
	}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// Filter narrows List. Zero values mean "no filter". OS matches a
// case-insensitive prefix of the device's OS; Q a case-insensitive substring
// of its rustdesk_id, alias, hostname or username. Online is applied after
// the page is read (it comes from the in-memory tracker), so a page can hold
// fewer than Limit devices while more pages follow. Limit defaults to 50 and
// is capped at 200; Cursor is the value List returned with the previous page.
type Filter struct {
	State          string
	ScopeUser      *uuid.UUID
	Online         *bool
	TagID, GroupID *uuid.UUID
	Ungrouped      bool
	Subgroups      bool
	OS, Q          string
	Limit          int
	Cursor         string
	Sort, Order    string
}

// List returns devices in the requested order, with tags, open alerts and
// the next cursor. The tracker supplies status ranking and the online filter;
// changes between pages can cause duplicates or gaps for status ordering.
func (s *Service) List(ctx context.Context, f Filter, online func(rustdeskID string) bool) ([]Device, string, error) {
	if f.Sort == "" {
		f.Sort = "rustdesk_id"
	}
	if f.Order == "" {
		f.Order = "asc"
	}
	if !slices.Contains([]string{"rustdesk_id", "name", "status", "state", "os", "group"}, f.Sort) {
		return nil, "", InputError("unknown sort")
	}
	if f.Order != "asc" && f.Order != "desc" {
		return nil, "", InputError("unknown order")
	}
	q := db.New(s.Pool)
	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)
	p := db.ListDevicesParams{
		GroupID: f.GroupID, TagID: f.TagID, ScopeUser: f.ScopeUser, Ungrouped: f.Ungrouped, Subgroups: f.Subgroups,
		RowLimit: int32(limit + 1), // one extra row tells whether another page exists
		SortKey:  f.Sort, Descending: f.Order == "desc", OnlineIds: []uuid.UUID{},
	}
	if f.State != "" {
		p.State = &f.State
	}
	if f.OS != "" {
		pat := likeEscape(f.OS) + "%"
		p.OSPattern = &pat
	}
	if f.Q != "" {
		pat := "%" + likeEscape(f.Q) + "%"
		p.QPattern = &pat
	}
	if f.Cursor != "" {
		id, err := decodeDeviceCursor(f.Cursor, f)
		if err != nil {
			return nil, "", err
		}
		p.AfterID = &id
	}

	if f.Sort == "status" {
		candidates, err := q.ListDeviceSortCandidates(ctx, f.ScopeUser)
		if err != nil {
			return nil, "", fmt.Errorf("devices: status candidates: %w", err)
		}
		for _, d := range candidates {
			if online != nil && online(d.RustdeskID) {
				p.OnlineIds = append(p.OnlineIds, d.ID)
			}
		}
	}
	var rows []db.Device
	var err error
	if f.Sort == "group" {
		rows, err = q.ListDevicesByGroup(ctx, db.ListDevicesByGroupParams(p))
	} else {
		rows, err = q.ListDevices(ctx, p)
	}
	if err != nil {
		return nil, "", fmt.Errorf("devices: list: %w", err)
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = encodeDeviceCursor(rows[limit-1].ID, f)
	}
	if f.Online != nil {
		kept := rows[:0]
		for _, r := range rows {
			if online(r.RustdeskID) == *f.Online {
				kept = append(kept, r)
			}
		}
		rows = kept
	}
	out, err := withDetails(ctx, q, rows)
	if err != nil {
		return nil, "", err
	}
	return out, next, nil
}

// Get returns one device, or ErrNotFound.
func (s *Service) Get(ctx context.Context, id uuid.UUID, scope ...*uuid.UUID) (Device, error) {
	q := db.New(s.Pool)
	var row db.Device
	var err error
	if len(scope) > 0 && scope[0] != nil {
		row, err = q.GetVisibleDevice(ctx, db.GetVisibleDeviceParams{ID: id, UserID: *scope[0]})
	} else {
		row, err = q.GetDevice(ctx, id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, fmt.Errorf("devices: get %s: %w", id, err)
	}
	out, err := withDetails(ctx, q, []db.Device{row})
	if err != nil {
		return Device{}, err
	}
	return out[0], nil
}

// withDetails converts rows and loads tags, open alerts and surviving conflict groups.
func withDetails(ctx context.Context, q *db.Queries, rows []db.Device) ([]Device, error) {
	out := make([]Device, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, len(rows))
	index := make(map[uuid.UUID]int, len(rows))
	for i, r := range rows {
		out[i] = deviceFromRow(r)
		ids[i] = r.ID
		index[r.ID] = i
	}
	tags, err := q.ListDeviceTags(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("devices: list tags: %w", err)
	}
	for _, t := range tags {
		d := &out[index[t.DeviceID]]
		d.Tags = append(d.Tags, Tag{ID: t.ID, Name: t.Name, Color: t.Color})
	}
	alerts, err := q.ListOpenAlerts(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("devices: list alerts: %w", err)
	}
	alertGroups := make(map[uuid.UUID][]GroupRef)
	if len(alerts) > 0 {
		refs, err := q.ListConflictAlertGroups(ctx, ids)
		if err != nil {
			return nil, fmt.Errorf("devices: alert groups: %w", err)
		}
		for _, g := range refs {
			alertGroups[g.AlertID] = append(alertGroups[g.AlertID], GroupRef{ID: g.ID, Name: g.Name})
		}
	}
	for _, a := range alerts {
		var det struct {
			SeenUUID string     `json:"seen_uuid"`
			IP       string     `json:"ip"`
			ClosedAt *time.Time `json:"closed_at"`
		}
		_ = json.Unmarshal(a.Details, &det) // details are ours; a bad value just shows empty
		d := &out[index[a.DeviceID]]
		groups := []GroupRef{}
		if a.Kind == "group_conflict" {
			groups = append(groups, alertGroups[a.ID]...)
		}
		d.OpenAlerts = append(d.OpenAlerts, Alert{
			ID: a.ID, Kind: a.Kind, SeenUUID: det.SeenUUID, IP: det.IP, CreatedAt: a.CreatedAt.UTC(), WindowClosedAt: det.ClosedAt,
			Groups: groups,
		})
	}
	return out, nil
}

// Patch is a change to a device; nil fields are left alone. GroupID set to a
// nil *uuid.UUID removes the device from its group. TagIDs replaces the
// device's tags (an empty slice removes them all).
type Patch struct {
	Alias, Note *string
	GroupID     **uuid.UUID
	TagIDs      *[]uuid.UUID
}

// Update applies p and audits device.updated with the changed fields'
// values before and after. An unknown group or tag gives an InputError, an
// unknown device ErrNotFound.
func (s *Service) Update(ctx context.Context, a Actor, id uuid.UUID, p Patch) (Device, error) {
	if p.Alias != nil && !printable(*p.Alias, maxAliasLen) {
		return Device{}, InputError(fmt.Sprintf("alias must be at most %d printable characters", maxAliasLen))
	}
	if p.Note != nil && !validText(*p.Note, maxNoteLen) {
		return Device{}, InputError(fmt.Sprintf("note must be at most %d characters of text", maxNoteLen))
	}
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		cur, err := lockDevice(ctx, q, id)
		if err != nil {
			return err
		}
		before, after := map[string]any{}, map[string]any{}
		next := db.UpdateDeviceDetailsParams{ID: id, Alias: cur.Alias, Note: cur.Note, GroupID: cur.GroupID}
		if p.Alias != nil {
			before["alias"], after["alias"] = cur.Alias, *p.Alias
			next.Alias = *p.Alias
		}
		if p.Note != nil {
			before["note"], after["note"] = cur.Note, *p.Note
			next.Note = *p.Note
		}
		if p.GroupID != nil {
			before["group_id"], after["group_id"] = uuidOrNil(cur.GroupID), uuidOrNil(*p.GroupID)
			next.GroupID = *p.GroupID
		}
		if _, err := q.UpdateDeviceDetails(ctx, next); err != nil {
			if isFKViolation(err) {
				return InputError("group_id does not name a group")
			}
			return fmt.Errorf("devices: update %s: %w", id, err)
		}
		if p.TagIDs != nil {
			old, err := q.ListDeviceTags(ctx, []uuid.UUID{id})
			if err != nil {
				return fmt.Errorf("devices: list tags: %w", err)
			}
			oldIDs := make([]uuid.UUID, len(old))
			for i, t := range old {
				oldIDs[i] = t.ID
			}
			newIDs := dedupe(*p.TagIDs)
			before["tag_ids"], after["tag_ids"] = sortedIDs(oldIDs), sortedIDs(newIDs)
			if err := q.DeleteDeviceTags(ctx, id); err != nil {
				return fmt.Errorf("devices: clear tags: %w", err)
			}
			if err := q.AddDeviceTags(ctx, db.AddDeviceTagsParams{DeviceID: id, TagIDs: newIDs}); err != nil {
				if isFKViolation(err) {
					return InputError("tag_ids names a tag that does not exist")
				}
				return fmt.Errorf("devices: add tags: %w", err)
			}
		}
		details := map[string]any{"before": before, "after": after}
		if p.GroupID != nil {
			n, err := q.ResolveGroupConflict(ctx, db.ResolveGroupConflictParams{DeviceID: id, ResolvedBy: &a.UserID})
			if err != nil {
				return fmt.Errorf("devices: resolve group conflict: %w", err)
			}
			if n > 0 {
				details["reason"] = "conflict_resolved"
			}
		}
		return audit.Record(ctx, q, a.event(ActionUpdated, targetDevice, id.String(), details))
	})
	if err != nil {
		return Device{}, err
	}
	return s.Get(ctx, id)
}

// Transition moves a device to state to. The move must be one of
// pending→approved, pending→rejected, approved→archived, rejected→approved,
// archived→approved (a restore), rejected→pending and approved→pending (a reopen), else
// ErrBadTransition; when from is
// given, the current state must also be one of from (so an API verb can
// accept only some of the moves to a state). Moving to approved sets
// approved_by and approved_at. The audit action is device.approved,
// device.rejected, device.archived, device.reopened or, for
// archived→approved, device.restored.
func (s *Service) Transition(ctx context.Context, a Actor, id uuid.UUID, to string, from ...string) error {
	var (
		rustdeskID string
		name       string
		action     string
	)
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		cur, err := lockDevice(ctx, q, id)
		if err != nil {
			return err
		}
		rustdeskID = cur.RustdeskID
		name = cur.Alias
		if name == "" {
			name = cur.Hostname
		}
		if !allowedTransition[[2]string{cur.State, to}] || (len(from) > 0 && !slices.Contains(from, cur.State)) {
			return ErrBadTransition
		}
		if cur.State == StateApproved {
			open, err := q.DeviceHasOpenAccessWindow(ctx, id)
			if err != nil {
				return fmt.Errorf("devices: check open access window of %s: %w", id, err)
			}
			if open {
				return ErrWindowOpen
			}
		}
		p := db.SetDeviceStateParams{ID: id, State: to, ApprovedBy: cur.ApprovedBy, ApprovedAt: cur.ApprovedAt}
		if to == StateApproved {
			now := s.now()
			p.ApprovedBy, p.ApprovedAt = &a.UserID, &now
		} else if to == StatePending {
			p.ApprovedBy, p.ApprovedAt = nil, nil
		}
		if _, err := q.SetDeviceState(ctx, p); err != nil {
			return fmt.Errorf("devices: set state of %s: %w", id, err)
		}
		action = map[string]string{
			StateApproved: ActionApproved, StateRejected: ActionRejected,
			StateArchived: ActionArchived, StatePending: ActionReopened,
		}[to]
		if cur.State == StateArchived {
			action = ActionRestored
		}
		details := map[string]any{"from": cur.State, "to": to}
		resolveConflict := action == ActionApproved
		if to == StateApproved && (cur.State == StatePending || cur.State == StateRejected) && cur.GroupID == nil && s.GroupPlacement != nil {
			ids, pattern, err := s.GroupPlacement(ctx, q, cur.Hostname)
			if err != nil {
				return err
			}
			resolveConflict = len(ids) <= 1
			switch len(ids) {
			case 0:
			case 1:
				// A group can disappear after the rule lookup. Lock it before
				// placement so deletion cannot turn approval into an FK error.
				if _, err := q.GetGroupForUpdate(ctx, ids[0]); errors.Is(err, pgx.ErrNoRows) {
					break
				} else if err != nil {
					return fmt.Errorf("devices: lock placement group: %w", err)
				}
				if err := q.SetRuleDeviceGroup(ctx, db.SetRuleDeviceGroupParams{ID: id, GroupID: &ids[0]}); err != nil {
					return fmt.Errorf("devices: place approved device: %w", err)
				}
				details["group_id"], details["pattern"] = ids[0].String(), pattern
			default:
				raw, err := json.Marshal(map[string]any{"group_ids": ids})
				if err != nil {
					return fmt.Errorf("devices: encode group conflict: %w", err)
				}
				if err := q.OpenGroupConflict(ctx, db.OpenGroupConflictParams{DeviceID: id, Details: raw}); err != nil {
					return fmt.Errorf("devices: group conflict: %w", err)
				}
			}
		}
		if resolveConflict {
			n, err := q.ResolveGroupConflict(ctx, db.ResolveGroupConflictParams{DeviceID: id, ResolvedBy: &a.UserID})
			if err != nil {
				return fmt.Errorf("devices: resolve approved device's group conflict: %w", err)
			}
			if n > 0 {
				details["conflict_resolved"] = true
			}
		}
		return audit.Record(ctx, q, a.event(action, targetDevice, id.String(), details))
	})
	if err != nil {
		return err
	}
	switch action {
	case ActionApproved:
		s.logger().Info("device approved", "rustdesk_id", rustdeskID, "name", name, "actor", a.UserID.String())
	case ActionRejected:
		s.logger().Info("device rejected", "rustdesk_id", rustdeskID, "name", name, "actor", a.UserID.String())
	}
	return nil
}

// Delete removes the device in any state, with its tags, alerts and session
// history. The audit entry keeps what identified it, since the row is gone.
// A client that still reports in enrolls again as a new pending device.
func (s *Service) Delete(ctx context.Context, a Actor, id uuid.UUID) error {
	var (
		rustdeskID string
		name       string
	)
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		cur, err := lockDevice(ctx, q, id)
		if err != nil {
			return err
		}
		rustdeskID = cur.RustdeskID
		name = cur.Alias
		if name == "" {
			name = cur.Hostname
		}
		open, err := q.DeviceHasOpenAccessWindow(ctx, id)
		if err != nil {
			return fmt.Errorf("devices: check open access window of %s: %w", id, err)
		}
		if open {
			return ErrWindowOpen
		}
		sessions, err := q.CountDeviceSessions(ctx, id)
		if err != nil {
			return fmt.Errorf("devices: count sessions of %s: %w", id, err)
		}
		if err := q.DeleteDevice(ctx, id); err != nil {
			return fmt.Errorf("devices: delete %s: %w", id, err)
		}
		return audit.Record(ctx, q, a.event(ActionDeleted, targetDevice, id.String(), map[string]any{
			"rustdesk_id": cur.RustdeskID, "hostname": cur.Hostname, "alias": cur.Alias,
			"state": cur.State, "sessions": sessions,
		}))
	})
	if err != nil {
		return err
	}
	s.logger().Info("device deleted", "rustdesk_id", rustdeskID, "name", name, "actor", a.UserID.String())
	return nil
}

// ResolveAlert resolves an open alert of the device. With acceptNewUUID the
// device is re-pinned to the uuid the alert saw, so that client is trusted
// from then on; otherwise the alert is dismissed and the pin kept. An
// unknown device, or an alert that is not an open alert of the device, gives
// ErrNotFound.
func (s *Service) ResolveAlert(ctx context.Context, a Actor, deviceID, alertID uuid.UUID, acceptNewUUID bool) error {
	return store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		dev, err := lockDevice(ctx, q, deviceID)
		if err != nil {
			return err
		}
		alert, err := q.GetOpenAlertForUpdate(ctx, db.GetOpenAlertForUpdateParams{ID: alertID, DeviceID: deviceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("devices: get alert %s: %w", alertID, err)
		}
		details := map[string]any{"alert_id": alertID.String(), "kind": alert.Kind, "action": "dismiss"}
		if acceptNewUUID {
			if alert.Kind == "group_conflict" {
				return InputError("action: group_conflict supports only dismiss")
			}
			var det struct {
				SeenUUID string `json:"seen_uuid"`
			}
			if err := json.Unmarshal(alert.Details, &det); err != nil || det.SeenUUID == "" {
				return errAlertNoUUID
			}
			if err := q.SetDeviceUUID(ctx, db.SetDeviceUUIDParams{ID: deviceID, UUID: det.SeenUUID}); err != nil {
				return fmt.Errorf("devices: re-pin %s: %w", deviceID, err)
			}
			details["action"], details["old_uuid"], details["new_uuid"] = "accept_new_uuid", dev.UUID, det.SeenUUID
		}
		now := s.now()
		if err := q.ResolveAlert(ctx, db.ResolveAlertParams{ID: alertID, ResolvedAt: &now, ResolvedBy: &a.UserID}); err != nil {
			return fmt.Errorf("devices: resolve alert %s: %w", alertID, err)
		}
		return audit.Record(ctx, q, a.event(ActionAlertResolved, targetDevice, deviceID.String(), details))
	})
}

func lockDevice(ctx context.Context, q *db.Queries, id uuid.UUID) (db.Device, error) {
	d, err := q.GetDeviceForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if err != nil {
		return d, fmt.Errorf("devices: lock %s: %w", id, err)
	}
	return d, nil
}

// The device list cursor is base64url of the last listed device's ID; the
// query finds its rustdesk_id, so the cursor stays short however long the
// client-chosen ID is.
func encodeCursor(id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString(id[:])
}

func decodeCursor(s string) (uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return uuid.Nil, ErrInvalidCursor
	}
	id, err := uuid.FromBytes(raw)
	if err != nil {
		return uuid.Nil, ErrInvalidCursor
	}
	return id, nil
}

// likeEscape escapes the LIKE metacharacters of s (with the default escape
// character, backslash), so that s matches literally.
func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// printable reports whether s is valid UTF-8 of at most max characters with
// no control characters.
func printable(s string, max int) bool {
	return validText(s, max) && strings.IndexFunc(s, unicode.IsControl) < 0
}

// validText reports whether s is valid UTF-8 of at most max characters with
// no NUL, which Postgres text cannot hold.
func validText(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsRune(s, 0)
}

func isFKViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23503" // foreign_key_violation
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" // unique_violation
}

func uuidOrNil(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return id.String()
}

func dedupe(ids []uuid.UUID) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(ids))
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// sortedIDs returns ids as sorted strings, for audit details.
func sortedIDs(ids []uuid.UUID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.String()
	}
	slices.Sort(out)
	return out
}
