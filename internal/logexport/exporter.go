package logexport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/jackc/pgx/v5"
)

type Output interface {
	Name() string
	Deliver(ctx context.Context, recs []Record) error
}

func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	defer s.closeSyslog()
	for {
		if err := s.tick(ctx); err != nil && ctx.Err() == nil {
			s.logger().Error("log export tick", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) tick(ctx context.Context) error {
	settings, err := s.Settings(ctx)
	if err != nil {
		return err
	}
	now := s.now()
	if s.lastCleanup.IsZero() || now.Sub(s.lastCleanup) >= time.Minute {
		if err := s.cleanup(ctx, settings.File.Enabled, settings.Syslog.Enabled); err != nil {
			return err
		}
		s.lastCleanup = now
	}
	if settings.File.Enabled {
		if err := s.deliver(ctx, "file", s.fileOutput()); err != nil && ctx.Err() == nil {
			s.failure("file", err)
		}
	}
	if settings.Syslog.Enabled {
		if err := s.deliver(ctx, "syslog", s.syslogOutput(settings.Syslog)); err != nil && ctx.Err() == nil {
			s.failure("syslog", err)
		}
	} else {
		s.closeSyslog()
	}
	return ctx.Err()
}

func (s *Service) cleanup(ctx context.Context, file, syslog bool) error {
	return db.New(s.Pool).CleanupLogExport(ctx, db.CleanupLogExportParams{CreatedAt: s.now().Add(-7 * 24 * time.Hour), Column2: file, Column3: syslog})
}

func (s *Service) deliver(ctx context.Context, name string, out Output) error {
	if s.retry != nil {
		if state, ok := s.retry[name]; ok && s.now().Before(state.next) {
			return nil
		}
	}
	q := db.New(s.Pool)
	for {
		var rows []db.LogExportOutbox
		var err error
		switch name {
		case "file":
			rows, err = q.PendingFileLogExport(ctx)
		case "syslog":
			rows, err = q.PendingSyslogLogExport(ctx)
		}
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		built, rowErrors, err := BuildBatch(ctx, q, rows, s.Host)
		if err != nil {
			return err
		}
		recs := make([]Record, 0, len(rows))
		ids := make([]int64, 0, len(rows))
		missing := make([]int64, 0)
		var buildErr error
		for _, row := range rows {
			recErr := rowErrors[row.ID]
			if recErr != nil {
				if errors.Is(recErr, pgx.ErrNoRows) {
					s.logger().Warn("log export reference missing", "outbox_id", row.ID)
					missing = append(missing, row.ID)
				} else {
					s.logger().Error("log export record invalid", "outbox_id", row.ID, "err", recErr)
					if buildErr == nil {
						buildErr = fmt.Errorf("log export row %d: %w", row.ID, recErr)
					}
				}
				continue
			}
			rec, ok := built[row.ID]
			if !ok {
				recErr = errors.New("batch builder returned no record")
				s.logger().Error("log export record invalid", "outbox_id", row.ID, "err", recErr)
				if buildErr == nil {
					buildErr = fmt.Errorf("log export row %d: %w", row.ID, recErr)
				}
				continue
			}
			if !Known(rec.Event.Action) && row.Source == "audit" {
				if _, loaded := s.unknown.LoadOrStore(rec.Event.Action, true); !loaded {
					s.logger().Warn("unknown log export action", slog.String("action", rec.Event.Action))
				}
			}
			recs = append(recs, rec)
			ids = append(ids, row.ID)
		}
		if len(missing) > 0 {
			if err := s.markDone(ctx, q, name, missing); err != nil {
				return err
			}
		}
		if len(recs) > 0 {
			start := time.Now()
			if err := out.Deliver(ctx, recs); err != nil {
				if errors.Is(err, ErrSyslogReplaced) {
					return nil
				}
				return err
			}
			if err := s.markDone(ctx, q, name, ids); err != nil {
				return err
			}
			s.success(name)
			s.logger().Debug("log export delivered", "output", name, "count", len(recs), "duration_ms", time.Since(start).Milliseconds())
		}
		if buildErr != nil {
			return buildErr
		}
		if len(rows) < 500 {
			return nil
		}
	}
}
func (s *Service) markDone(ctx context.Context, q *db.Queries, name string, ids []int64) error {
	now := s.now()
	switch name {
	case "file":
		return q.MarkFileLogExportDone(ctx, db.MarkFileLogExportDoneParams{Column1: ids, FileDoneAt: &now})
	case "syslog":
		return q.MarkSyslogLogExportDone(ctx, db.MarkSyslogLogExportDoneParams{Column1: ids, SyslogDoneAt: &now})
	}
	return nil
}
func (s *Service) success(name string) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.statuses == nil {
		s.statuses = map[string]OutputStatus{}
	}
	st := s.statuses[name]
	st.LastDeliveredAt = &now
	st.LastError = nil
	st.LastErrorAt = nil
	s.statuses[name] = st
	if s.retry != nil {
		delete(s.retry, name)
	}
}
func (s *Service) failure(name string, err error) {
	now := s.now()
	message := TruncateError(err.Error())
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.statuses == nil {
		s.statuses = map[string]OutputStatus{}
	}
	if s.retry == nil {
		s.retry = map[string]retryState{}
	}
	st := s.statuses[name]
	st.LastError = &message
	st.LastErrorAt = &now
	s.statuses[name] = st
	r := s.retry[name]
	r.failures++
	delay := time.Duration(2) * time.Second
	for i := 1; i < r.failures && delay < 60*time.Second; i++ {
		delay *= 2
	}
	if delay > 60*time.Second {
		delay = 60 * time.Second
	}
	r.next = now.Add(delay)
	s.retry[name] = r
	s.logger().Warn("log export delivery failed", "output", name, "err", err)
}

func TruncateError(message string) string {
	if len(message) <= 1024 {
		return message
	}
	message = message[:1024]
	for !utf8.ValidString(message) {
		message = message[:len(message)-1]
	}
	return message
}
