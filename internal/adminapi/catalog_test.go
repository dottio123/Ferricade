package adminapi

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// placeSparse lays modules out as CSS grid auto-placement does without
// `dense` (the dashboard's grid): each item goes at the first free spot at or
// after the previous item's, row-major, never earlier. It returns the filled
// cells, row by row.
func placeSparse(t *testing.T, cols int, items []moduleSize) [][]bool {
	t.Helper()
	var grid [][]bool
	free := func(r, c, w, h int) bool {
		if c+w > cols {
			return false
		}
		for y := r; y < r+h; y++ {
			for x := c; x < c+w; x++ {
				if y < len(grid) && grid[y][x] {
					return false
				}
			}
		}
		return true
	}
	row, col := 0, 0
	for _, it := range items {
		require.LessOrEqual(t, it.Cols, cols)
		for !free(row, col, it.Cols, it.Rows) {
			if col++; col+it.Cols > cols {
				row, col = row+1, 0
			}
		}
		for len(grid) < row+it.Rows {
			grid = append(grid, make([]bool, cols))
		}
		for y := row; y < row+it.Rows; y++ {
			for x := col; x < col+it.Cols; x++ {
				grid[y][x] = true
			}
		}
		col += it.Cols
	}
	return grid
}

func sizeOf(t *testing.T, id, size string) moduleSize {
	t.Helper()
	for _, m := range dashboardModules {
		if m.ID != id {
			continue
		}
		for _, s := range m.Sizes {
			if s.Name == size {
				return s
			}
		}
	}
	t.Fatalf("no size %q for module %q", size, id)
	return moduleSize{}
}

// holes returns the rows of the laid-out grid that are not full.
func holes(grid [][]bool) []int {
	var out []int
	for r, cells := range grid {
		for _, filled := range cells {
			if !filled {
				out = append(out, r)
				break
			}
		}
	}
	return out
}

// A preset that leaves a hole shows a lone module beside an empty half row
// at the end of the page (Business did, with Platform mix). Checked on the
// 4-column grid and on the 2-column one (768–1023px), where index.css
// narrows 3- and 4-column modules to 2 and leaves the rest as they are.
func TestPresetsPackIntoFullRows(t *testing.T) {
	for _, p := range dashboardPresets {
		t.Run(p.ID, func(t *testing.T) {
			var four, two []moduleSize
			for _, m := range p.Modules {
				s := sizeOf(t, m.ID, m.Size)
				four = append(four, s)
				two = append(two, moduleSize{Cols: min(s.Cols, 2), Rows: s.Rows})
			}
			require.Empty(t, holes(placeSparse(t, 4, four)), "rows of %s with a hole, 4 columns", p.ID)
			require.Empty(t, holes(placeSparse(t, 2, two)), "rows of %s with a hole, 2 columns", p.ID)
		})
	}
}

func TestNeedsAttentionFollowsFleetPulse(t *testing.T) {
	for _, p := range dashboardPresets {
		needsAttention := -1
		fleetPulse := -1
		for i, m := range p.Modules {
			switch m.ID {
			case "fleet-pulse":
				fleetPulse = i
			case "needs-attention":
				needsAttention = i
			}
		}
		if needsAttention >= 0 {
			require.GreaterOrEqual(t, fleetPulse, 0, "%s: needs-attention requires fleet-pulse", p.ID)
			require.Equal(t, fleetPulse+1, needsAttention, "%s: needs-attention must follow fleet-pulse", p.ID)
		}
	}
}

// The checker itself finds a hole: a 1-column list before a 2-wide module
// leaves one on the 2-column grid.
func TestPlaceSparseFindsHoles(t *testing.T) {
	require.Equal(t, []int{0, 1}, holes(placeSparse(t, 2, []moduleSize{{Cols: 1, Rows: 2}, {Cols: 2, Rows: 2}})))
	require.Equal(t, []int{2, 3}, holes(placeSparse(t, 4, []moduleSize{{Cols: 4, Rows: 2}, {Cols: 2, Rows: 2}})))
	require.Empty(t, holes(placeSparse(t, 4, []moduleSize{{Cols: 2, Rows: 2}, {Cols: 2, Rows: 2}})))
}

// The wall is watched from a distance: it must show what is broken.
func TestWallPresetShowsNeedsAttention(t *testing.T) {
	for _, p := range dashboardPresets {
		if p.ID != "wall" {
			continue
		}
		var ids []string
		for _, m := range p.Modules {
			ids = append(ids, m.ID)
		}
		require.Contains(t, ids, "needs-attention")
		return
	}
	t.Fatal("no wall preset")
}
