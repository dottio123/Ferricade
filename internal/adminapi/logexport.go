package adminapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/dottio123/ferricade/internal/logexport"
)

type logExportJSON struct {
	Settings  logexport.Settings                `json:"settings"`
	Status    map[string]logexport.OutputStatus `json:"status"`
	UpdatedAt time.Time                         `json:"updated_at"`
	UpdatedBy *deploymentActor                  `json:"updated_by"`
}

func (a *api) logExportResponse(w http.ResponseWriter, r *http.Request, s logexport.Settings) {
	status, err := a.d.LogExport.Status(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	actor, err := a.policyActor(r.Context(), s.UpdatedBy)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, logExportJSON{Settings: s, Status: status, UpdatedAt: s.UpdatedAt, UpdatedBy: actor})
}
func (a *api) getLogExport(w http.ResponseWriter, r *http.Request) {
	s, err := a.d.LogExport.Settings(r.Context())
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	a.logExportResponse(w, r, s)
}
func (a *api) putLogExport(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		File *struct {
			Enabled *bool `json:"enabled"`
		} `json:"file"`
		Syslog *struct {
			Enabled  *bool   `json:"enabled"`
			Host     *string `json:"host"`
			Port     *int32  `json:"port"`
			TLS      *bool   `json:"tls"`
			CAPEM    *string `json:"ca_pem"`
			Facility *string `json:"facility"`
			Format   *string `json:"format"`
		} `json:"syslog"`
	}
	if !decode(w, r, &req) {
		return
	}
	bad := func(field string) { writeError(w, http.StatusBadRequest, codeBadRequest, field+": required") }
	if req.File == nil || req.File.Enabled == nil {
		bad("file.enabled")
		return
	}
	if req.Syslog == nil {
		bad("syslog")
		return
	}
	s := req.Syslog
	for _, entry := range []struct {
		name    string
		present bool
	}{
		{"syslog.enabled", s.Enabled != nil}, {"syslog.host", s.Host != nil}, {"syslog.port", s.Port != nil},
		{"syslog.tls", s.TLS != nil}, {"syslog.ca_pem", s.CAPEM != nil}, {"syslog.facility", s.Facility != nil}, {"syslog.format", s.Format != nil},
	} {
		if !entry.present {
			bad(entry.name)
			return
		}
	}
	next := logexport.Settings{File: logexport.FileSettings{Enabled: *req.File.Enabled}, Syslog: logexport.SyslogSettings{Enabled: *s.Enabled, Host: *s.Host, Port: *s.Port, TLS: *s.TLS, CAPEM: *s.CAPEM, Facility: *s.Facility, Format: *s.Format}}
	saved, err := a.d.LogExport.Update(r.Context(), actor, next)
	if err != nil {
		var input logexport.InputError
		if errors.As(err, &input) {
			writeError(w, http.StatusBadRequest, codeBadRequest, input.Error())
			return
		}
		a.writeInternal(w, r, err)
		return
	}
	a.logExportResponse(w, r, saved)
}
func (a *api) testLogExport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Output string `json:"output"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Output != "file" && req.Output != "syslog" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "output: must be file or syslog")
		return
	}
	err := a.d.LogExport.Test(r.Context(), req.Output)
	if errors.Is(err, logexport.ErrSyslogUnavailable) {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	if err != nil {
		message := logexport.TruncateError(err.Error())
		writeJSON(w, http.StatusOK, struct {
			OK    bool    `json:"ok"`
			Error *string `json:"error"`
		}{Error: &message})
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK    bool    `json:"ok"`
		Error *string `json:"error"`
	}{OK: true})
}
