package adminapi

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/stats"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// actionDashboardUpdated is audited by PUT /settings/dashboard.
const actionDashboardUpdated = "settings.dashboard_updated"

type historyPointJSON struct {
	At       time.Time `json:"at"`
	Approved int       `json:"approved"`
	Online   int       `json:"online"`
	Pending  int       `json:"pending"`
	Sessions int       `json:"sessions"`
}

type historyJSON struct {
	Range       string             `json:"range"`
	StepSeconds int                `json:"step_seconds"`
	Points      []historyPointJSON `json:"points"`
}

// statsHistory handles GET /stats/history?range=24h|7d|30d.
func (a *api) statsHistory(w http.ResponseWriter, r *http.Request) {
	res, err := stats.History(r.Context(), a.d.Pool, r.URL.Query().Get("range"), a.now())
	if errors.Is(err, stats.ErrInvalidRange) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "range must be 24h, 7d or 30d")
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := historyJSON{Range: res.Range, StepSeconds: res.StepSeconds, Points: make([]historyPointJSON, len(res.Points))}
	for i, p := range res.Points {
		out.Points[i] = historyPointJSON(p)
	}
	writeJSON(w, http.StatusOK, out)
}

type osCountJSON struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type versionCountJSON struct {
	Version  string `json:"version"`
	Count    int    `json:"count"`
	Outdated bool   `json:"outdated"`
}

type groupCountJSON struct {
	ID     *uuid.UUID `json:"id"`
	Name   string     `json:"name"`
	Online int        `json:"online"`
	Total  int        `json:"total"`
}

type attentionJSON struct {
	Kind       string    `json:"kind"`
	DeviceID   uuid.UUID `json:"device_id"`
	RustdeskID string    `json:"rustdesk_id"`
	Name       string    `json:"name"`
	Since      time.Time `json:"since"`
	Detail     string    `json:"detail"`
}

type summaryJSON struct {
	GeneratedAt time.Time `json:"generated_at"`
	Devices     struct {
		Approved int `json:"approved"`
		Pending  int `json:"pending"`
		Rejected int `json:"rejected"`
		Archived int `json:"archived"`
		Online   int `json:"online"`
	} `json:"devices"`
	Sessions struct {
		Active int `json:"active"`
	} `json:"sessions"`
	Alerts struct {
		Open int `json:"open"`
	} `json:"alerts"`
	OS        []osCountJSON      `json:"os"`
	Versions  []versionCountJSON `json:"versions"`
	Groups    []groupCountJSON   `json:"groups"`
	Attention []attentionJSON    `json:"attention"`
}

// statsSummary handles GET /stats/summary.
func (a *api) statsSummary(w http.ResponseWriter, r *http.Request) {
	var online func(string) bool // nil reports every device offline
	if a.d.Tracker != nil {
		online = a.d.Tracker.Online
	}
	res, err := stats.Summary(r.Context(), a.d.Pool, online, a.now().UTC(), scopeOf(userFrom(r.Context())))
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	out := summaryJSON{
		GeneratedAt: res.GeneratedAt,
		OS:          make([]osCountJSON, len(res.OS)),
		Versions:    make([]versionCountJSON, len(res.Versions)),
		Groups:      make([]groupCountJSON, len(res.Groups)),
		Attention:   make([]attentionJSON, len(res.Attention)),
	}
	out.Devices.Approved, out.Devices.Pending = res.Devices.Approved, res.Devices.Pending
	out.Devices.Rejected, out.Devices.Archived, out.Devices.Online = res.Devices.Rejected, res.Devices.Archived, res.Devices.Online
	out.Sessions.Active = res.ActiveSessions
	out.Alerts.Open = res.OpenAlerts
	for i, v := range res.OS {
		out.OS[i] = osCountJSON(v)
	}
	for i, v := range res.Versions {
		out.Versions[i] = versionCountJSON(v)
	}
	for i, g := range res.Groups {
		out.Groups[i] = groupCountJSON(g)
	}
	for i, x := range res.Attention {
		out.Attention[i] = attentionJSON(x)
	}
	writeJSON(w, http.StatusOK, out)
}

type fleetMapDeviceJSON struct {
	ID      uuid.UUID `json:"id"`
	Name    string    `json:"name"`
	GroupID *string   `json:"group_id"`
	Status  string    `json:"status"`
}

type fleetMapJSON struct {
	GeneratedAt time.Time            `json:"generated_at"`
	Truncated   bool                 `json:"truncated"`
	Devices     []fleetMapDeviceJSON `json:"devices"`
}

const fleetMapLimit = 2000

// statsFleetMap handles GET /stats/fleet-map.
func (a *api) statsFleetMap(w http.ResponseWriter, r *http.Request) {
	var online func(string) bool
	if a.d.Tracker != nil {
		online = a.d.Tracker.Online
	}
	rows, err := db.New(a.d.Pool).FleetMapDevices(r.Context(), scopeOf(userFrom(r.Context())))
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	truncated := len(rows) > fleetMapLimit
	if truncated {
		rows = rows[:fleetMapLimit]
	}
	out := fleetMapJSON{GeneratedAt: a.now().UTC(), Truncated: truncated, Devices: make([]fleetMapDeviceJSON, len(rows))}
	for i, row := range rows {
		var groupID *string
		switch value := row.GroupID.(type) {
		case string:
			groupID = &value
		case []byte:
			group := string(value)
			groupID = &group
		}
		status := "offline"
		if online != nil && online(row.RustdeskID) {
			status = "online"
		}
		if row.HasAlert {
			status = "alert"
		}
		out.Devices[i] = fleetMapDeviceJSON{ID: row.ID, Name: row.Name, GroupID: groupID, Status: status}
	}
	writeJSON(w, http.StatusOK, out)
}

type thresholdsJSON struct {
	OfflineDays      int    `json:"offline_days"`
	PendingHours     int    `json:"pending_hours"`
	MinClientVersion string `json:"min_client_version"`
}

func toThresholdsJSON(t stats.Thresholds) thresholdsJSON { return thresholdsJSON(t) }

// getDashboardSettings handles GET /settings/dashboard.
func (a *api) getDashboardSettings(w http.ResponseWriter, r *http.Request) {
	t, err := stats.LoadThresholds(r.Context(), db.New(a.d.Pool))
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toThresholdsJSON(t))
}

// putDashboardSettings handles PUT /settings/dashboard (Owner only): it
// replaces all three thresholds.
func (a *api) putDashboardSettings(w http.ResponseWriter, r *http.Request) {
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		OfflineDays      *int    `json:"offline_days"`
		PendingHours     *int    `json:"pending_hours"`
		MinClientVersion *string `json:"min_client_version"`
	}
	if !decode(w, r, &req) {
		return
	}
	for _, f := range []struct {
		name string
		set  bool
	}{{"offline_days", req.OfflineDays != nil}, {"pending_hours", req.PendingHours != nil}, {"min_client_version", req.MinClientVersion != nil}} {
		if !f.set {
			writeError(w, http.StatusBadRequest, codeBadRequest, f.name+" is required")
			return
		}
	}
	ctx := r.Context()
	next := stats.Thresholds{OfflineDays: *req.OfflineDays, PendingHours: *req.PendingHours, MinClientVersion: *req.MinClientVersion}
	var saved stats.Thresholds
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		before, err := stats.LoadThresholds(ctx, q)
		if err != nil {
			return err
		}
		if err := stats.SaveThresholds(ctx, q, next); err != nil {
			return err
		}
		if saved, err = stats.LoadThresholds(ctx, q); err != nil {
			return err
		}
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionDashboardUpdated,
			TargetType: "settings", TargetID: "dashboard",
			Details: map[string]any{"before": toThresholdsJSON(before), "after": toThresholdsJSON(saved)},
		})
	})
	var ve *stats.ValidationError
	if errors.As(err, &ve) {
		writeError(w, http.StatusBadRequest, codeBadRequest, fmt.Sprintf("%s: %s", ve.Field, ve.Msg))
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toThresholdsJSON(saved))
}
