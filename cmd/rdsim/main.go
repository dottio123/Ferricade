// Command rdsim simulates RustDesk devices heartbeating against a client API server.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"time"

	"github.com/dottio123/ferricade/internal/sim"
)

func main() {
	var o sim.Options
	flag.StringVar(&o.API, "api", "http://localhost:21114", "client API base URL")
	flag.IntVar(&o.Devices, "devices", 10, "number of simulated devices")
	flag.DurationVar(&o.Interval, "interval", 15*time.Second, "heartbeat interval")
	flag.IntVar(&o.IDBase, "id-base", 100000000, "first device ID")
	flag.StringVar(&o.Version, "client-version", "1.5.0", "simulated client version")
	flag.DurationVar(&o.SessionEvery, "sessions", 0, "open a simulated remote session about this often per device (0 = none)")
	flag.DurationVar(&o.SessionLength, "session-length", 30*time.Second, "how long each simulated session stays open")
	duration := flag.Duration("duration", time.Minute, "how long to run")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, *duration)
	defer cancel()

	st, err := sim.Run(ctx, o)
	if err != nil {
		log.Fatal(err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(st)
}
