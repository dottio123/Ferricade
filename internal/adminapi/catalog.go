package adminapi

// The dashboard's module catalog and presets. This is the one definition: the
// catalog endpoint serves it and preference validation and normalisation use
// it, so the UI never carries its own copy.
//
// The dashboard is a 4-column grid of fixed-height rows. Each module offers
// its own sizes as columns x rows, so a module with more to show (a trend,
// the fleet) can grow larger than a list.

type moduleSize struct {
	Name string `json:"name"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type catalogModule struct {
	ID          string       `json:"id"`
	DefaultSize string       `json:"default_size"`
	Sizes       []moduleSize `json:"sizes"`
}

type presetModule struct {
	ID   string `json:"id"`
	Size string `json:"size"`
}

type catalogPreset struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Modules []presetModule `json:"modules"`
}

var (
	// Fleet pulse is four numbers: there is nothing to fill a larger box.
	pulseSizes = []moduleSize{{"small", 2, 1}, {"medium", 4, 1}}
	listSizes  = []moduleSize{{"small", 1, 2}, {"medium", 2, 2}, {"large", 2, 3}}
	bigSizes   = []moduleSize{{"small", 2, 2}, {"medium", 4, 2}, {"large", 4, 3}}
	mixSizes   = []moduleSize{{"small", 1, 2}, {"medium", 2, 2}}
)

// dashboardModules is in canonical order.
var dashboardModules = []catalogModule{
	{"fleet-pulse", "medium", pulseSizes},
	{"quick-connect", "medium", listSizes},
	{"approval-queue", "medium", listSizes},
	{"needs-attention", "medium", listSizes},
	{"live-sessions", "medium", listSizes},
	{"activity-trend", "medium", bigSizes},
	{"fleet-overview", "medium", bigSizes},
	{"recent-sessions", "medium", listSizes},
	{"session-analytics", "small", bigSizes},
	{"platform-mix", "medium", mixSizes},
	{"admin-activity", "medium", listSizes},
}

// The presets are ordered so their modules pack into full rows
// (TestPresetsPackIntoFullRows). What needs the admin comes first; the wall
// shows what is broken and fits one screen (seven rows).
var dashboardPresets = []catalogPreset{
	{"homelab", "Homelab", []presetModule{
		{"fleet-pulse", "medium"}, {"needs-attention", "medium"}, {"quick-connect", "medium"},
		{"live-sessions", "medium"}, {"recent-sessions", "medium"}, {"fleet-overview", "medium"},
	}},
	{"business", "Business", []presetModule{
		{"fleet-pulse", "medium"}, {"needs-attention", "medium"}, {"approval-queue", "medium"},
		{"live-sessions", "medium"}, {"fleet-overview", "small"}, {"activity-trend", "medium"},
		{"admin-activity", "medium"}, {"platform-mix", "medium"},
	}},
	{"wall", "Monitoring wall", []presetModule{
		{"fleet-pulse", "medium"}, {"needs-attention", "medium"}, {"live-sessions", "medium"},
		{"fleet-overview", "medium"}, {"activity-trend", "medium"},
	}},
}

// defaultPreset is what an admin sees until they save something.
const defaultPreset = "business"

func findModule(id string) (catalogModule, bool) {
	for _, m := range dashboardModules {
		if m.ID == id {
			return m, true
		}
	}
	return catalogModule{}, false
}

func isModuleID(id string) bool {
	_, ok := findModule(id)
	return ok
}

// offersSize reports whether module id can be shown at size.
func offersSize(id, size string) bool {
	m, ok := findModule(id)
	if !ok {
		return false
	}
	for _, s := range m.Sizes {
		if s.Name == size {
			return true
		}
	}
	return false
}

func findPreset(id string) (catalogPreset, bool) {
	for _, p := range dashboardPresets {
		if p.ID == id {
			return p, true
		}
	}
	return catalogPreset{}, false
}
