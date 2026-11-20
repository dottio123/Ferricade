package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/store/db"
)

var passwordAAD = []byte("ferricade/deployment/fleet-password")
var pinAAD = []byte("ferricade/deployment/unlock-pin")

type SecretState struct {
	Set   bool
	SetAt *time.Time
	SetBy *uuid.UUID
}

type Stored struct {
	Profile             Profile
	Password, UnlockPIN SecretState
	UpdatedAt           *time.Time
}

type SecretChange struct {
	Keep  bool
	Value *string
}

func defaultProfile() Profile {
	return Profile{InstallerSource: "github", ClientVersion: "latest", IncludeInstall: true, Settings: map[string]SettingValue{}}
}

func fromRow(row db.DeploymentProfile) (Stored, error) {
	p := Profile{
		InstallerSource: row.InstallerSource, ClientVersion: row.ClientVersion,
		URLWindows: row.UrlWindows, URLDeb: row.UrlDeb, URLRPM: row.UrlRpm,
		SHA256Windows: row.Sha256Windows, SHA256Deb: row.Sha256Deb, SHA256RPM: row.Sha256Rpm,
		AllowDowngrade: row.AllowDowngrade, IncludeInstall: row.IncludeInstall,
		IncludePassword: row.IncludePassword, IncludeUnlockPIN: row.IncludeUnlockPin,
		IncludeIDAllowList: row.IncludeIDAllowList,
		Settings:           map[string]SettingValue{},
	}
	if err := json.Unmarshal(row.Settings, &p.Settings); err != nil {
		return Stored{}, fmt.Errorf("decode deployment settings: %w", err)
	}
	return Stored{Profile: p,
		Password:  SecretState{Set: len(row.FleetPasswordEnc) > 0, SetAt: row.PasswordSetAt, SetBy: row.PasswordSetBy},
		UnlockPIN: SecretState{Set: len(row.UnlockPinEnc) > 0, SetAt: row.PinSetAt, SetBy: row.PinSetBy},
		UpdatedAt: &row.UpdatedAt,
	}, nil
}

func Load(ctx context.Context, q *db.Queries) (Stored, error) {
	row, err := q.GetDeploymentProfile(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return Stored{Profile: defaultProfile()}, nil
	}
	if err != nil {
		return Stored{}, fmt.Errorf("load deployment profile: %w", err)
	}
	return fromRow(row)
}

// Save uses the caller's transaction so profile changes and audit events commit together.
func Save(ctx context.Context, q *db.Queries, sealer *auth.Sealer, actor uuid.UUID, p Profile, pw, pin SecretChange, now time.Time) error {
	row, err := q.GetDeploymentProfileForUpdate(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock deployment profile: %w", err)
	}
	for key := range p.Settings {
		if _, known := Lookup(key); known {
			continue
		}
		var old map[string]SettingValue
		if len(row.Settings) != 0 {
			if err := json.Unmarshal(row.Settings, &old); err != nil {
				return fmt.Errorf("decode stored deployment settings: %w", err)
			}
		}
		if _, stale := old[key]; stale {
			delete(p.Settings, key)
		}
	}
	if err := Validate(p); err != nil {
		return err
	}
	if !pw.Keep && pw.Value != nil {
		if err := ValidatePassword(*pw.Value); err != nil {
			return err
		}
	}
	if !pin.Keep && pin.Value != nil {
		if err := ValidateUnlockPIN(*pin.Value); err != nil {
			return err
		}
	}
	change := func(c SecretChange, existing []byte, at *time.Time, by *uuid.UUID, aad []byte) ([]byte, *time.Time, *uuid.UUID, error) {
		if c.Keep {
			return existing, at, by, nil
		}
		if c.Value == nil {
			return nil, nil, nil, nil
		}
		sealed, err := sealer.SealWithAAD([]byte(*c.Value), aad)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("seal deployment secret: %w", err)
		}
		return sealed, &now, &actor, nil
	}
	passwordEnc, passwordAt, passwordBy, err := change(pw, row.FleetPasswordEnc, row.PasswordSetAt, row.PasswordSetBy, passwordAAD)
	if err != nil {
		return err
	}
	pinEnc, pinAt, pinBy, err := change(pin, row.UnlockPinEnc, row.PinSetAt, row.PinSetBy, pinAAD)
	if err != nil {
		return err
	}
	settings, err := json.Marshal(p.Settings)
	if err != nil {
		return fmt.Errorf("encode deployment settings: %w", err)
	}
	if err := q.SaveDeploymentProfile(ctx, db.SaveDeploymentProfileParams{
		InstallerSource: p.InstallerSource, ClientVersion: p.ClientVersion,
		UrlWindows: p.URLWindows, UrlDeb: p.URLDeb, UrlRpm: p.URLRPM,
		Sha256Windows: p.SHA256Windows, Sha256Deb: p.SHA256Deb, Sha256Rpm: p.SHA256RPM,
		AllowDowngrade: p.AllowDowngrade, IncludeInstall: p.IncludeInstall,
		IncludePassword: p.IncludePassword, IncludeUnlockPin: p.IncludeUnlockPIN,
		IncludeIDAllowList: p.IncludeIDAllowList,
		Settings:           settings, FleetPasswordEnc: passwordEnc, UnlockPinEnc: pinEnc,
		PasswordSetAt: passwordAt, PasswordSetBy: passwordBy, PinSetAt: pinAt, PinSetBy: pinBy,
		UpdatedAt: now, UpdatedBy: &actor,
	}); err != nil {
		return fmt.Errorf("save deployment profile: %w", err)
	}
	return nil
}

func LoadSecrets(ctx context.Context, q *db.Queries, sealer *auth.Sealer) (Secrets, error) {
	row, err := q.GetDeploymentProfile(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return Secrets{}, nil
	}
	if err != nil {
		return Secrets{}, fmt.Errorf("load deployment secrets: %w", err)
	}
	open := func(ciphertext, aad []byte) (*string, bool) {
		if len(ciphertext) == 0 {
			return nil, false
		}
		plain, err := sealer.OpenWithAAD(ciphertext, aad)
		if err != nil {
			return nil, true
		}
		value := string(plain)
		return &value, false
	}
	password, passwordUnreadable := open(row.FleetPasswordEnc, passwordAAD)
	pin, pinUnreadable := open(row.UnlockPinEnc, pinAAD)
	return Secrets{Password: password, UnlockPIN: pin, PasswordUnreadable: passwordUnreadable, PINUnreadable: pinUnreadable}, nil
}
