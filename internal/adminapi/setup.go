package adminapi

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/connect"
	"github.com/dottio123/ferricade/internal/servers"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/store/db"
)

// setupAvailable makes the /setup routes disappear (404) once setup is
// complete.
func (a *api) setupAvailable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		done, err := a.d.Setup.Complete(r.Context())
		if err != nil {
			a.writeInternal(w, r, err)
			return
		}
		if done {
			notFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// setupGuard requires the setup token in X-Setup-Token.
func (a *api) setupGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.d.Guard.Valid(r.Header.Get(headerSetup)) {
			writeError(w, http.StatusUnauthorized, codeUnauthenticated, "a valid "+headerSetup+" header is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeSetupError maps the setup service's errors to responses.
func (a *api) writeSetupError(w http.ResponseWriter, r *http.Request, err error) {
	var input setup.InputError
	switch {
	case auth.IsWeakPassword(err):
		writeError(w, http.StatusBadRequest, codeWeakPassword, err.Error())
	case errors.Is(err, auth.ErrBusy):
		writeBusy(w)
	case errors.As(err, &input):
		writeError(w, http.StatusBadRequest, codeBadRequest, input.Error())
	case errors.Is(err, setup.ErrInvalidKey):
		writeError(w, http.StatusBadRequest, codeInvalidKey, "public_key must be base64 of 32 bytes (the content of id_ed25519.pub)")
	case errors.Is(err, setup.ErrInvalidCode):
		writeError(w, http.StatusBadRequest, codeInvalidCode, msgInvalidCode)
	case errors.Is(err, setup.ErrCodeUsed):
		writeCodeUsed(w)
	case errors.Is(err, setup.ErrIncomplete):
		writeError(w, http.StatusConflict, codeIncomplete, "an earlier setup step is missing")
	case errors.Is(err, setup.ErrComplete):
		notFound(w, r)
	default:
		a.writeInternal(w, r, err)
	}
}

// setupOwner handles POST /setup/owner.
func (a *api) setupOwner(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	var req struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
	}
	if !decode(w, r, &req) {
		return
	}
	id, err := a.d.Setup.CreateOwner(r.Context(), req.Username, req.Password, req.DisplayName, req.Email, ip)
	if err != nil {
		a.writeSetupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		ID uuid.UUID `json:"id"`
	}{id})
}

// setupOwnerTOTP handles POST /setup/owner/totp.
func (a *api) setupOwnerTOTP(w http.ResponseWriter, r *http.Request) {
	secret, url, err := a.d.Setup.BeginOwnerTOTP(r.Context())
	if err != nil {
		a.writeSetupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Secret     string `json:"secret"`
		OTPAuthURL string `json:"otpauth_url"`
	}{secret, url})
}

// setupVerifyOwnerTOTP handles POST /setup/owner/totp/verify.
func (a *api) setupVerifyOwnerTOTP(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	var req codeRequest
	if !decode(w, r, &req) {
		return
	}
	if err := a.d.Setup.VerifyOwnerTOTP(r.Context(), req.Code, ip); err != nil {
		a.writeSetupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Verified bool `json:"verified"`
	}{true})
}

type checkJSON struct {
	Name    string  `json:"name"`
	OK      bool    `json:"ok"`
	Detail  string  `json:"detail"`
	Target  string  `json:"target"`
	Address string  `json:"address"`
	Reason  *string `json:"reason"`
}

// setupServer handles POST /setup/server. The profile is validated and saved
// first (so an empty host never reaches the checks), then the reachability
// checks run; it stays saved whatever they report.
func (a *api) setupServer(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	var req struct {
		Name      string `json:"name"`
		IDHost    string `json:"id_host"`
		RelayHost string `json:"relay_host"`
		PublicKey string `json:"public_key"`
	}
	if !decode(w, r, &req) {
		return
	}
	ctx := r.Context()
	id, err := a.d.Setup.SaveServer(ctx, req.Name, req.IDHost, req.RelayHost, req.PublicKey, ip)
	if err != nil {
		a.writeSetupError(w, r, err)
		return
	}
	srv, err := db.New(a.d.Pool).GetServer(ctx)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get server: %w", err))
		return
	}
	results := servers.Run(ctx, srv.IDHost, srv.RelayHost, connect.ConfiguredAPIAddr(srv.ApiUrl, srv.IDHost, a.d.Cfg.ClientListenAddr), a.d.Cfg.HBBSAddr, a.d.Dial)
	checks := make([]checkJSON, len(results))
	for i, c := range results {
		checks[i] = toCheckJSON(c)
	}
	writeJSON(w, http.StatusOK, struct {
		Saved    bool        `json:"saved"`
		ServerID uuid.UUID   `json:"server_id"`
		Checks   []checkJSON `json:"checks"`
	}{true, id, checks})
}

func toCheckJSON(c servers.Check) checkJSON {
	var reason *string
	if !c.OK {
		reason = &c.Reason
	}
	return checkJSON{Name: c.Name, OK: c.OK, Detail: c.Detail, Target: c.Target, Address: c.Address, Reason: reason}
}

// setupComplete handles POST /setup/complete.
func (a *api) setupComplete(w http.ResponseWriter, r *http.Request) {
	ip, ok := a.clientIP(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	if err := a.d.Setup.Finish(ctx, ip); err != nil {
		a.writeSetupError(w, r, err)
		return
	}
	srv, err := db.New(a.d.Pool).GetServer(ctx)
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get server: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ClientConfig clientConfigJSON `json:"client_config"`
	}{a.buildClientConfig(srv)})
}

// clientConfig handles GET /server/client-config: the same object
// /setup/complete returned. It is 404 until setup is complete.
func (a *api) clientConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	done, err := a.d.Setup.Complete(ctx)
	if err != nil {
		a.writeInternal(w, r, err)
		return
	}
	if !done {
		notFound(w, r)
		return
	}
	srv, err := db.New(a.d.Pool).GetServer(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		a.writeInternal(w, r, fmt.Errorf("get server: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, a.buildClientConfig(srv))
}

// clientConfigJSON is what a RustDesk client needs to use this server: the
// config string, its deep link, the four values separately, and per-OS
// install commands.
type clientConfigJSON struct {
	ConfigString string            `json:"config_string"`
	DeepLink     string            `json:"deep_link"`
	API          string            `json:"api"`
	Host         string            `json:"host"`
	Relay        string            `json:"relay"`
	Key          string            `json:"key"`
	Install      map[string]string `json:"install"`
}

func (a *api) buildClientConfig(srv db.Server) clientConfigJSON {
	c := connect.ClientConfig{
		Host:  srv.IDHost,
		Relay: srv.RelayHost,
		API:   connect.ConfiguredAPIURL(srv.ApiUrl, srv.IDHost, a.d.Cfg.ClientListenAddr),
		Key:   srv.PublicKey,
	}
	s := connect.ConfigString(c)
	return clientConfigJSON{
		ConfigString: s,
		DeepLink:     "rustdesk://config/" + s,
		API:          c.API,
		Host:         c.Host,
		Relay:        c.Relay,
		Key:          c.Key,
		Install:      connect.InstallSnippets(c),
	}
}
