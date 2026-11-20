// Package adminapi serves the admin console's JSON API under /admin/api/v1
// and the first-run setup wizard under /setup, with the session, CSRF, origin
// and security-header middleware the spec requires. openapi.yaml describes
// every route.
package adminapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/grouprules"
	"github.com/dottio123/ferricade/internal/httpx"
	"github.com/dottio123/ferricade/internal/logexport"
	"github.com/dottio123/ferricade/internal/oidc"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/servers"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/setup"
)

// maxLockoutKeys bounds pending TOTP enrollments.
const maxLockoutKeys = 10_000

// Deps are what the admin API needs. Now defaults to time.Now, Dial to a
// net.Dialer, Log to slog.Default(), and Groups and Tags to ones on Pool.
type Deps struct {
	Cfg                config.Config
	Pool               *pgxpool.Pool
	Sessions           *auth.Sessions // admin logins
	IPLimiter          *auth.IPLimiter
	Sealer             *auth.Sealer
	Params             auth.Params
	Setup              *setup.Service
	Guard              *setup.Guard
	Devices            *devices.Service
	Tracker            *devices.Tracker // online state and connections of devices; nil reports all offline
	Groups             *devices.Groups  // defaults to one on Pool
	GroupRules         *grouprules.Service
	Policies           *policies.Service
	LogExport          *logexport.Service
	Tags               *devices.Tags     // defaults to one on Pool
	RemoteSessions     *sessions.Service // remote session history; defaults to one on Pool
	ServerMonitor      *servers.Monitor
	Hub                *events.Hub // live events for the event stream; defaults to an empty one
	OIDCClient         *http.Client
	EventsPing         time.Duration // idle ping of the event stream; defaults to 25 s
	EventsWriteTimeout time.Duration // longest one event-stream write may block; defaults to 10 s
	ClientRoutes       chi.Router    // serves /healthz and /api/* when set, for clients using the https API URL
	UI                 fs.FS         // the built web UI, rooted at its index.html; nil serves a placeholder
	Now                func() time.Time
	Dial               func(ctx context.Context, network, addr string) (net.Conn, error)
	QueryOnline        func(ctx context.Context, addr string, ids []string) (map[string]bool, error)
	Log                *slog.Logger
}

type api struct {
	d   Deps
	log *slog.Logger

	// unknownUsers counts failed logins per lower-cased unknown username, so
	// that they lock exactly like real accounts and do not reveal which
	// usernames exist.
	unknownUsers  *auth.Lockouts
	enrollments   *enrollments
	streams       streamCounts // open event streams per session
	oidcProviders oidc.ProviderCache
}

func newAPI(d Deps) *api {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Dial == nil {
		d.Dial = (&net.Dialer{}).DialContext
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Groups == nil {
		d.Groups = &devices.Groups{Pool: d.Pool}
	}
	if d.GroupRules == nil {
		d.GroupRules = &grouprules.Service{Pool: d.Pool}
	}
	if d.Devices != nil && d.Devices.GroupPlacement == nil {
		d.Devices.GroupPlacement = d.GroupRules.Placement
	}
	if d.Policies == nil {
		d.Policies = &policies.Service{Pool: d.Pool, Now: d.Now}
	}
	if d.LogExport == nil {
		host := ""
		if d.Cfg.PublicURL != nil {
			host = d.Cfg.PublicURL.Hostname()
		}
		d.LogExport = &logexport.Service{Pool: d.Pool, Now: d.Now, Log: d.Log, Dir: d.Cfg.LogExportDir, Host: host}
	}
	if d.RemoteSessions == nil {
		d.RemoteSessions = &sessions.Service{Pool: d.Pool, Now: d.Now}
	}
	if d.Hub == nil {
		d.Hub = events.NewHub()
	}
	if d.OIDCClient == nil {
		d.OIDCClient = &http.Client{Timeout: 5 * time.Second}
	}
	if d.EventsPing <= 0 {
		d.EventsPing = defaultEventsPing
	}
	if d.EventsWriteTimeout <= 0 {
		d.EventsWriteTimeout = defaultEventsWriteTimeout
	}
	if d.Tags == nil {
		d.Tags = &devices.Tags{Pool: d.Pool}
	}
	if d.ServerMonitor == nil {
		d.ServerMonitor = &servers.Monitor{Log: d.Log}
	}
	return &api{
		d:            d,
		log:          d.Log,
		unknownUsers: auth.NewLockouts(131_072),
		enrollments:  newEnrollments(maxLockoutKeys),
	}
}

func (a *api) now() time.Time { return a.d.Now() }

// New returns the admin listener's handler.
func New(d Deps) http.Handler {
	a := newAPI(d)
	// Pay for the unknown-username dummy hash now, not on the first login.
	if err := auth.WarmDummyHash(); err != nil {
		a.log.Error("admin api: dummy password hash", "err", err)
	}

	r := chi.NewRouter()
	r.Use(httpx.RequestID, a.accessLog, a.securityHeaders, a.recoverer)

	r.Route("/admin/api/v1", func(r chi.Router) {
		r.Use(noStore, a.loadSession, a.checkOrigin)
		r.NotFound(notFound)
		r.MethodNotAllowed(notFound)

		r.Post("/auth/login", a.login) // no CSRF token yet; the origin check applies
		r.Get("/auth/oidc", a.oidcPublic)
		r.Get("/auth/oidc/start", a.oidcStart)
		r.Get("/auth/oidc/callback", a.oidcCallback)

		r.Group(func(r chi.Router) {
			r.Use(a.csrfToken, requireAuth)
			r.Post("/auth/logout", a.logout)
			r.Get("/auth/me", a.me)
			r.Post("/auth/totp", a.verifyTOTP)

			r.Group(func(r chi.Router) {
				r.Use(allowTOTPEnroll)
				r.Post("/auth/totp/enroll", a.enrollTOTP)
				r.Post("/auth/totp/enroll/verify", a.verifyEnrollTOTP)
			})

			// Everything else needs MFA when the user has or must have TOTP.
			r.Group(func(r chi.Router) {
				r.Use(requireMFA)
				r.Post("/auth/password", a.changePassword)
				r.Get("/devices", a.listDevices)
				r.Get("/devices/{id}", a.getDevice)
				r.Get("/devices/{id}/policy", a.getDevicePolicy)
				r.Get("/devices/{id}/connect", a.connectLink)
				r.Get("/groups", a.listGroups)
				r.Get("/tags", a.listTags)
				r.Get("/audit", a.listAudit)
				r.Get("/sessions", a.listSessions)
				r.Get("/sessions/stats", a.sessionStats)
				r.Get("/stats/summary", a.statsSummary)
				r.Get("/stats/fleet-map", a.statsFleetMap)
				r.Get("/server/health", a.serverHealth)
				r.Get("/settings/dashboard", a.getDashboardSettings)
				r.Get("/users/{id}/avatar", a.getUserAvatar)
				r.Get("/dashboard/catalog", a.dashboardCatalog)
				r.Get("/events", a.events)
				r.Get("/me/preferences", a.getPreferences)
				r.Put("/me/preferences", a.putPreferences)

				r.Group(func(r chi.Router) {
					r.Use(requireRole(roleOwner, roleAdmin))
					r.Get("/settings/id-allow-list", a.getGlobalIDAllowList)
					r.Get("/devices/{id}/id-allow-list", a.getDeviceIDAllowList)
					r.Get("/groups/{id}/id-allow-list", a.getGroupIDAllowList)
					r.Get("/server/client-config", a.clientConfig)
					r.Get("/deployment/profile", a.getDeploymentProfile)
					r.Get("/policies", a.listPolicies)
					r.Post("/policies", a.createPolicy)
					r.Get("/policies/{id}", a.getPolicy)
					r.Patch("/policies/{id}", a.updatePolicy)
					r.Delete("/policies/{id}", a.deletePolicy)
					r.Get("/settings/policy-push", a.getPolicyPush)
					r.Get("/settings/sessions", a.getSessionSettings)
					r.Get("/settings/log-export", a.getLogExport)
					r.Post("/deployment/script", a.deploymentScript)
					r.Post("/sessions/{id}/disconnect", a.disconnectSession)
					r.Patch("/devices/{id}", a.patchDevice)
					r.Put("/devices/{id}/id-allow-list", a.putDeviceIDAllowList)
					r.Delete("/devices/{id}", a.deleteDevice)
					r.Post("/devices/{id}/approve", a.transitionDevice(devices.StateApproved, devices.StatePending, devices.StateRejected))
					r.Post("/devices/{id}/reject", a.transitionDevice(devices.StateRejected, devices.StatePending))
					r.Post("/devices/{id}/reopen", a.transitionDevice(devices.StatePending, devices.StateRejected, devices.StateApproved))
					r.Post("/devices/{id}/archive", a.transitionDevice(devices.StateArchived, devices.StateApproved))
					r.Post("/devices/{id}/restore", a.transitionDevice(devices.StateApproved, devices.StateArchived))
					r.Post("/devices/{id}/alerts/{alert_id}/resolve", a.resolveAlert)
					r.Post("/devices/{id}/access-window", a.openAccessWindow)
					r.Post("/devices/{id}/access-window/close", a.closeAccessWindow)
					r.Post("/groups", a.createGroup)
					r.Get("/group-rules", a.listGroupRules)
					r.Post("/groups/{id}/rules", a.addGroupRule)
					r.Delete("/groups/{id}/rules/{rule_id}", a.removeGroupRule)
					r.Post("/groups/{id}/rules/preview", a.previewGroupRule)
					r.Patch("/groups/{id}", a.renameGroup)
					r.Post("/groups/{id}/move", a.moveGroup)
					r.Put("/groups/{id}/policy", a.putGroupPolicy)
					r.Put("/groups/{id}/id-allow-list", a.putGroupIDAllowList)
					r.Delete("/groups/{id}", a.deleteGroup)

					r.Post("/tags", a.createTag)
					r.Patch("/tags/{id}", a.updateTag)
					r.Delete("/tags/{id}", a.deleteTag)

					r.Get("/server", a.getServer)
					r.Post("/server/check", a.checkServer)
					r.Get("/stats/history", a.statsHistory)

					// Only owners manage users and edit the server.
					r.Group(func(r chi.Router) {
						r.Use(requireRole(roleOwner))
						r.Get("/users", a.listUsers)
						r.Post("/users", a.createUser)
						r.Patch("/users/{id}", a.patchUser)
						r.Get("/users/{id}/grants", a.getUserGrants)
						r.Put("/users/{id}/grants", a.putUserGrants)
						r.Post("/users/{id}/reset-totp", a.resetUserTOTP)
						r.Post("/users/{id}/password", a.resetUserPassword)
						r.Delete("/users/{id}/oidc", a.unlinkUserOIDC)
						r.Get("/settings/oidc", a.getOIDCSettings)
						r.Patch("/settings/oidc", a.patchOIDCSettings)
						r.Post("/settings/oidc/test", a.testOIDCSettings)
						r.Patch("/server", a.patchServer)
						r.Put("/deployment/profile", a.putDeploymentProfile)
						r.Put("/settings/dashboard", a.putDashboardSettings)
						r.Put("/settings/policy-push", a.putPolicyPush)
						r.Put("/settings/id-allow-list", a.putGlobalIDAllowList)
						r.Put("/settings/sessions", a.putSessionSettings)
						r.Put("/settings/log-export", a.putLogExport)
						r.Post("/devices/auto-sort/preview", a.autoSortPreview)
						r.Post("/devices/auto-sort", a.autoSort)
						r.Post("/settings/log-export/test", a.testLogExport)
					})
				})
			})
		})
	})

	// Registered before the /setup subrouter so that it stays outside its
	// guard: no token, and it keeps answering after setup completes.
	r.With(noStore).Get("/setup/status", a.setupStatus)
	r.Route("/setup", func(r chi.Router) {
		r.Use(noStore, a.setupAvailable, a.checkOrigin, a.setupGuard)
		r.NotFound(notFound)
		r.MethodNotAllowed(notFound)
		r.Post("/owner", a.setupOwner)
		r.Post("/owner/totp", a.setupOwnerTOTP)
		r.Post("/owner/totp/verify", a.setupVerifyOwnerTOTP)
		r.Post("/server", a.setupServer)
		r.Post("/complete", a.setupComplete)
	})

	if d.ClientRoutes != nil {
		r.Handle("/api/*", d.ClientRoutes)
		r.Handle("/healthz", d.ClientRoutes)
	}
	r.Handle("/*", a.uiHandler())
	return r
}
