package logexport

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrSyslogUnavailable = errors.New("syslog output not available yet")

type InputError string

func (e InputError) Error() string { return string(e) }

type FileSettings struct {
	Enabled bool `json:"enabled"`
}
type SyslogSettings struct {
	Enabled  bool   `json:"enabled"`
	Host     string `json:"host"`
	Port     int32  `json:"port"`
	TLS      bool   `json:"tls"`
	CAPEM    string `json:"ca_pem"`
	Facility string `json:"facility"`
	Format   string `json:"format"`
}
type Settings struct {
	File      FileSettings   `json:"file"`
	Syslog    SyslogSettings `json:"syslog"`
	UpdatedAt time.Time      `json:"-"`
	UpdatedBy *uuid.UUID     `json:"-"`
}
type OutputStatus struct {
	LastDeliveredAt *time.Time `json:"last_delivered_at"`
	Pending         int64      `json:"pending"`
	LastError       *string    `json:"last_error"`
	LastErrorAt     *time.Time `json:"last_error_at"`
}
type retryState struct {
	failures int
	next     time.Time
}
type Service struct {
	Pool        *pgxpool.Pool
	Now         func() time.Time
	Log         *slog.Logger
	Dir         string
	Host        string
	mu          sync.Mutex
	statuses    map[string]OutputStatus
	retry       map[string]retryState
	lastCleanup time.Time
	file        Output
	syslog      *SyslogOutput
	unknown     sync.Map
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func (s *Service) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}
func (s *Service) fileOutput() Output {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		dir := s.Dir
		if dir == "" {
			dir = "/var/log/ferricade"
		}
		s.file = &FileOutput{Dir: dir}
	}
	return s.file
}
func (s *Service) syslogOutput(settings SyslogSettings) *SyslogOutput {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.syslog != nil && (s.syslog.Host != settings.Host || s.syslog.Port != int(settings.Port) || s.syslog.TLS != settings.TLS || s.syslog.CAPEM != settings.CAPEM || s.syslog.Facility != settings.Facility || s.syslog.Format != settings.Format || s.syslog.Hostname != s.Host) {
		_ = s.syslog.Close()
		s.syslog = nil
	}
	if s.syslog == nil {
		s.syslog = &SyslogOutput{Host: settings.Host, Port: int(settings.Port), TLS: settings.TLS, CAPEM: settings.CAPEM, Facility: settings.Facility, Format: settings.Format, Hostname: s.Host}
	}
	return s.syslog
}
func (s *Service) closeSyslog() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.syslog != nil {
		_ = s.syslog.Close()
		s.syslog = nil
	}
}
func (s *Service) Settings(ctx context.Context) (Settings, error) {
	row, err := db.New(s.Pool).GetLogExportSettings(ctx)
	if err != nil {
		return Settings{}, fmt.Errorf("get log export settings: %w", err)
	}
	return fromRow(row), nil
}
func fromRow(r db.LogExportSetting) Settings {
	return Settings{File: FileSettings{r.FileEnabled}, Syslog: SyslogSettings{r.SyslogEnabled, r.SyslogHost, r.SyslogPort, r.SyslogTls, r.SyslogCaPem, r.SyslogFacility, r.SyslogFormat}, UpdatedAt: r.UpdatedAt, UpdatedBy: r.UpdatedBy}
}

var facilities = map[string]bool{"kern": true, "user": true, "mail": true, "daemon": true, "auth": true, "syslog": true, "lpr": true, "news": true, "uucp": true, "cron": true, "authpriv": true, "ftp": true, "local0": true, "local1": true, "local2": true, "local3": true, "local4": true, "local5": true, "local6": true, "local7": true}

func Validate(s Settings) error {
	h := s.Syslog.Host
	if len(h) > 253 || strings.ContainsAny(h, " \t\r\n/\\") || strings.Contains(h, "://") || (h != "" && net.ParseIP(h) == nil && strings.Contains(h, ":")) {
		return InputError("syslog.host: must be a host name or IP address")
	}
	if s.Syslog.Enabled && h == "" {
		return InputError("syslog.host: required when enabled")
	}
	if s.Syslog.Port < 1 || s.Syslog.Port > 65535 {
		return InputError("syslog.port: must be 1 to 65535")
	}
	if len(s.Syslog.CAPEM) > 32768 {
		return InputError("syslog.ca_pem: too long")
	}
	if s.Syslog.CAPEM != "" {
		rest := []byte(s.Syslog.CAPEM)
		valid := false
		for len(rest) > 0 {
			block, next := pem.Decode(rest)
			if block == nil {
				break
			}
			if block.Type == "CERTIFICATE" {
				if _, err := x509.ParseCertificate(block.Bytes); err == nil {
					valid = true
				}
			}
			rest = next
		}
		if !valid {
			return InputError("syslog.ca_pem: no parseable certificate")
		}
	}
	if !facilities[s.Syslog.Facility] {
		return InputError("syslog.facility: invalid value")
	}
	if s.Syslog.Format != "json" && s.Syslog.Format != "text" {
		return InputError("syslog.format: invalid value")
	}
	return nil
}
func changedFields(before, after Settings) []string {
	var fields []string
	if before.File.Enabled != after.File.Enabled {
		fields = append(fields, "file.enabled")
	}
	if before.Syslog.Enabled != after.Syslog.Enabled {
		fields = append(fields, "syslog.enabled")
	}
	if before.Syslog.Host != after.Syslog.Host {
		fields = append(fields, "syslog.host")
	}
	if before.Syslog.Port != after.Syslog.Port {
		fields = append(fields, "syslog.port")
	}
	if before.Syslog.TLS != after.Syslog.TLS {
		fields = append(fields, "syslog.tls")
	}
	if before.Syslog.CAPEM != after.Syslog.CAPEM {
		fields = append(fields, "syslog.ca_pem")
	}
	if before.Syslog.Facility != after.Syslog.Facility {
		fields = append(fields, "syslog.facility")
	}
	if before.Syslog.Format != after.Syslog.Format {
		fields = append(fields, "syslog.format")
	}
	// The caller stores only field names, never the CA text.
	sort.Strings(fields)
	return fields
}
func (s *Service) Update(ctx context.Context, actor devices.Actor, next Settings) (Settings, error) {
	if err := Validate(next); err != nil {
		return Settings{}, err
	}
	var saved Settings
	var old Settings
	var fields []string
	var syslogChanged bool
	var watermark int64
	if err := s.Pool.QueryRow(ctx, `SELECT COALESCE(MAX(id), 0) FROM log_export_outbox`).Scan(&watermark); err != nil {
		return Settings{}, fmt.Errorf("get log export outbox watermark: %w", err)
	}
	err := store.Tx(ctx, s.Pool, func(q *db.Queries) error {
		oldRow, err := q.LockLogExportSettings(ctx)
		if err != nil {
			return err
		}
		old = fromRow(oldRow)
		fields = changedFields(old, next)
		for _, field := range fields {
			if strings.HasPrefix(field, "syslog.") {
				syslogChanged = true
			}
		}
		if len(fields) == 0 {
			saved = old
			return nil
		}
		now := s.now()
		if !old.File.Enabled && next.File.Enabled {
			if err := q.StartFileLogExportNow(ctx, &now); err != nil {
				return err
			}
		}
		if !old.Syslog.Enabled && next.Syslog.Enabled {
			if err := q.StartSyslogLogExportNow(ctx, &now); err != nil {
				return err
			}
		}
		row, err := q.PutLogExportSettings(ctx, db.PutLogExportSettingsParams{FileEnabled: next.File.Enabled, SyslogEnabled: next.Syslog.Enabled, SyslogHost: next.Syslog.Host, SyslogPort: next.Syslog.Port, SyslogTls: next.Syslog.TLS, SyslogCaPem: next.Syslog.CAPEM, SyslogFacility: next.Syslog.Facility, SyslogFormat: next.Syslog.Format, UpdatedAt: now, UpdatedBy: &actor.UserID})
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP, Action: "settings.log_export_updated", TargetType: "settings", TargetID: "log-export", Details: map[string]any{"fields": fields}}); err != nil {
			return err
		}
		saved = fromRow(row)
		return nil
	})
	if err != nil {
		return Settings{}, fmt.Errorf("update log export settings: %w", err)
	}
	if len(fields) > 0 {
		fileLost := old.File.Enabled && !saved.File.Enabled
		syslogLost := old.Syslog.Enabled && (!saved.Syslog.Enabled || old.Syslog.Host != saved.Syslog.Host || old.Syslog.Port != saved.Syslog.Port || old.Syslog.TLS != saved.Syslog.TLS || old.Syslog.CAPEM != saved.Syslog.CAPEM || old.Syslog.Facility != saved.Syslog.Facility || old.Syslog.Format != saved.Syslog.Format)
		if fileLost || syslogLost {
			s.deliverTransitionAudit(ctx, actor.UserID, fields, watermark, old, fileLost, syslogLost)
		}
	}
	if syslogChanged {
		s.closeSyslog()
	}
	return saved, nil
}

func (s *Service) deliverTransitionAudit(ctx context.Context, actorID uuid.UUID, fields []string, watermark int64, old Settings, fileLost, syslogLost bool) {
	base := context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(base, 10*time.Second)
	defer cancel()
	details, _ := json.Marshal(map[string]any{"fields": fields})
	var id uuid.UUID
	err := s.Pool.QueryRow(ctx, `SELECT o.ref_id FROM log_export_outbox o
		JOIN audit_events a ON a.id = o.ref_id
		WHERE o.id > $1 AND o.source = 'audit' AND a.action = 'settings.log_export_updated'
		AND a.actor_user_id = $2 AND a.details = $3::jsonb ORDER BY o.id LIMIT 1`, watermark, actorID, details).Scan(&id)
	if err != nil {
		s.logger().Warn("log export transition audit lookup failed", "err", err)
		return
	}
	rec, err := Build(ctx, db.New(s.Pool), db.LogExportOutbox{Source: "audit", RefID: id}, s.Host)
	if err != nil {
		s.logger().Warn("log export transition audit build failed", "err", err)
		return
	}
	if fileLost {
		fileCtx, fileCancel := context.WithTimeout(base, 10*time.Second)
		if err := s.fileOutput().Deliver(fileCtx, []Record{rec}); err != nil {
			s.logger().Warn("log export transition delivery failed", "output", "file", "err", err)
		}
		fileCancel()
	}
	if syslogLost {
		syslogCtx, syslogCancel := context.WithTimeout(base, 10*time.Second)
		out := &SyslogOutput{Host: old.Syslog.Host, Port: int(old.Syslog.Port), TLS: old.Syslog.TLS, CAPEM: old.Syslog.CAPEM, Facility: old.Syslog.Facility, Format: old.Syslog.Format, Hostname: s.Host}
		if err := out.Deliver(syslogCtx, []Record{rec}); err != nil {
			s.logger().Warn("log export transition delivery failed", "output", "syslog", "err", err)
		}
		_ = out.Close()
		syslogCancel()
	}
}
func (s *Service) Status(ctx context.Context) (map[string]OutputStatus, error) {
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	out := map[string]OutputStatus{"file": s.statuses["file"], "syslog": s.statuses["syslog"]}
	s.mu.Unlock()
	q := db.New(s.Pool)
	if settings.File.Enabled {
		n, err := q.CountFileLogExportPending(ctx)
		if err != nil {
			return nil, err
		}
		st := out["file"]
		st.Pending = n
		out["file"] = st
	}
	if settings.Syslog.Enabled {
		n, err := q.CountSyslogLogExportPending(ctx)
		if err != nil {
			return nil, err
		}
		st := out["syslog"]
		st.Pending = n
		out["syslog"] = st
	}
	return out, nil
}
func (s *Service) Test(ctx context.Context, output string) error {
	if output != "file" && output != "syslog" {
		return InputError("output: must be file or syslog")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r := Record{Timestamp: stamp(s.now()), Event: EventFields{ID: uuid.NewString(), Kind: "event", Category: "configuration", Action: "ferricade.test", Outcome: "success"}, Message: "ferricade log export test event", User: UserFields{Name: "ferricade", Roles: []string{"system"}}, Ferricade: FerricadeFields{Details: []byte(`{}`)}, Observer: observer(s.Host)}
	if output == "file" {
		return s.fileOutput().Deliver(ctx, []Record{r})
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return err
	}
	out := &SyslogOutput{Host: settings.Syslog.Host, Port: int(settings.Syslog.Port), TLS: settings.Syslog.TLS, CAPEM: settings.Syslog.CAPEM, Facility: settings.Syslog.Facility, Format: settings.Syslog.Format, Hostname: s.Host}
	defer out.Close()
	return out.Deliver(ctx, []Record{r})
}
