// Package buildinfo holds build-time version metadata stamped into the binary.
package buildinfo

import "runtime/debug"

// Version is set at link time via:
// -ldflags "-X github.com/dottio123/ferricade/internal/buildinfo.Version=<v>"
var Version string

// Get returns the stamped Version if non-empty, otherwise the main module
// version from debug.ReadBuildInfo (excluding "(devel)"), or "dev".
func Get() string {
	if Version != "" {
		return Version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return bi.Main.Version
	}
	return "dev"
}
