package contract

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LoadDir reads every *.json (one fixture) and *.jsonl (one per line) file
// directly in dir, in name order. Other files are ignored.
func LoadDir(dir string) ([]Fixture, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var out []Fixture
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !(strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".jsonl")) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(name, ".json") {
			var f Fixture
			if err := json.Unmarshal(b, &f); err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			out = append(out, f)
			continue
		}
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for n := 1; sc.Scan(); n++ {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) == 0 {
				continue
			}
			var f Fixture
			if err := json.Unmarshal(line, &f); err != nil {
				return nil, fmt.Errorf("%s:%d: %w", name, n, err)
			}
			out = append(out, f)
		}
		if err := sc.Err(); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
	}
	return out, nil
}
