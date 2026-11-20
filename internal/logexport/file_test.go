package logexport

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFileRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "events.jsonl")
	require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("x", 10<<20-10)), 0600))
	out := &FileOutput{Dir: dir}
	recs := []Record{{Message: "first"}, {Message: "second"}}
	require.NoError(t, out.Deliver(context.Background(), recs))
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, 2, strings.Count(string(got), "\n"), "records stay whole")
	_, err = os.Stat(path + ".1")
	require.NoError(t, err)
	for i := 0; i < 10; i++ {
		require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("x", 10<<20-10)), 0600))
		require.NoError(t, out.Deliver(context.Background(), recs))
	}
	for _, p := range []string{path, path + ".1", path + ".10"} {
		info, err := os.Stat(p)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0640), info.Mode().Perm())
	}
	_, err = os.Stat(path + ".11")
	require.True(t, os.IsNotExist(err))
}

func TestFileOutputRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	require.NoError(t, os.WriteFile(target, []byte("untouched"), 0600))
	link := filepath.Join(dir, "events.jsonl")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symlink on this system: %v", err)
	}
	out := &FileOutput{Dir: dir}
	err := out.Deliver(context.Background(), []Record{{Message: "secret"}})
	require.ErrorContains(t, err, "not a regular file")
	data, err := os.ReadFile(target)
	require.NoError(t, err)
	require.Equal(t, "untouched", string(data))
}
