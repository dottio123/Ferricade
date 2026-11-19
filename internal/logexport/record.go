package logexport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/dottio123/ferricade/internal/buildinfo"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type EventFields struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Category string `json:"category"`
	Action   string `json:"action"`
	Outcome  string `json:"outcome"`
}
type UserFields struct {
	ID    *uuid.UUID `json:"id,omitempty"`
	Name  string     `json:"name"`
	Roles []string   `json:"roles"`
}
type SourceFields struct {
	IP string `json:"ip"`
}
type TargetFields struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}
type DeviceFields struct {
	RustdeskID string `json:"rustdesk_id"`
}
type SessionFields struct {
	ID              string `json:"id"`
	Type            *int16 `json:"type"`
	PeerRustdeskID  string `json:"peer_rustdesk_id"`
	PeerName        string `json:"peer_name"`
	EndReason       string `json:"end_reason,omitempty"`
	DurationSeconds *int64 `json:"duration_seconds,omitempty"`
}
type FerricadeFields struct {
	Target  *TargetFields   `json:"target,omitempty"`
	Device  *DeviceFields   `json:"device,omitempty"`
	Details json.RawMessage `json:"details"`
	Session *SessionFields  `json:"session,omitempty"`
}
type ObserverFields struct {
	Product  string `json:"product"`
	Version  string `json:"version"`
	Hostname string `json:"hostname"`
}
type Record struct {
	Timestamp string          `json:"@timestamp"`
	Event     EventFields     `json:"event"`
	Message   string          `json:"message"`
	User      UserFields      `json:"user"`
	Source    *SourceFields   `json:"source,omitempty"`
	Ferricade FerricadeFields `json:"ferricade"`
	Observer  ObserverFields  `json:"observer"`
}

func observer(host string) ObserverFields {
	return ObserverFields{Product: "ferricade", Version: buildinfo.Get(), Hostname: host}
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func nonlocal(ip netip.Addr) string {
	if !ip.IsValid() || ip.IsLoopback() {
		return ""
	}
	return ip.String()
}
func stringValue(details map[string]any, names ...string) string {
	for _, n := range names {
		if v, ok := details[n].(string); ok && v != "" {
			return v
		}
	}
	return ""
}
func deviceName(alias, hostname, rustdeskID string) string {
	if alias != "" {
		return alias
	}
	if hostname != "" {
		return hostname
	}
	return rustdeskID
}

func Build(ctx context.Context, q *db.Queries, row db.LogExportOutbox, host string) (Record, error) {
	if row.Source == "session" {
		s, err := q.GetLogExportSession(ctx, row.RefID)
		if err != nil {
			return Record{}, fmt.Errorf("session %s: %w", row.RefID, err)
		}
		if row.Phase == nil {
			return Record{}, errors.New("session outbox phase is missing")
		}
		return sessionRecord(s, *row.Phase, host), nil
	}
	a, err := q.GetLogExportAudit(ctx, row.RefID)
	if err != nil {
		return Record{}, fmt.Errorf("audit %s: %w", row.RefID, err)
	}
	targetName := ""
	deviceID := ""
	if id, e := uuid.Parse(a.TargetID); e == nil {
		switch a.TargetType {
		case "device":
			d, e := q.GetLogExportDevice(ctx, id)
			if e == nil {
				targetName, deviceID = deviceName(d.Alias, d.Hostname, d.RustdeskID), d.RustdeskID
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return Record{}, e
			}
		case "group":
			targetName, err = q.GetLogExportGroup(ctx, id)
		case "tag":
			targetName, err = q.GetLogExportTag(ctx, id)
		case "policy":
			targetName, err = q.GetLogExportPolicy(ctx, id)
		case "user":
			targetName, err = q.GetLogExportUser(ctx, id)
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Record{}, err
		}
	}
	return buildAuditRecord(a, host, targetName, deviceID)
}

func buildAuditRecord(a db.GetLogExportAuditRow, host, targetName, deviceID string) (Record, error) {
	var details map[string]any
	if err := json.Unmarshal(a.Details, &details); err != nil {
		return Record{}, fmt.Errorf("audit details: %w", err)
	}
	if details == nil {
		details = map[string]any{}
	}
	user := UserFields{Name: "ferricade", Roles: []string{"system"}}
	actorName, actorRole := "", ""
	if a.ActorUserID != nil {
		user.ID = a.ActorUserID
		user.Name, _ = a.ActorName.(string)
		if user.Name == "" {
			user.Name = "unknown user"
		}
		if a.ActorRole != nil {
			user.Roles = []string{*a.ActorRole}
			actorRole = *a.ActorRole
		} else {
			user.Roles = []string{"unknown"}
		}
		actorName = user.Name
	}
	ip := nonlocal(a.ActorIP)
	if targetName == "" {
		targetName = stringValue(details, "alias", "hostname", "name", "username", "rustdesk_id")
	}
	if deviceID == "" && a.TargetType == "device" {
		deviceID = stringValue(details, "rustdesk_id")
	}
	target := &TargetFields{Type: a.TargetType, ID: a.TargetID, Name: targetName}
	if a.TargetType == "" && a.TargetID == "" {
		target = nil
	}
	outcome := "success"
	switch a.Action {
	case "auth.login_failed", "device.enroll_dropped", "device.uuid_mismatch", "device.id_blocked", "device.id_blocked_repeated", "device.id_blocked_overflow", "device.login_locked_out", "device.login_locked_out_repeated":
		outcome = "failure"
	}
	rec := Record{Timestamp: stamp(a.At), Event: EventFields{ID: a.ID.String(), Kind: "event", Category: Category(a.Action), Action: a.Action, Outcome: outcome},
		User: user, Ferricade: FerricadeFields{Target: target, Details: json.RawMessage(a.Details)}, Observer: observer(host)}
	if ip != "" {
		rec.Source = &SourceFields{IP: ip}
	}
	if deviceID != "" && a.TargetType == "device" {
		rec.Ferricade.Device = &DeviceFields{RustdeskID: deviceID}
	}
	rec.Message = Sentence(a.Action, AuditView{Action: a.Action, ActorName: actorName, ActorRole: actorRole, System: a.ActorUserID == nil, TargetName: targetName, RustdeskID: deviceID, IP: ip, Details: details})
	return rec, nil
}

// BuildBatch builds an outbox batch with one audit query and one session query.
func BuildBatch(ctx context.Context, q *db.Queries, rows []db.LogExportOutbox, host string) (map[int64]Record, map[int64]error, error) {
	auditIDs, sessionIDs := make([]uuid.UUID, 0, len(rows)), make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		if row.Source == "session" {
			sessionIDs = append(sessionIDs, row.RefID)
		} else {
			auditIDs = append(auditIDs, row.RefID)
		}
	}
	audits := make(map[uuid.UUID]db.GetLogExportAuditsRow, len(auditIDs))
	if len(auditIDs) > 0 {
		items, err := q.GetLogExportAudits(ctx, auditIDs)
		if err != nil {
			return nil, nil, fmt.Errorf("batch load audit export rows: %w", err)
		}
		for _, item := range items {
			audits[item.ID] = item
		}
	}
	sessions := make(map[uuid.UUID]db.GetLogExportSessionsRow, len(sessionIDs))
	if len(sessionIDs) > 0 {
		items, err := q.GetLogExportSessions(ctx, sessionIDs)
		if err != nil {
			return nil, nil, fmt.Errorf("batch load session export rows: %w", err)
		}
		for _, item := range items {
			sessions[item.ID] = item
		}
	}
	records, rowErrors := make(map[int64]Record, len(rows)), make(map[int64]error)
	for _, row := range rows {
		if row.Source == "session" {
			s, ok := sessions[row.RefID]
			if !ok {
				rowErrors[row.ID] = fmt.Errorf("session %s: %w", row.RefID, pgx.ErrNoRows)
				continue
			}
			if row.Phase == nil {
				rowErrors[row.ID] = errors.New("session outbox phase is missing")
				continue
			}
			records[row.ID] = sessionRecord(db.GetLogExportSessionRow{
				ID: s.ID, DeviceID: s.DeviceID, Type: s.Type, PeerRustdeskID: s.PeerRustdeskID, PeerName: s.PeerName,
				ClientIP: s.ClientIP, StartedAt: s.StartedAt, EndedAt: s.EndedAt, EndReason: s.EndReason,
				Alias: s.Alias, Hostname: s.Hostname, RustdeskID: s.RustdeskID,
			}, *row.Phase, host)
			continue
		}
		a, ok := audits[row.RefID]
		if !ok {
			rowErrors[row.ID] = fmt.Errorf("audit %s: %w", row.RefID, pgx.ErrNoRows)
			continue
		}
		targetName, deviceID := "", ""
		switch a.TargetType {
		case "device":
			targetName = deviceName(a.TargetDeviceAlias, a.TargetDeviceHostname, a.TargetDeviceRustdeskID)
			deviceID = a.TargetDeviceRustdeskID
		case "group":
			targetName = a.TargetGroupName
		case "tag":
			targetName = a.TargetTagName
		case "user":
			targetName, _ = a.TargetUserName.(string)
		case "policy":
			targetName = a.TargetPolicyName
		}
		rec, err := buildAuditRecord(db.GetLogExportAuditRow{
			ID: a.ID, At: a.At, ActorUserID: a.ActorUserID, ActorIP: a.ActorIP, Action: a.Action,
			TargetType: a.TargetType, TargetID: a.TargetID, Details: a.Details, ActorName: a.ActorName, ActorRole: a.ActorRole,
		}, host, targetName, deviceID)
		if err != nil {
			rowErrors[row.ID] = err
			continue
		}
		records[row.ID] = rec
	}
	return records, rowErrors, nil
}

func sessionRecord(s db.GetLogExportSessionRow, phase, host string) Record {
	name := deviceName(s.Alias, s.Hostname, s.RustdeskID)
	peer := s.PeerName
	if peer == "" {
		peer = s.PeerRustdeskID
	}
	from := peer
	if s.PeerRustdeskID != "" {
		from += " (" + s.PeerRustdeskID + ")"
	}
	to := name
	if s.RustdeskID != "" {
		to += " (" + s.RustdeskID + ")"
	}
	when := s.StartedAt
	message := "Remote session started: " + from + " to " + to
	fields := &SessionFields{ID: s.ID.String(), Type: s.Type, PeerRustdeskID: s.PeerRustdeskID, PeerName: s.PeerName}
	if phase == "end" {
		if s.EndedAt != nil {
			when = *s.EndedAt
			duration := int64(s.EndedAt.Sub(s.StartedAt).Seconds())
			if duration < 0 {
				duration = 0
			}
			fields.DurationSeconds = &duration
			if duration < 60 {
				message += fmt.Sprintf(" after %d s", duration)
			} else {
				message += fmt.Sprintf(" after %d min", duration/60)
			}
		}
		if s.EndReason != nil {
			fields.EndReason = *s.EndReason
			message += " (" + *s.EndReason + ")"
		}
		message = strings.Replace(message, "Remote session started:", "Remote session ended:", 1)
	}
	rec := Record{Timestamp: stamp(when), Event: EventFields{ID: s.ID.String() + ":" + phase, Kind: "event", Category: "session", Action: "session." + map[string]string{"start": "started", "end": "ended"}[phase], Outcome: "success"}, Message: message,
		User: UserFields{Name: "ferricade", Roles: []string{"system"}}, Ferricade: FerricadeFields{Target: &TargetFields{Type: "device", ID: s.DeviceID.String(), Name: name}, Device: &DeviceFields{RustdeskID: s.RustdeskID}, Details: json.RawMessage(`{}`), Session: fields}, Observer: observer(host)}
	if s.ClientIP != nil {
		if ip := nonlocal(*s.ClientIP); ip != "" {
			rec.Source = &SourceFields{IP: ip}
			if phase == "start" {
				rec.Message += " from " + ip
			}
		}
	}
	return rec
}
