package buildinfo

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGet(t *testing.T) {
	orig := Version
	t.Cleanup(func() { Version = orig })

	Version = ""
	require.Equal(t, "dev", Get())

	Version = "1.2.3"
	require.Equal(t, "1.2.3", Get())
}
