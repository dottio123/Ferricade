// Package app wires ferricade together: the database, the services, the online
// tracker and the two HTTP listeners (client API and admin console).
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dottio123/ferricade/internal/adminapi"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/buildinfo"
	"github.com/dottio123/ferricade/internal/clientapi"
	"github.com/dottio123/ferricade/internal/config"
	"github.com/dottio123/ferricade/internal/devices"
	"github.com/dottio123/ferricade/internal/events"
	"github.com/dottio123/ferricade/internal/idalarms"
	"github.com/dottio123/ferricade/internal/logexport"
	"github.com/dottio123/ferricade/internal/policies"
	"github.com/dottio123/ferricade/internal/rendezvous"
	"github.com/dottio123/ferricade/internal/servers"
	"github.com/dottio123/ferricade/internal/sessions"
	"github.com/dottio123/ferricade/internal/setup"
	"github.com/dottio123/ferricade/internal/stats"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
	"github.com/dottio123/ferricade/web"
)

// Timings of the listeners (spec, "Server timeouts") and of the app itself.
const (
	clientReadHeaderTimeout = 5 * time.Second
	clientReadTimeout       = 10 * time.Second
	clientWriteTimeout      = 10 * time.Second
	clientIdleTimeout       = 60 * time.Second

	adminReadHeaderTimeout = 5 * time.Second
	adminReadTimeout       = 30 * time.Second
	adminWriteTimeout      = 30 * time.Second
	adminIdleTimeout       = 120 * time.Second

	// shutdownTimeout is how long in-flight requests get to finish.
	shutdownTimeout = 10 * time.Second
	// insecureWarnEvery repeats the ALLOW_HTTP warning.
	insecureWarnEvery = 10 * time.Minute
	// setupPollEvery is how often, before setup completes, the app checks
	// whether it has, to start the online tracker.
	setupPollEvery = 2 * time.Second
	// lookupTimeout bounds one setup-state lookup made for a client request.
	lookupTimeout = 5 * time.Second
	// hbbsQueryTimeout bounds one online query to hbbs, so a silent hbbs
	// cannot stall the tracker's probe.
	hbbsQueryTimeout = 10 * time.Second

	// onlineQueueSize is how many online changes may wait for their device
	// lookup before further ones are dropped.
	onlineQueueSize = 1024
)

// App is a configured ferricade: its database pool, services and handlers. The
// online tracker and server monitor run from New until Close.
type App struct {
	cfg      config.Config
	log      *slog.Logger
	pool     *pgxpool.Pool
	state    *setupState
	tracker  *devices.Tracker
	remote   *sessions.Service
	policies *policies.Service
	idAlarms *idalarms.Service
	export   *logexport.Service
	monitor  *servers.Monitor
	client   http.Handler
	admin    http.Handler

	setupToken string // issued at startup when setup was incomplete

	hub    *events.Hub
	online *events.TrackerBridge // publishes the tracker's changes to hub

	stop        context.CancelFunc // ends the tracker and the event listener
	done        chan struct{}      // closed when the tracker has stopped
	listenDone  chan struct{}      // closed when the event listener has stopped
	monitorDone chan struct{}      // closed when server monitoring has stopped
	closeOnce   sync.Once
}

// New opens and migrates the database, builds the services and both
// handlers, and starts the event listener and the online tracker (once setup
// is complete). When setup is not complete it issues a setup token and logs
// it once, at WARN. It refuses an http PUBLIC_URL unless cfg.DevInsecure is set.
func New(ctx context.Context, cfg config.Config, log *slog.Logger) (*App, error) {
	if log == nil {
		log = slog.Default()
	}
	if err := checkConfig(cfg); err != nil {
		return nil, err
	}
	cfg = withDefaults(cfg)
	sealer, err := auth.NewSealer(cfg.SecretKey)
	if err != nil {
		return nil, fmt.Errorf("SECRET_KEY: %w", err)
	}

	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	before, after, err := store.MigrateVersion(ctx, pool)
	if err != nil {
		pool.Close()
		return nil, err
	}
	connCfg := pool.Config().ConnConfig
	log.Info("database ready",
		"host", connCfg.Host,
		"database", connCfg.Database,
		"migrations_from", before,
		"migrations_to", after)

	setupSvc := &setup.Service{Pool: pool, Sealer: sealer, Params: auth.DefaultParams}
	a := &App{
		cfg:     cfg,
		log:     log,
		pool:    pool,
		state:   newSetupState(setupSvc, log),
		tracker: devices.NewTracker(time.Now),
		hub:     events.NewHub(),

		done:        make(chan struct{}),
		listenDone:  make(chan struct{}),
		monitorDone: make(chan struct{}),
	}
	a.tracker.Log = log
	// Registered before any heartbeat can reach the tracker, so no change is
	// missed; they queue until startTracker publishes them.
	a.online = events.NewTrackerBridge(a.hub, onlineQueueSize)
	a.tracker.OnChange(a.online.OnChange)

	complete, err := setupSvc.Complete(ctx)
	if err != nil {
		pool.Close()
		return nil, err
	}
	log.Info("starting ferricade",
		"version", buildinfo.Get(),
		"client_addr", cfg.ClientListenAddr,
		"admin_addr", cfg.AdminListenAddr,
		"public_url", cfg.PublicURL.String(),
		"log_level", strings.ToLower(cfg.LogLevel.String()),
		"log_format", cfg.LogFormat,
		"setup_complete", complete,
		"trusted_proxies", len(cfg.TrustedProxies),
		"dev_insecure", cfg.DevInsecure)
	var guard *setup.Guard
	if !complete {
		a.setupToken, guard = setup.NewGuard(nil)
		base := strings.TrimRight(cfg.PublicURL.String(), "/")
		log.Warn("setup token: "+a.setupToken,
			"setup_url", base+"/first-run",
			"setup_api_base", base+"/setup",
			"hint", "open setup_url in a browser and paste this token into the setup wizard; scripts can instead send it "+
				`as the X-Setup-Token header to setup_api_base (README.md, section "Complete setup"); `+
				"it is valid for 24 h and a restart issues a new one")
	} else if srv, err := db.New(pool).GetServer(ctx); err == nil && strings.TrimSpace(srv.PublicKey) == "" {
		log.Warn("server public key is not set; clients cannot verify the server until it is configured")
	}
	if cfg.DevInsecure {
		a.warnInsecure()
	}

	devicesSvc := &devices.Service{Pool: pool, Beats: a.tracker, MaxPending: cfg.MaxPendingDevices, Log: log}
	sessionsSvc := &sessions.Service{Pool: pool}
	policiesSvc := &policies.Service{Pool: pool}
	idAlarmsSvc := &idalarms.Service{Pool: pool}
	exportSvc := &logexport.Service{Pool: pool, Log: log, Dir: cfg.LogExportDir, Host: cfg.PublicURL.Hostname()}
	a.remote = sessionsSvc
	a.policies = policiesSvc
	a.idAlarms = idAlarmsSvc
	a.export = exportSvc
	a.monitor = &servers.Monitor{Log: log, HBBSAddr: cfg.HBBSAddr,
		ClientListenAddr: cfg.ClientListenAddr}
	// One client router serves both listeners, so they share its rate limiter.
	clientRoutes := clientapi.Routes(clientapi.Deps{
		Devices: devicesSvc, Sessions: sessionsSvc, Policies: policiesSvc, IDAlarms: idAlarmsSvc,
		Setup: a.state, Trusted: cfg.TrustedProxies, Log: log,
	})
	a.client = clientRoutes
	ui, _ := web.Assets() // nil when the UI is not built; the admin listener then serves a placeholder
	a.admin = adminapi.New(adminapi.Deps{
		Cfg:            cfg,
		Pool:           pool,
		Sessions:       &auth.Sessions{},
		IPLimiter:      auth.NewIPLimiter(nil),
		Sealer:         sealer,
		Params:         auth.DefaultParams,
		Setup:          setupSvc,
		Guard:          guard,
		Devices:        devicesSvc,
		Policies:       policiesSvc,
		LogExport:      exportSvc,
		Tracker:        a.tracker,
		Hub:            a.hub,
		RemoteSessions: sessionsSvc,
		ServerMonitor:  a.monitor,
		ClientRoutes:   clientRoutes,
		UI:             ui,
		QueryOnline:    rendezvous.QueryOnline,
		Log:            log,
	})

	runCtx, stop := context.WithCancel(context.WithoutCancel(ctx))
	a.stop = stop
	go func() {
		defer close(a.listenDone)
		events.Listen(runCtx, pool, a.hub, log)
	}()
	go a.runTracker(runCtx)
	go func() {
		defer close(a.monitorDone)
		a.monitor.Run(runCtx, func(ctx context.Context) (string, string, string, bool, error) {
			complete, err := setupSvc.Complete(ctx)
			if err != nil || !complete {
				return "", "", "", false, err
			}
			srv, err := db.New(pool).GetServer(ctx)
			if err != nil {
				return "", "", "", false, fmt.Errorf("get server profile: %w", err)
			}
			return srv.IDHost, srv.RelayHost, srv.ApiUrl, true, nil
		})
	}()
	return a, nil
}

// checkConfig refuses what the admin listener must never run with. config.Load
// checks the same; New is also called with hand-built configs.
func checkConfig(cfg config.Config) error {
	if cfg.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if cfg.PublicURL == nil || cfg.PublicURL.Host == "" {
		return errors.New("PUBLIC_URL is required")
	}
	switch cfg.PublicURL.Scheme {
	case "https":
	case "http":
		if !cfg.DevInsecure {
			return errors.New("PUBLIC_URL uses http: use https, or set ALLOW_HTTP=1 for a LAN-only install")
		}
	default:
		return fmt.Errorf("PUBLIC_URL %q must be an https URL", cfg.PublicURL)
	}
	return nil
}

// withDefaults fills the settings config.Load defaults, for hand-built configs.
func withDefaults(cfg config.Config) config.Config {
	if cfg.ClientListenAddr == "" {
		cfg.ClientListenAddr = config.DefaultClientListenAddr
	}
	if cfg.AdminListenAddr == "" {
		cfg.AdminListenAddr = config.DefaultAdminListenAddr
	}
	if cfg.MaxPendingDevices < 1 {
		cfg.MaxPendingDevices = config.DefaultMaxPending
	}
	if cfg.LogExportDir == "" {
		cfg.LogExportDir = "/var/log/ferricade"
	}
	if cfg.LogFormat == "" {
		cfg.LogFormat = "text"
	}
	return cfg
}

// ClientHandler serves the client API (the client listener).
func (a *App) ClientHandler() http.Handler { return a.client }

// AdminHandler serves the admin API, the setup wizard and, for clients that
// use an https API URL through the reverse proxy, the client API.
func (a *App) AdminHandler() http.Handler { return a.admin }

// SetupToken returns the setup token issued at startup, or "" once setup is
// complete. It exists for tests; the token is otherwise only logged.
func (a *App) SetupToken() string {
	if _, done := a.state.ServerID(); done {
		return ""
	}
	return a.setupToken
}

// Run serves the client and admin listeners until ctx ends or one of them
// fails. It then stops accepting connections, ends the event streams, gives
// in-flight requests 10 s to finish, and calls Close, which flushes the online tracker one last time.
// It returns nil after a clean shutdown and the listener's error otherwise.
func (a *App) Run(ctx context.Context) error {
	defer a.Close()

	clientSrv := &http.Server{
		Addr:              a.cfg.ClientListenAddr,
		Handler:           a.client,
		ReadHeaderTimeout: clientReadHeaderTimeout,
		ReadTimeout:       clientReadTimeout,
		WriteTimeout:      clientWriteTimeout,
		IdleTimeout:       clientIdleTimeout,
		ErrorLog:          slog.NewLogLogger(a.log.With("listener", "client").Handler(), slog.LevelWarn),
	}
	adminSrv := &http.Server{
		Addr:              a.cfg.AdminListenAddr,
		Handler:           a.admin,
		ReadHeaderTimeout: adminReadHeaderTimeout,
		ReadTimeout:       adminReadTimeout,
		WriteTimeout:      adminWriteTimeout,
		IdleTimeout:       adminIdleTimeout,
		ErrorLog:          slog.NewLogLogger(a.log.With("listener", "admin").Handler(), slog.LevelWarn),
	}
	// Shutdown waits for handlers to return, and an event stream only returns
	// when its subscription ends: end them all (each is told to resync), and
	// any opened while the listener drains.
	adminSrv.RegisterOnShutdown(a.hub.Close)

	clientLn, err := net.Listen("tcp", clientSrv.Addr)
	if err != nil {
		return fmt.Errorf("client listener: %w", err)
	}
	adminLn, err := adminListen(adminSrv.Addr)
	if err != nil {
		clientLn.Close()
		return fmt.Errorf("admin listener: %w", err)
	}
	a.log.Info("listening",
		"client_addr", clientLn.Addr().String(), "admin_addr", adminLn.Addr().String(),
		"public_url", a.cfg.PublicURL.String())

	errc := make(chan error, 2)
	serve := func(name string, srv *http.Server, ln net.Listener) {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("%s listener: %w", name, err)
			return
		}
		errc <- nil
	}
	go serve("client", clientSrv, clientLn)
	go serve("admin", adminSrv, adminLn)

	var warn <-chan time.Time
	if a.cfg.DevInsecure {
		t := time.NewTicker(insecureWarnEvery)
		defer t.Stop()
		warn = t.C
	}

	var runErr error
wait:
	for {
		select {
		case <-ctx.Done():
			a.log.Info("shutting down")
			break wait
		case runErr = <-errc:
			a.log.Error("listener failed; shutting down", "err", runErr)
			break wait
		case <-warn:
			a.warnInsecure()
		}
	}

	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := errors.Join(clientSrv.Shutdown(sctx), adminSrv.Shutdown(sctx)); err != nil {
		a.log.Warn("shutdown: requests still running after the drain period", "err", err)
	}
	return runErr
}

// Hub is the app's live event hub. It exists for tests and the event stream.
func (a *App) Hub() *events.Hub { return a.hub }

// Close stops the online tracker, which flushes last_seen_at one last time,
// and the event listener, then closes the database pool. It is safe to call
// more than once.
func (a *App) Close() {
	a.closeOnce.Do(func() {
		a.stop()
		<-a.done
		<-a.listenDone
		<-a.monitorDone
		a.pool.Close()
	})
}

func (a *App) warnInsecure() {
	a.log.Warn("ALLOW_HTTP=1: the admin console is served over plain HTTP; logins and session cookies are not encrypted on the network")
}

// runTracker waits until setup is complete (the tracker needs the server
// profile), then runs the online tracker until ctx ends.
func (a *App) runTracker(ctx context.Context) {
	defer close(a.done)
	poll := time.NewTicker(setupPollEvery)
	defer poll.Stop()
	for {
		if serverID, ok := a.state.ServerID(); ok {
			a.startTracker(ctx, serverID)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-a.state.ready:
		case <-poll.C:
		}
	}
}

func (a *App) startTracker(ctx context.Context, serverID uuid.UUID) {
	approved := func(ctx context.Context) ([]string, error) {
		return db.New(a.pool).ListApprovedRustdeskIDs(ctx, serverID)
	}
	var query func(ctx context.Context, ids []string) (map[string]bool, error)
	if a.cfg.HBBSAddr != "" {
		query = func(ctx context.Context, ids []string) (map[string]bool, error) {
			ctx, cancel := context.WithTimeout(ctx, hbbsQueryTimeout)
			defer cancel()
			return rendezvous.QueryOnline(ctx, a.cfg.HBBSAddr, ids)
		}
	}
	a.log.Info("online tracker started", "server_id", serverID.String(), "hbbs_probe", a.cfg.HBBSAddr != "")
	// The snapshotter lives as long as the tracker and is waited for with it,
	// so Close never closes the pool under it.
	snap := &stats.Snapshotter{
		Pool: a.pool, Online: a.tracker.Online, CloseStale: a.remote.CloseStale, Log: a.log,
	}
	var wg sync.WaitGroup
	wg.Add(5)
	go func() {
		defer wg.Done()
		snap.Run(ctx, serverID)
	}()
	go func() {
		defer wg.Done()
		a.export.Run(ctx)
	}()
	go func() {
		defer wg.Done()
		a.online.Run(ctx, a.deviceIDResolver(serverID), a.log)
	}()
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				start := time.Now()
				if err := a.policies.SweepExpired(ctx); err != nil && ctx.Err() == nil {
					a.log.Error("access window sweep", "err", err)
				} else if err == nil {
					a.log.Debug("access window sweep", "duration_ms", time.Since(start).Milliseconds())
				}
				start = time.Now()
				if err := a.idAlarms.SweepExpired(ctx); err != nil && ctx.Err() == nil {
					a.log.Error("blocked ID alarm sweep", "err", err)
				} else if err == nil {
					a.log.Debug("blocked ID alarm sweep", "duration_ms", time.Since(start).Milliseconds())
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		a.runStatus(ctx)
	}()
	a.tracker.Run(ctx, a.pool, serverID, approved, query)
	wg.Wait()
}

const (
	statusInitialDelay = 1 * time.Minute
	statusEvery        = 15 * time.Minute
)

func (a *App) runStatus(ctx context.Context) {
	initial := time.NewTimer(statusInitialDelay)
	defer initial.Stop()
	select {
	case <-ctx.Done():
		return
	case <-initial.C:
		a.LogStatus(ctx)
	}
	ticker := time.NewTicker(statusEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.LogStatus(ctx)
		}
	}
}

// LogStatus logs a single INFO status line with fleet counts.
func (a *App) LogStatus(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	q := db.New(a.pool)
	counts, err := q.CountDevicesByState(ctx)
	if err != nil {
		if ctx.Err() == nil {
			a.log.Error("status: count devices", "err", err)
		}
		return
	}
	var total, pending int32
	for _, c := range counts {
		total += c.Count
		if c.State == devices.StatePending {
			pending = c.Count
		}
	}
	online := 0
	if serverID, ok := a.state.ServerID(); ok {
		approvedIDs, err := q.ListApprovedRustdeskIDs(ctx, serverID)
		if err != nil {
			if ctx.Err() == nil {
				a.log.Error("status: list approved devices", "err", err)
			}
			return
		}
		for _, id := range approvedIDs {
			if a.tracker.Online(id) {
				online++
			}
		}
	}
	openSessions, err := q.CountOpenSessionsOfAllApproved(ctx, nil)
	if err != nil {
		if ctx.Err() == nil {
			a.log.Error("status: count open sessions", "err", err)
		}
		return
	}
	a.log.Info("status",
		"devices_total", total,
		"devices_online", online,
		"devices_pending", pending,
		"open_sessions", openSessions)
}

// deviceIDResolver looks up device IDs for the tracker bridge.
func (a *App) deviceIDResolver(serverID uuid.UUID) events.Resolver {
	q := db.New(a.pool)
	return func(ctx context.Context, rustdeskID string) (string, bool, error) {
		ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
		defer cancel()
		id, err := q.GetDeviceIDByRustdeskID(ctx, db.GetDeviceIDByRustdeskIDParams{ServerID: serverID, RustdeskID: rustdeskID})
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		if err != nil {
			return "", false, err
		}
		return id.String(), true, nil
	}
}

// setupState is the client API's view of setup. It asks the database until
// setup is complete, then caches the server ID: setup never reverts, so after
// that no request costs a query.
type setupState struct {
	svc *setup.Service
	log *slog.Logger

	id        atomic.Pointer[uuid.UUID]
	ready     chan struct{} // closed once the server ID is cached
	readyOnce sync.Once
}

func newSetupState(svc *setup.Service, log *slog.Logger) *setupState {
	return &setupState{svc: svc, log: log, ready: make(chan struct{})}
}

// ServerID implements clientapi.SetupState.
func (s *setupState) ServerID() (uuid.UUID, bool) {
	if id := s.id.Load(); id != nil {
		return *id, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	id, ok, err := s.svc.ServerID(ctx)
	if err != nil {
		s.log.Error("setup state lookup", "err", err)
		return uuid.Nil, false
	}
	if !ok {
		return uuid.Nil, false
	}
	s.id.Store(&id)
	s.readyOnce.Do(func() { close(s.ready) })
	return id, true
}
