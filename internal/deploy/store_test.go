package deploy

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

func TestDeploymentStoreSecretsAndCatalogDrift(t *testing.T) {
	pool := store.NewTestDB(t)
	q := db.New(pool)
	ctx := context.Background()
	key, err := auth.NewSealer([]byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	other, err := auth.NewSealer([]byte("abcdef0123456789abcdef0123456789"))
	require.NoError(t, err)
	initial, err := Load(ctx, q)
	require.NoError(t, err)
	require.Equal(t, "github", initial.Profile.InstallerSource)
	require.Nil(t, initial.UpdatedAt)
	actor := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO users (id, username, display_name, role, password_hash) VALUES ($1,'owner','Owner','owner','hash')`, actor)
	require.NoError(t, err)
	password, pin := "Password123", "1234"
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	p := initial.Profile
	p.IncludePassword, p.IncludeUnlockPIN = true, true
	require.NoError(t, Save(ctx, q, key, actor, p, SecretChange{Value: &password}, SecretChange{Value: &pin}, now))
	saved, err := Load(ctx, q)
	require.NoError(t, err)
	require.True(t, saved.Password.Set)
	require.True(t, saved.UnlockPIN.Set)
	secrets, err := LoadSecrets(ctx, q, key)
	require.NoError(t, err)
	require.Equal(t, password, *secrets.Password)
	require.Equal(t, pin, *secrets.UnlockPIN)
	var pinCiphertext []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT unlock_pin_enc FROM deployment_profile`).Scan(&pinCiphertext))
	_, err = key.OpenWithAAD(pinCiphertext, passwordAAD)
	require.Error(t, err)
	wrongAADPlaintext, err := key.OpenWithAAD(pinCiphertext, pinAAD)
	require.NoError(t, err)
	require.Equal(t, pin, string(wrongAADPlaintext))
	secrets, err = LoadSecrets(ctx, q, other)
	require.NoError(t, err)
	require.Nil(t, secrets.Password)
	require.Nil(t, secrets.UnlockPIN)
	require.True(t, secrets.PasswordUnreadable)
	require.True(t, secrets.PINUnreadable)
	require.NoError(t, Save(ctx, q, key, actor, p, SecretChange{Keep: true}, SecretChange{Keep: true}, now.Add(time.Hour)))
	secrets, err = LoadSecrets(ctx, q, key)
	require.NoError(t, err)
	require.Equal(t, password, *secrets.Password)
	_, err = pool.Exec(ctx, `UPDATE deployment_profile SET settings = '{"removed_key":{"include":true,"value":"Y"}}'`)
	require.NoError(t, err)
	stale, err := Load(ctx, q)
	require.NoError(t, err)
	require.Contains(t, stale.Profile.Settings, "removed_key")
	require.NoError(t, Save(ctx, q, key, actor, stale.Profile, SecretChange{Keep: true}, SecretChange{Keep: true}, now.Add(2*time.Hour)))
	clean, err := Load(ctx, q)
	require.NoError(t, err)
	require.NotContains(t, clean.Profile.Settings, "removed_key")
	require.NoError(t, Save(ctx, q, key, actor, p, SecretChange{}, SecretChange{}, now.Add(3*time.Hour)))
	removed, err := Load(ctx, q)
	require.NoError(t, err)
	require.False(t, removed.Password.Set)
	require.False(t, removed.UnlockPIN.Set)
	require.False(t, removed.Profile.IncludeIDAllowList)

	p.IncludeIDAllowList = true
	require.NoError(t, Save(ctx, q, key, actor, p, SecretChange{Keep: true}, SecretChange{Keep: true}, now.Add(4*time.Hour)))
	withAllowList, err := Load(ctx, q)
	require.NoError(t, err)
	require.True(t, withAllowList.Profile.IncludeIDAllowList)
}
