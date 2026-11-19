package adminapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/deploy"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

type deploymentEditable struct {
	InstallerSource    string                         `json:"installer_source"`
	ClientVersion      string                         `json:"client_version"`
	URLWindows         string                         `json:"url_windows"`
	URLDeb             string                         `json:"url_deb"`
	URLRPM             string                         `json:"url_rpm"`
	SHA256Windows      string                         `json:"sha256_windows"`
	SHA256Deb          string                         `json:"sha256_deb"`
	SHA256RPM          string                         `json:"sha256_rpm"`
	AllowDowngrade     bool                           `json:"allow_downgrade"`
	IncludeInstall     bool                           `json:"include_install"`
	IncludePassword    bool                           `json:"include_password"`
	IncludeUnlockPIN   bool                           `json:"include_unlock_pin"`
	IncludeIDAllowList bool                           `json:"include_id_allow_list"`
	Settings           map[string]deploy.SettingValue `json:"settings"`
}

func editable(p deploy.Profile) deploymentEditable {
	return deploymentEditable{p.InstallerSource, p.ClientVersion, p.URLWindows, p.URLDeb, p.URLRPM,
		p.SHA256Windows, p.SHA256Deb, p.SHA256RPM, p.AllowDowngrade, p.IncludeInstall,
		p.IncludePassword, p.IncludeUnlockPIN, p.IncludeIDAllowList, p.Settings}
}

func (e deploymentEditable) profile() deploy.Profile {
	return deploy.Profile{InstallerSource: e.InstallerSource, ClientVersion: e.ClientVersion,
		URLWindows: e.URLWindows, URLDeb: e.URLDeb, URLRPM: e.URLRPM,
		SHA256Windows: e.SHA256Windows, SHA256Deb: e.SHA256Deb, SHA256RPM: e.SHA256RPM,
		AllowDowngrade: e.AllowDowngrade, IncludeInstall: e.IncludeInstall,
		IncludePassword: e.IncludePassword, IncludeUnlockPIN: e.IncludeUnlockPIN,
		IncludeIDAllowList: e.IncludeIDAllowList, Settings: e.Settings}
}

type deploymentPut struct {
	deploymentEditable
	FleetPassword json.RawMessage `json:"fleet_password"`
	UnlockPIN     json.RawMessage `json:"unlock_pin"`
}

// Flatten the embedded editable fields while preserving absent versus null secrets.
func (p *deploymentPut) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if fields == nil {
		return errors.New("deployment profile must be an object")
	}
	allowed := map[string]bool{}
	for _, name := range []string{"installer_source", "client_version", "url_windows", "url_deb", "url_rpm", "sha256_windows", "sha256_deb", "sha256_rpm", "allow_downgrade", "include_install", "include_password", "include_unlock_pin", "include_id_allow_list", "settings", "fleet_password", "unlock_pin"} {
		allowed[name] = true
	}
	for name := range fields {
		if !allowed[name] {
			return fmt.Errorf("unknown field %q", name)
		}
	}
	for _, name := range []string{"installer_source", "client_version", "url_windows", "url_deb", "url_rpm", "sha256_windows", "sha256_deb", "sha256_rpm", "allow_downgrade", "include_install", "include_password", "include_unlock_pin", "include_id_allow_list", "settings"} {
		if len(fields[name]) == 0 || bytes.Equal(fields[name], []byte("null")) {
			return fmt.Errorf("%s is required", name)
		}
	}
	type plain deploymentEditable
	if err := json.Unmarshal(raw, (*plain)(&p.deploymentEditable)); err != nil {
		return err
	}
	settingsDecoder := json.NewDecoder(bytes.NewReader(fields["settings"]))
	settingsDecoder.DisallowUnknownFields()
	if err := settingsDecoder.Decode(&p.Settings); err != nil {
		return err
	}
	p.FleetPassword, p.UnlockPIN = fields["fleet_password"], fields["unlock_pin"]
	return nil
}

func secretChange(raw json.RawMessage, field string) (deploy.SecretChange, error) {
	if len(raw) == 0 {
		return deploy.SecretChange{Keep: true}, nil
	}
	if bytes.Equal(raw, []byte("null")) {
		return deploy.SecretChange{}, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return deploy.SecretChange{}, fmt.Errorf("%s: must be a string or null", field)
	}
	return deploy.SecretChange{Value: &value}, nil
}

type deploymentActor struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}

type deploymentSecretJSON struct {
	Set   bool             `json:"set"`
	SetAt *time.Time       `json:"set_at"`
	SetBy *deploymentActor `json:"set_by"`
}

type deploymentSettingJSON struct {
	Key         string            `json:"key"`
	Label       string            `json:"label"`
	Help        string            `json:"help"`
	Type        string            `json:"type"`
	Values      []string          `json:"values"`
	ValueLabels map[string]string `json:"value_labels"`
	Default     string            `json:"default"`
	OS          []string          `json:"os"`
	Source      string            `json:"source"`
}

type deploymentProfileJSON struct {
	deploymentEditable
	Catalog   []deploymentSettingJSON `json:"catalog"`
	Password  deploymentSecretJSON    `json:"password"`
	UnlockPIN deploymentSecretJSON    `json:"unlock_pin"`
	UpdatedAt *time.Time              `json:"updated_at"`
}

// MarshalJSON keeps the editable fields at the top level of the response.
func (p deploymentProfileJSON) MarshalJSON() ([]byte, error) {
	var m map[string]any
	raw, err := json.Marshal(p.deploymentEditable)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m["catalog"], m["password"], m["unlock_pin"], m["updated_at"] = p.Catalog, p.Password, p.UnlockPIN, p.UpdatedAt
	return json.Marshal(m)
}

func (a *api) deploymentResponse(ctx *http.Request, q *db.Queries, s deploy.Stored) (deploymentProfileJSON, error) {
	state := func(info deploy.SecretState) (deploymentSecretJSON, error) {
		if !info.Set {
			return deploymentSecretJSON{}, nil
		}
		result := deploymentSecretJSON{Set: true, SetAt: info.SetAt}
		if info.SetBy != nil {
			actor, err := a.policyActorWithQueries(ctx.Context(), q, info.SetBy)
			if err != nil {
				return deploymentSecretJSON{}, fmt.Errorf("load deployment secret actor: %w", err)
			}
			result.SetBy = actor
		}
		return result, nil
	}
	password, err := state(s.Password)
	if err != nil {
		return deploymentProfileJSON{}, err
	}
	pin, err := state(s.UnlockPIN)
	if err != nil {
		return deploymentProfileJSON{}, err
	}
	catalog := make([]deploymentSettingJSON, 0, len(deploy.Catalog()))
	for _, item := range deploy.Catalog() {
		if item.Values == nil {
			item.Values = []string{}
		}
		catalog = append(catalog, deploymentSettingJSON{Key: item.Key, Label: item.Label, Help: item.Help, Type: item.Type,
			Values: item.Values, ValueLabels: item.ValueLabels, Default: item.Default, OS: item.OS, Source: item.Source})
	}
	return deploymentProfileJSON{editable(s.Profile), catalog, password, pin, s.UpdatedAt}, nil
}

func (a *api) getDeploymentProfile(w http.ResponseWriter, r *http.Request) {
	q := db.New(a.d.Pool)
	s, err := deploy.Load(r.Context(), q)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	result, err := a.deploymentResponse(r, q, s)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) putDeploymentProfile(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req deploymentPut
	if !decode(w, r, &req) {
		return
	}
	pw, err := secretChange(req.FleetPassword, "fleet_password")
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	pin, err := secretChange(req.UnlockPIN, "unlock_pin")
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	var saved deploymentProfileJSON
	err = store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		before, err := deploy.Load(r.Context(), q)
		if err != nil {
			return err
		}
		if err := deploy.Save(r.Context(), q, a.d.Sealer, actor.UserID, req.profile(), pw, pin, a.now()); err != nil {
			return err
		}
		after, err := deploy.Load(r.Context(), q)
		if err != nil {
			return err
		}
		saved, err = a.deploymentResponse(r, q, after)
		if err != nil {
			return err
		}
		record := func(action string, details map[string]any) error {
			return audit.Record(r.Context(), q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP,
				Action: action, TargetType: "settings", TargetID: "deployment", Details: details})
		}
		if err := record("deployment.profile_updated", map[string]any{"before": editable(before.Profile), "after": editable(after.Profile)}); err != nil {
			return err
		}
		if !pw.Keep {
			if pw.Value != nil {
				if err := record("deployment.password_set", nil); err != nil {
					return err
				}
			} else if before.Password.Set {
				if err := record("deployment.password_removed", nil); err != nil {
					return err
				}
			}
		}
		if !pin.Keep {
			if pin.Value != nil {
				if err := record("deployment.pin_set", nil); err != nil {
					return err
				}
			} else if before.UnlockPIN.Set {
				if err := record("deployment.pin_removed", nil); err != nil {
					return err
				}
			}
		}
		return nil
	})
	var ve *deploy.ValidationError
	if errors.As(err, &ve) {
		writeError(w, http.StatusBadRequest, codeBadRequest, ve.Error())
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (a *api) deploymentScript(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		OS string `json:"os"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.OS != "windows" && req.OS != "linux" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "os must be windows or linux")
		return
	}
	done, err := a.d.Setup.Complete(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if !done {
		notFound(w, r)
		return
	}
	srv, ok := a.loadServer(w, r)
	if !ok {
		return
	}
	config := a.buildClientConfig(srv).ConfigString
	var script []byte
	err = store.Tx(r.Context(), a.d.Pool, func(q *db.Queries) error {
		profile, err := deploy.Load(r.Context(), q)
		if err != nil {
			return err
		}
		if profile.Profile.InstallerSource == "url" {
			if req.OS == "windows" && profile.Profile.URLWindows == "" {
				return &deploy.ValidationError{Field: "url_windows", Msg: "required for windows"}
			}
			if req.OS == "linux" && profile.Profile.URLDeb == "" && profile.Profile.URLRPM == "" {
				return &deploy.ValidationError{Field: "url_deb or url_rpm", Msg: "required for linux"}
			}
		}
		secrets, err := deploy.LoadSecrets(r.Context(), q, a.d.Sealer)
		if err != nil {
			return err
		}
		if profile.Profile.IncludeIDAllowList {
			ids, err := q.GetGlobalIDAllowList(r.Context())
			if err != nil {
				return err
			}
			profile.Profile.IDAllowList = ids
		}
		script, err = deploy.Render(req.OS, profile.Profile, secrets, config)
		if err != nil {
			return err
		}
		clearsPassword, clearsPIN := secrets.Clears(profile.Profile)
		return audit.Record(r.Context(), q, audit.Event{ActorUserID: &actor.UserID, ActorIP: actor.IP,
			Action: "deployment.script_downloaded", TargetType: "settings", TargetID: "deployment",
			Details: map[string]any{"os": req.OS, "clears_password": clearsPassword, "clears_pin": clearsPIN}})
	})
	var ve *deploy.ValidationError
	if errors.As(err, &ve) {
		writeError(w, http.StatusBadRequest, codeBadRequest, ve.Error())
		return
	}
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	ext := ".sh"
	if req.OS == "windows" {
		ext = ".ps1"
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=ferricade-deploy"+ext)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(script)
}
