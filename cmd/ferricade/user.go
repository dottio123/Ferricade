package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dottio123/ferricade/internal/audit"
	"github.com/dottio123/ferricade/internal/auth"
	"github.com/dottio123/ferricade/internal/recovery"
	"github.com/dottio123/ferricade/internal/store"
	"github.com/dottio123/ferricade/internal/store/db"
)

const userUsage = `usage: ferricade user <command> <username>

commands (they need only DATABASE_URL):
  unlock      clear the account's failed sign-ins and lock
  reset-totp  remove the account's TOTP secret and end its sessions;
              it enrolls again at its next sign-in when TOTP is required
  set-password  set a new password and end the account's sessions
`

// runUser runs "ferricade user ..." with args after "user" and returns the exit
// status: 0 done, 1 failed, 2 bad usage.
func runUser(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	return runUserInput(ctx, args, getenv, os.Stdin, stdout, stderr)
}

func runUserInput(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 2 || (args[0] != "unlock" && args[0] != "reset-totp" && args[0] != "set-password") {
		fmt.Fprint(stderr, userUsage)
		return 2
	}
	url := strings.TrimSpace(getenv("DATABASE_URL"))
	if url == "" {
		fmt.Fprintln(stderr, "ferricade user: DATABASE_URL is required")
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := store.Open(ctx, url)
	if err != nil {
		fmt.Fprintf(stderr, "ferricade user: %v\n", err)
		return 1
	}
	defer pool.Close()

	cmd, username := args[0], args[1]
	var line string
	switch cmd {
	case "unlock":
		var res recovery.Unlocked
		if res, err = recovery.UnlockUser(ctx, pool, username); err == nil {
			line = fmt.Sprintf("unlocked user %s (had %d failed sign-ins", res.Username, res.FailedLogins)
			if res.LockedUntil != nil {
				line += ", locked until " + res.LockedUntil.UTC().Format(time.RFC3339)
			}
			line += ")"
		}
	case "reset-totp":
		var res recovery.TOTPReset
		if res, err = recovery.ResetUserTOTP(ctx, pool, username); err == nil {
			line = fmt.Sprintf("reset TOTP of user %s (was enrolled: %t); its sessions are ended", res.Username, res.WasEnrolled)
			if res.SetupVerificationCleared {
				line += "; redo the setup TOTP step"
			}
		}
	case "set-password":
		var password string
		password, err = readNewPassword(stdin, stderr, username)
		if err == nil {
			var hash string
			hash, err = auth.HashPassword(ctx, password, auth.DefaultParams)
			if err == nil {
				err = store.Tx(ctx, pool, func(q *db.Queries) error {
					u, lookupErr := q.GetUserByUsername(ctx, username)
					if errors.Is(lookupErr, pgx.ErrNoRows) {
						return recovery.ErrUserNotFound
					}
					if lookupErr != nil {
						return fmt.Errorf("get user: %w", lookupErr)
					}
					u, lookupErr = q.GetUserByIDForUpdate(ctx, u.ID)
					if lookupErr != nil {
						return fmt.Errorf("lock user: %w", lookupErr)
					}
					if updateErr := q.SetPasswordHash(ctx, db.SetPasswordHashParams{ID: u.ID, PasswordHash: &hash}); updateErr != nil {
						return fmt.Errorf("set password: %w", updateErr)
					}
					if updateErr := q.UnlockUser(ctx, u.ID); updateErr != nil {
						return fmt.Errorf("unlock user: %w", updateErr)
					}
					if updateErr := q.DeleteUserSessions(ctx, u.ID); updateErr != nil {
						return fmt.Errorf("end sessions: %w", updateErr)
					}
					if updateErr := q.NotifyGrantsChanged(ctx, u.ID); updateErr != nil {
						return fmt.Errorf("notify session revocation: %w", updateErr)
					}
					line = fmt.Sprintf("password set for user %s; its sessions are ended", u.Username)
					return audit.Record(ctx, q, audit.Event{ActorIP: netip.MustParseAddr("127.0.0.1"),
						Action: "user.password_set_cli", TargetType: "user", TargetID: u.ID.String(),
						Details: map[string]any{"username": u.Username}})
				})
			}
		}
	}
	if errors.Is(err, recovery.ErrUserNotFound) {
		fmt.Fprintf(stderr, "ferricade user %s: no user %q\n", cmd, username)
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "ferricade user %s: %v\n", cmd, err)
		return 1
	}
	fmt.Fprintln(stdout, line)
	return 0
}

func readNewPassword(stdin io.Reader, stderr io.Writer, username string) (string, error) {
	restore, hidden, err := disableEcho(stdin)
	if err != nil {
		return "", fmt.Errorf("hide password input: %w", err)
	}
	if restore != nil {
		defer restore()
	}
	reader := bufio.NewReader(io.LimitReader(stdin, 2052))
	read := func(prompt string) (string, error) {
		fmt.Fprint(stderr, prompt)
		line, err := reader.ReadString('\n')
		if hidden {
			fmt.Fprintln(stderr)
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		if line == "" {
			return "", io.ErrUnexpectedEOF
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	first, err := read("New password: ")
	if err != nil {
		return "", err
	}
	second, err := read("Repeat new password: ")
	if err != nil {
		return "", err
	}
	if first != second {
		return "", errors.New("passwords do not match")
	}
	if len(first) > 1024 {
		return "", errors.New("password must be at most 1024 bytes")
	}
	if err := auth.ValidatePassword(username, first); err != nil {
		return "", err
	}
	return first, nil
}
