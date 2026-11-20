// Package web embeds the built admin web UI (web/dist) into the binary.
package web

import (
	"embed"
	"io/fs"
)

// dist holds the Vite build output. The directory always exists (it carries a
// .gitkeep) so the binary builds before the UI does; "all:" includes dotfiles.
//
//go:embed all:dist
var dist embed.FS

// Assets returns the built UI, rooted at dist, or false when dist/index.html is
// absent (the UI has not been built).
func Assets() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, false
	}
	return sub, true
}
