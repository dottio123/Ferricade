package grouprules_test

import (
	"strings"
	"testing"
	"time"

	"github.com/dottio123/ferricade/internal/grouprules"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestMatch(t *testing.T) {
	for _, tt := range []struct {
		pattern, name string
		want          bool
	}{
		{"w-*-it-*", "w-sf-it-5CG1234", true}, {"w-*-it-*", "xw-sf-it-1", false},
		{"w-*-it-*", "W-SF-IT-1", true}, {"w-??-it-*", "w-sf-it-1", true},
		{"w-??-it-*", "w-s-it-1", false}, {"*", "anything", true}, {"*", "", false},
		{"a?c", "aüC", true}, {"a*b*c", "abbbc", true}, {"a*b", "abx", false},
		{"a**?", "ab", true}, {"abc*", "abc", true}, {"", "abc", false},
	} {
		t.Run(tt.pattern+"/"+tt.name, func(t *testing.T) { require.Equal(t, tt.want, grouprules.Match(tt.pattern, tt.name)) })
	}
}

func TestValid(t *testing.T) {
	for _, p := range []string{"", strings.Repeat("a", 129), "w-*-it-[1]", "a b", "ü"} {
		err := grouprules.Valid(p)
		require.Error(t, err)
		require.Contains(t, err.Error(), "pattern")
	}
	for _, p := range []string{"w-*-it-*", "A_z.0-?", strings.Repeat("a", 128)} {
		require.NoError(t, grouprules.Valid(p))
	}
}

func TestCandidates(t *testing.T) {
	a, b := uuid.MustParse("00000000-0000-0000-0000-000000000001"), uuid.MustParse("00000000-0000-0000-0000-000000000002")
	require.Equal(t, []uuid.UUID{a, b}, grouprules.Candidates([]grouprules.Rule{{GroupID: b, Pattern: "*"}, {GroupID: a, Pattern: "w-*"}, {GroupID: b, Pattern: "w-*"}}, "w-it"))
}

func TestMatchPathologicalIsFast(t *testing.T) {
	name := strings.Repeat("a", 128)
	start := time.Now()
	matched := false
	for i := 0; i < 10000; i++ {
		matched = matched || grouprules.Match("*a*a*a*a*a*a*a*a*b", name)
	}
	require.False(t, matched)
	require.Less(t, time.Since(start), 10*time.Millisecond)
}
