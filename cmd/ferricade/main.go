// Command ferricade is the admin console and client API server.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // the distroless image has no zoneinfo; session stats need zones

	"github.com/dottio123/ferricade/internal/app"
	"github.com/dottio123/ferricade/internal/clientapi/recorder"
	"github.com/dottio123/ferricade/internal/config"
)

const usage = `usage: ferricade <command>

commands:
  serve    run the server (configured by environment variables)
  user     account recovery: ferricade user unlock|reset-totp|set-password <username>
  record   lab only: answer RustDesk clients minimally and log every request
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		serve()
	case "user":
		os.Exit(runUser(context.Background(), os.Args[2:], os.Getenv, os.Stdout, os.Stderr))
	case "record":
		record(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

// serve runs both listeners until SIGINT or SIGTERM, logging to stderr in the
// configured format and level. It exits 1 when the configuration is invalid or
// the server fails.
func serve() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(1)
	}

	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	var handler slog.Handler
	if cfg.LogFormat == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}
	logger := slog.New(handler)
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg, logger)
	if err != nil {
		logger.Error("startup failed", "err", err)
		os.Exit(1)
	}
	if err := a.Run(ctx); err != nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
	logger.Info("stopped")
}

func record(args []string) {
	fs := flag.NewFlagSet("record", flag.ExitOnError)
	listen := fs.String("listen", config.DefaultClientListenAddr, "listen address")
	out := fs.String("out", "captures.jsonl", "capture file (appended)")
	ver := fs.String("client-version", "", "RustDesk client version under test (required)")
	_ = fs.Parse(args)
	if *ver == "" {
		log.Fatal("--client-version is required")
	}
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	srv := &http.Server{
		Addr:              *listen,
		Handler:           recorder.New(f, *ver),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("recording client %s on %s to %s", *ver, *listen, *out)
	log.Fatal(srv.ListenAndServe())
}
