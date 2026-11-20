package adminapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/connect"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

// actionConnectLink is audited each time a connect link is handed out.
const actionConnectLink = "device.connect_link"

type tagJSON struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color int64     `json:"color"`
}

type alertJSON struct {
	ID             uuid.UUID          `json:"id"`
	Kind           string             `json:"kind"`
	SeenUUID       *string            `json:"seen_uuid"`
	IP             *string            `json:"ip"`
	CreatedAt      time.Time          `json:"created_at"`
	WindowClosedAt *time.Time         `json:"window_closed_at"`
	Groups         []devices.GroupRef `json:"groups"`
}

type deviceJSON struct {
	ID            uuid.UUID   `json:"id"`
	RustdeskID    string      `json:"rustdesk_id"`
	UUID          string      `json:"uuid"`
	State         string      `json:"state"`
	Alias         string      `json:"alias"`
	Hostname      string      `json:"hostname"`
	OS            string      `json:"os"`
	CPU           string      `json:"cpu"`
	Memory        string      `json:"memory"`
	ClientVersion string      `json:"client_version"`
	Username      string      `json:"username"`
	Note          string      `json:"note"`
	GroupID       *uuid.UUID  `json:"group_id"`
	FirstSeenAt   time.Time   `json:"first_seen_at"`
	LastSeenAt    time.Time   `json:"last_seen_at"`
	ApprovedBy    *uuid.UUID  `json:"approved_by"`
	ApprovedAt    *time.Time  `json:"approved_at"`
	UpdatedAt     time.Time   `json:"updated_at"`
	Tags          []tagJSON   `json:"tags"`
	OpenAlerts    []alertJSON `json:"open_alerts"`
	Online        bool        `json:"online"`
	Conns         []int32     `json:"conns"`
}

func toTagJSON(t devices.Tag) tagJSON { return tagJSON(t) }

// toDeviceJSON adds the device's online state and connections from the
// tracker.
func (a *api) toDeviceJSON(d devices.Device) deviceJSON {
	out := deviceJSON{
		ID: d.ID, RustdeskID: d.RustdeskID, UUID: d.UUID, State: d.State, Alias: d.Alias,
		Hostname: d.Hostname, OS: d.OS, CPU: d.CPU, Memory: d.Memory, ClientVersion: d.ClientVersion,
		Username: d.Username, Note: d.Note, GroupID: d.GroupID, FirstSeenAt: d.FirstSeenAt,
		LastSeenAt: d.LastSeenAt, ApprovedBy: d.ApprovedBy, ApprovedAt: d.ApprovedAt, UpdatedAt: d.UpdatedAt,
		Tags: make([]tagJSON, len(d.Tags)), OpenAlerts: make([]alertJSON, len(d.OpenAlerts)),
		Online: a.online(d.RustdeskID), Conns: []int32{},
	}
	for i, t := range d.Tags {
		out.Tags[i] = toTagJSON(t)
	}
	for i, al := range d.OpenAlerts {
		out.OpenAlerts[i] = alertJSON{ID: al.ID, Kind: al.Kind, CreatedAt: al.CreatedAt, WindowClosedAt: al.WindowClosedAt}
		out.OpenAlerts[i].Groups = append([]devices.GroupRef{}, al.Groups...)
		if al.Kind == "uuid_mismatch" {
			out.OpenAlerts[i].SeenUUID, out.OpenAlerts[i].IP = &al.SeenUUID, &al.IP
		}
	}
	if a.d.Tracker != nil {
		if c := a.d.Tracker.Conns(d.RustdeskID); c != nil {
			out.Conns = c
		}
	}
	return out
}

func (a *api) online(rustdeskID string) bool {
	return a.d.Tracker != nil && a.d.Tracker.Online(rustdeskID)
}

// hideForUser strips what a User must not learn from a device they see: who
// approved it, the group when it is not one of theirs, and the addresses in its
// alerts.
func hideForUser(d *deviceJSON, groups map[uuid.UUID]bool) {
	d.ApprovedBy = nil
	if d.GroupID != nil && !groups[*d.GroupID] {
		d.GroupID = nil
	}
	for i := range d.OpenAlerts {
		visible := []devices.GroupRef{}
		for _, g := range d.OpenAlerts[i].Groups {
			if groups[g.ID] {
				visible = append(visible, g)
			}
		}
		d.OpenAlerts[i].Groups = visible
		if d.OpenAlerts[i].IP != nil {
			empty := ""
			d.OpenAlerts[i].IP = &empty
		}
	}
}

// visibleGroupSet returns the groups scope can see.
func (a *api) visibleGroupSet(ctx context.Context, scope uuid.UUID) (map[uuid.UUID]bool, error) {
	ids, err := db.New(a.d.Pool).ListVisibleGroupIDs(ctx, scope)
	if err != nil {
		return nil, fmt.Errorf("list visible groups: %w", err)
	}
	set := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set, nil
}

// listDevices handles GET /devices. The online filter is applied to each page
// after it is read, so a page can be short while next_cursor is set.
func (a *api) listDevices(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Has("sort") && !slices.Contains([]string{"rustdesk_id", "name", "status", "state", "os", "group"}, q.Get("sort")) {
		writeError(w, http.StatusBadRequest, codeBadRequest, "unknown sort")
		return
	}
	if q.Has("order") && q.Get("order") != "asc" && q.Get("order") != "desc" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "unknown order")
		return
	}
	var f devices.Filter
	f.Sort, f.Order = q.Get("sort"), q.Get("order")
	switch st := q.Get("state"); st {
	case "", devices.StatePending, devices.StateApproved, devices.StateRejected, devices.StateArchived:
		f.State = st
	default:
		writeError(w, http.StatusBadRequest, codeBadRequest, "state must be pending, approved, rejected or archived")
		return
	}
	if v := q.Get("online"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, codeBadRequest, "online must be true or false")
			return
		}
		f.Online = &b
	}
	var ok bool
	if f.TagID, ok = queryUUID(w, r, "tag"); !ok {
		return
	}
	if f.GroupID, ok = queryUUID(w, r, "group"); !ok {
		return
	}
	if v := q.Get("ungrouped"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, codeBadRequest, "ungrouped must be true or false")
			return
		}
		f.Ungrouped = b
	}
	if f.Ungrouped && f.GroupID != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "group and ungrouped cannot be combined")
		return
	}
	if q.Has("subgroups") {
		if f.GroupID == nil || f.Ungrouped {
			writeError(w, http.StatusBadRequest, codeBadRequest, "subgroups requires group and cannot be combined with ungrouped")
			return
		}
		b, err := strconv.ParseBool(q.Get("subgroups"))
		if err != nil {
			writeError(w, http.StatusBadRequest, codeBadRequest, "subgroups must be true or false")
			return
		}
		f.Subgroups = b
	}
	if f.OS, ok = queryText(w, r, "os"); !ok {
		return
	}
	if f.Q, ok = queryText(w, r, "q"); !ok {
		return
	}
	if f.Limit, f.Cursor, ok = page(w, r); !ok {
		return
	}
	f.ScopeUser = scopeOf(userFrom(r.Context()))
	list, next, err := a.d.Devices.List(r.Context(), f, a.online)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	out := listJSON[deviceJSON]{Items: make([]deviceJSON, len(list)), NextCursor: next}
	var groups map[uuid.UUID]bool
	if f.ScopeUser != nil {
		if groups, err = a.visibleGroupSet(r.Context(), *f.ScopeUser); err != nil {
			a.writeInternal(w, r, err)
			return
		}
	}
	for i, d := range list {
		out.Items[i] = a.toDeviceJSON(d)
		if f.ScopeUser != nil {
			hideForUser(&out.Items[i], groups)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// writeDevice answers with the device id as it is now.
func (a *api) writeDevice(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	scope := scopeOf(userFrom(r.Context()))
	d, err := a.d.Devices.Get(r.Context(), id, scope)
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	out := a.toDeviceJSON(d)
	if scope != nil {
		groups, err := a.visibleGroupSet(r.Context(), *scope)
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		hideForUser(&out, groups)
	}
	writeJSON(w, http.StatusOK, out)
}

// getDevice handles GET /devices/{id}.
func (a *api) getDevice(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathID(w, r, "id"); ok {
		a.writeDevice(w, r, id)
	}
}

// patchDevice handles PATCH /devices/{id}.
func (a *api) patchDevice(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Alias   *string             `json:"alias"`
		Note    *string             `json:"note"`
		GroupID nullable[uuid.UUID] `json:"group_id"`
		TagIDs  *[]uuid.UUID        `json:"tag_ids"`
	}
	if !decode(w, r, &req) {
		return
	}
	d, err := a.d.Devices.Update(r.Context(), act, id, devices.Patch{
		Alias: req.Alias, Note: req.Note, GroupID: req.GroupID.patch(), TagIDs: req.TagIDs,
	})
	if err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toDeviceJSON(d))
}

// transitionDevice handles POST /devices/{id}/approve|reject|archive|restore:
// a move to state to, from one of the states from.
func (a *api) transitionDevice(to string, from ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		act, ok := a.actor(w, r)
		if !ok {
			return
		}
		if err := a.d.Devices.Transition(r.Context(), act, id, to, from...); err != nil {
			a.writeDevicesError(w, r, err)
			return
		}
		a.writeDevice(w, r, id)
	}
}

// deleteDevice handles DELETE /devices/{id}.
func (a *api) deleteDevice(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	if err := a.d.Devices.Delete(r.Context(), act, id); err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// resolveAlert handles POST /devices/{id}/alerts/{alert_id}/resolve.
func (a *api) resolveAlert(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	alertID, ok := pathID(w, r, "alert_id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Action != "accept_new_uuid" && req.Action != "dismiss" {
		writeError(w, http.StatusBadRequest, codeBadRequest, `action must be "accept_new_uuid" or "dismiss"`)
		return
	}
	if req.Action == "accept_new_uuid" {
		alert, err := db.New(a.d.Pool).GetOpenAlertForUpdate(r.Context(), db.GetOpenAlertForUpdateParams{ID: alertID, DeviceID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			notFound(w, r)
			return
		}
		if err != nil {
			a.writeInternal(w, r, fmt.Errorf("adminapi: get alert kind: %w", err))
			return
		}
		if alert.Kind != "uuid_mismatch" {
			writeError(w, http.StatusBadRequest, codeBadRequest, "action: accept_new_uuid applies only to uuid_mismatch alerts")
			return
		}
	}
	if err := a.d.Devices.ResolveAlert(r.Context(), act, id, alertID, req.Action == "accept_new_uuid"); err != nil {
		a.writeDevicesError(w, r, err)
		return
	}
	a.writeDevice(w, r, id)
}

// connectLink handles GET /devices/{id}/connect?action=&relay=. Only approved
// devices have links; every link handed out is audited.
func (a *api) connectLink(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	action := q.Get("action")
	if action == "" {
		action = "connect"
	}
	var relay bool
	switch q.Get("relay") {
	case "", "0":
	case "1":
		relay = true
	default:
		writeError(w, http.StatusBadRequest, codeBadRequest, "relay must be 0 or 1")
		return
	}

	var resp struct {
		URL            string `json:"url"`
		Command        string `json:"command"`
		ID             string `json:"id"`
		IncludesServer bool   `json:"includes_server"`
	}
	ctx := r.Context()
	err := store.Tx(ctx, a.d.Pool, func(q *db.Queries) error {
		var d db.Device
		var err error
		if scope := scopeOf(userFrom(ctx)); scope != nil {
			d, err = q.GetVisibleDevice(ctx, db.GetVisibleDeviceParams{ID: id, UserID: *scope})
		} else {
			d, err = q.GetDevice(ctx, id)
		}
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && d.State != devices.StateApproved) {
			return &apiError{http.StatusNotFound, codeNotFound, "not found"}
		}
		if err != nil {
			return fmt.Errorf("get device %s: %w", id, err)
		}
		locked, err := a.d.Policies.CanConnect(ctx, q, id)
		if err != nil {
			return fmt.Errorf("check device connection policy: %w", err)
		}
		if locked {
			return &apiError{http.StatusConflict, codeAccessLocked, "Locked by policy. Allow access first."}
		}
		// Name the ID server in the link, so it works from a client whose own
		// ID server is another one (the public servers, say).
		s, err := q.GetServer(ctx)
		if err != nil {
			return fmt.Errorf("get server: %w", err)
		}
		via := connect.Server{Host: s.IDHost, Key: s.PublicKey}
		if !s.LinksIncludeServer {
			via = connect.Server{}
		}
		link, err := connect.LinkVia(via, d.RustdeskID, action, relay)
		if err != nil {
			return &apiError{http.StatusBadRequest, codeBadRequest,
				"action must be connect, file-transfer, port-forward or terminal (or the device ID cannot be put in a link)"}
		}
		cmd, err := connect.CommandVia(via, d.RustdeskID, action, relay)
		if err != nil {
			return fmt.Errorf("connect command: %w", err)
		}
		resp.URL, resp.Command, resp.ID, resp.IncludesServer = link, cmd, d.RustdeskID, s.LinksIncludeServer
		return audit.Record(ctx, q, audit.Event{
			ActorUserID: &act.UserID, ActorIP: act.IP, Action: actionConnectLink,
			TargetType: "device", TargetID: id.String(),
			Details: map[string]any{"rustdesk_id": d.RustdeskID, "action": action, "relay": relay},
		})
	})
	if err != nil {
		if !writeAPIError(w, err) {
			a.writeInternal(w, r, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
