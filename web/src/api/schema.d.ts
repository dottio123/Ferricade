/**
 * GENERATED FILE. DO NOT EDIT BY HAND.
 * Source: internal/adminapi/openapi.yaml (the API contract).
 * Regenerate with `npm run gen:api`; `npm run gen:api:check` fails when this file is stale.
 */

export interface paths {
    "/admin/api/v1/devices/auto-sort/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dry run of Auto sort all (Owner)
         * @description What POST /devices/auto-sort would do now, without changing anything. Approved devices
         *     only: one matching group → moved there (also from a manually chosen group); no match →
         *     unchanged; two or more → conflict (not moved, flagged).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The dry run. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AutoSortResult"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/auto-sort": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Auto sort all approved devices by the group patterns (Owner)
         * @description Recomputes and applies the dry run in one transaction; runs never overlap. Every move is
         *     audited as device.updated (reason auto_sort) and the run as devices.auto_sorted. After the
         *     run, exactly the conflicting devices have an open group_conflict alert.
         *     Lock acquisition waits at most 5 seconds; a timeout returns 503 busy without changes.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description What the run did. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AutoSortResult"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
                /** @description busy: auto sort could not start: devices are busy, try again. Nothing changed. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in with username and password
         * @description Starts a session with mfa_passed=false, replacing the browser's previous
         *     session, and sets the session cookie (Secure, HttpOnly, SameSite=Strict, Path=/).
         *     A wrong password and an unknown username give the same 401, and both lock
         *     after 5 consecutive failures (423).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        username: string;
                        password: string;
                    };
                };
            };
            responses: {
                /** @description Signed in. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @description True when the session must pass /auth/totp (TOTP enrolled) or enroll TOTP (TOTP required) before using the API. */
                            mfa_required: boolean;
                            csrf_token: string;
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                423: components["responses"]["Locked"];
                429: components["responses"]["RateLimited"];
                500: components["responses"]["Internal"];
                503: components["responses"]["Busy"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** End the session */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Signed out; the cookie is cleared. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed-in user and session state */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Current session. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: components["schemas"]["User"];
                            mfa_passed: boolean;
                            totp_enrolled: boolean;
                            csrf_token: string;
                        };
                    };
                };
                401: components["responses"]["Unauthenticated"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/totp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pass the second factor
         * @description A correct code not used before marks the session MFA-passed and rotates it
         *     (new cookie and CSRF token). A wrong code gives 400 "invalid_code" and the
         *     session stays valid; 5 consecutive wrong codes lock TOTP for the account
         *     (423) on the login lockout schedule, and a new password login does not
         *     reset that count. A right code whose 30 s step was already used (for
         *     example the code just used for enrollment) gives 400 "code_already_used"
         *     and does not count as a failure. Parallel attempts are bounded: an attempt
         *     in flight counts towards both the per-account and the per-address limit.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["Code"];
                };
            };
            responses: {
                /** @description MFA passed. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CSRFToken"];
                    };
                };
                /** @description "invalid_code" (wrong code), "code_already_used" (wait for the next code), or "bad_request" (malformed body, or TOTP not set up). */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                423: components["responses"]["Locked"];
                429: components["responses"]["RateLimited"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change the signed-in user's password
         * @description Needs the current password. The new one must be at least 12 characters, not a
         *     common password and not the username. Ends the user's other sessions and
         *     rotates this one.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        current_password: string;
                        new_password: string;
                    };
                };
            };
            responses: {
                /** @description Password changed. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CSRFToken"];
                    };
                };
                /** @description "bad_request", or "weak_password" when the new password fails the policy. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                /** @description "forbidden" when the current password is wrong; also "csrf", "mfa_required", "totp_enroll_required". */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                429: components["responses"]["RateLimited"];
                500: components["responses"]["Internal"];
                503: components["responses"]["Busy"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/totp/enroll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start TOTP enrollment
         * @description Returns a new secret, held for this session for 10 minutes until confirmed.
         *     A user who already has TOTP must have passed it in this session (else 403
         *     "mfa_required"). Re-enrolling for a password account requires current_password
         *     (else 403 "forbidden"); an SSO-only account must have signed in within 5 minutes
         *     (else 403 "reauthentication_required").
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["TOTPEnrollRequest"];
                };
            };
            responses: {
                /** @description New secret. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TOTPSecret"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/totp/enroll/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm TOTP enrollment
         * @description A correct code from the pending secret stores it as the user's TOTP secret
         *     and rotates the session as MFA-passed.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["Code"];
                };
            };
            responses: {
                /** @description Enrolled. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CSRFToken"];
                    };
                };
                /** @description "invalid_code" (wrong code), "code_already_used" (the step of the last accepted code; wait for the next one), or "bad_request". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                409: components["responses"]["Incomplete"];
                429: components["responses"]["RateLimited"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/oidc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Whether OIDC sign-in is offered */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The sign-in page's OIDC button state. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OIDCPublic"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/oidc/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Start an OIDC sign-in (browser navigation)
         * @description Sets a short-lived flow cookie (__Host-ferricade_oidc: sealed, 5 minutes, HttpOnly, Secure,
         *     SameSite=Lax) and redirects to the provider. When OIDC is off or misconfigured, or the
         *     client is rate-limited, redirects to /sign-in?sso_error=<code> instead.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Where to go after signing in; must pass the same safe-next rules as sign-in. */
                    next?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description To the provider, or to /sign-in?sso_error=provider_error|rate_limited. */
                302: {
                    headers: {
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/auth/oidc/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Finish an OIDC sign-in (the provider's redirect)
         * @description Verifies state, nonce and the ID token, resolves the account (linked subject, then a
         *     verified email matching exactly one account, then JIT if enabled), sets the role from
         *     the groups, and starts a session with mfa_passed=true. On success it answers a small
         *     same-origin page that moves to `next` with a meta refresh (not a 302, so the SameSite=Strict
         *     session cookie is sent). On failure it redirects to /sign-in?sso_error=<code>, one of
         *     not_allowed, no_account, account_conflict, disabled, provider_error, expired, rate_limited. Every outcome is
         *     audited.
         */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    state?: string;
                    error?: string;
                    error_description?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Signed in; same-origin page moves to next. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description Refused or failed; to /sign-in?sso_error=<code>. */
                302: {
                    headers: {
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/oidc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The OIDC sign-in settings (Owner) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Settings; secret never returned. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OIDCSettings"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit the OIDC sign-in settings (Owner)
         * @description Absent fields are kept; an absent client_secret keeps the stored one. The issuer must be
         *     https (http://localhost and http://127.0.0.1 are allowed for testing). Turning it on
         *     needs an issuer, a client ID, a client secret and at least one owner, admin or user group.
         *     Audited as settings.oidc_updated with the names of the changed fields (never the secret).
         *     In DEV_INSECURE mode any http issuer is allowed.
         *     Roles from groups: owner if any owner group matches, else admin, else user; no match refuses the sign-in.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        enabled?: boolean;
                        display_name?: string;
                        issuer?: string;
                        client_id?: string;
                        client_secret?: string;
                        groups_claim?: string;
                        owner_groups?: string[];
                        admin_groups?: string[];
                        user_groups?: string[];
                        jit_enabled?: boolean;
                    };
                };
            };
            responses: {
                /** @description Saved settings. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OIDCSettings"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/settings/oidc/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test the provider discovery document (Owner)
         * @description Fetches <issuer>/.well-known/openid-configuration (5 s timeout) with the saved issuer and
         *     stores the result as last_test. A failed discovery is a result (ok=false with an error
         *     code), not an HTTP error.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Test result. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["OIDCTestResult"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/server/client-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Client configuration for the server profile
         * @description The same object /setup/complete returned. 404 until setup is complete.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Client configuration. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ClientConfig"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/deployment/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the deployment profile (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The profile and settings catalog. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DeploymentProfile"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Save the deployment profile (Owner)
         * @description Secrets are write-only; absent keeps, a string sets, null removes. Profile and secret changes are audited together without secret values.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DeploymentProfilePut"];
                };
            };
            responses: {
                /** @description The saved profile. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DeploymentProfile"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/deployment/script": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download a deployment script (Owner or Admin)
         * @description Audited when served. Requires completed setup.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        os: "windows" | "linux";
                    };
                };
            };
            responses: {
                /** @description Rendered script. */
                200: {
                    headers: {
                        "Content-Disposition"?: string;
                        "Cache-Control"?: "no-store";
                        [name: string]: unknown;
                    };
                    content: {
                        "text/plain": string;
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether first-run setup is complete
         * @description Lets the web UI choose between the setup wizard and the sign-in page. Needs
         *     no session and no setup token, and, unlike the other /setup paths, keeps
         *     answering after setup completes.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Setup state. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            setup_complete: boolean;
                        };
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/owner": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the owner account
         * @description Creates the owner with TOTP required. Repeating this step before setup
         *     completes overwrites the same owner and restarts its TOTP enrollment.
         *     Username: 1 to 64 of letters, digits, '.', '_', '-', '@'. Password: at least
         *     12 characters, not common, not the username.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        username: string;
                        password: string;
                        display_name?: string;
                        /** Format: email */
                        email?: string;
                    };
                };
            };
            responses: {
                /** @description Owner created. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                        };
                    };
                };
                /** @description "bad_request", or "weak_password". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
                503: components["responses"]["Busy"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/owner/totp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Generate the owner's TOTP secret
         * @description Replaces any earlier secret, which must then be verified again.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description New secret. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TOTPSecret"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                409: components["responses"]["Incomplete"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/owner/totp/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm the owner's TOTP secret */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["Code"];
                };
            };
            responses: {
                /** @description Verified. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            verified: true;
                        };
                    };
                };
                /** @description "invalid_code" (wrong code), "code_already_used" (wait for the next code), or "bad_request". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                409: components["responses"]["Incomplete"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/server": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Save the server profile and check it
         * @description Validates and saves the profile (creating it or updating the existing one),
         *     then dials the ID server (default port 21116), relay (21117), the client API address the
         *     clients are given (ID host, default port 21114), and runs an online query against
         *     HBBS_ADDR when set. A stored api_url and links_include_server are kept; when set, the client API check dials its
         *     host and port. The profile stays saved whatever the checks report. An empty name becomes
         *     "default".
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        /** @description Required. A DNS name, IPv4 address or IPv6 address (bracketed when a port follows), optionally with :port (1-65535). */
                        id_host: string;
                        /** @description Required; same form as id_host. */
                        relay_host: string;
                        /** @description Base64 of 32 bytes (hbbs id_ed25519.pub). */
                        public_key: string;
                    };
                };
            };
            responses: {
                /** @description Saved; check results follow. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            saved: true;
                            /** Format: uuid */
                            server_id: string;
                            checks: components["schemas"]["Check"][];
                        };
                    };
                };
                /** @description "bad_request" (missing or malformed host), or "invalid_key". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish setup
         * @description Needs a verified owner TOTP and a saved server. Afterwards every /setup path is 404.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Setup complete. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            client_config: components["schemas"]["ClientConfig"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                409: components["responses"]["Incomplete"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List devices
         * @description Devices ordered by sort (default rustdesk_id), with rustdesk_id and id as
         *     tie-breakers in the same direction. name uses lower(coalesce(nullif(alias,''),
         *     nullif(hostname,''), rustdesk_id)). status ranks open alerts, pending, online,
         *     offline. state ranks pending, approved, rejected, archived. os uses lower(os),
         *     with empty values last. group uses lower(group name), with no group last;
         *     a User's hidden groups count as no group. desc reverses the entire order.
         *     Cursors are opaque and valid only with the same sort, order and filters;
         *     a different sort or order returns 400 bad_request (cursor does not match sort).
         *     Status changes between pages may cause a device to appear twice or be skipped.
         *     For example, GET /admin/api/v1/devices?sort=name&order=desc&limit=2
         *     returns alias "zeta" before hostname "Yak", with an opaque next_cursor if more follow.
         *     Add subgroups=true with a group filter to include the selected group and all descendants,
         *     for example GET /admin/api/v1/devices?group=<JCC>&subgroups=true&sort=name.
         *     The online filter is applied to each page after
         *     it is read (online state lives in memory), so a page can hold fewer than limit
         *     items, or none, while next_cursor is set; keep following next_cursor.
         *     For a User: only their visible devices; a state filter other than approved returns no items.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Sort key; default rustdesk_id. See the description for each key. */
                    sort?: "rustdesk_id" | "name" | "status" | "state" | "os" | "group";
                    order?: "asc" | "desc";
                    state?: "pending" | "approved" | "rejected" | "archived";
                    online?: boolean;
                    /** @description Tag ID. */
                    tag?: string;
                    /** @description Group ID (the group itself; add subgroups=true for its descendants too). */
                    group?: string;
                    /** @description With group: true = the group and all its descendant groups. 400 without group or with ungrouped=true. For a User, only descendants within their grants. */
                    subgroups?: boolean;
                    /** @description true = only devices without a group (for a User: devices whose group is not one of theirs, i.e. shown with group_id null). Cannot be combined with group (400). */
                    ungrouped?: boolean;
                    /** @description Case-insensitive prefix of the OS. */
                    os?: string;
                    /** @description Case-insensitive substring of rustdesk_id, alias, hostname or username. */
                    q?: string;
                    /** @description Page size; default 50, at most 200 are returned. */
                    limit?: components["parameters"]["limit"];
                    /** @description The previous page's next_cursor. */
                    cursor?: components["parameters"]["cursor"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of devices. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["Device"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /**
         * Get a device
         * @description For a User, a device outside their grants is 404. For a User, approved_by is null and group_id is null unless the group is one of theirs. For a User, alert addresses are empty.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        /**
         * Delete a device
         * @description Removes the device in any state, with its tags, alerts and remote-session
         *     history. Audited as device.deleted, whose details keep the device's
         *     rustdesk_id, hostname, alias, state and the number of sessions removed.
         *     A client that still reports in enrolls again as a new pending device.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deleted. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "window_open": close the access window first. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        /**
         * Edit a device
         * @description Absent fields are kept. group_id null removes the device from its group;
         *     tag_ids replaces the device's tags. Audited as device.updated with the
         *     fields' values before and after. A PATCH that sets group_id (even to the
         *     group the device is already in) also resolves an open group_conflict alert.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        alias?: string;
                        note?: string;
                        /** Format: uuid */
                        group_id?: string | null;
                        tag_ids?: string[];
                    };
                };
            };
            responses: {
                200: components["responses"]["Device"];
                /** @description "bad_request": malformed body, field too long, or an unknown group or tag. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/policy": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get effective policy and access window status for a visible device */
        get: operations["getDevicePolicy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/id-allow-list": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get a device's ID allow list and effective list (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Device list with inherited entries */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DeviceIdAllowList"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace a device's ID allow list (Owner or Admin)
         * @description Audited as id_allow_list.updated in the same transaction as the replacement.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["IdAllowList"];
                };
            };
            responses: {
                /** @description Device list with inherited entries */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DeviceIdAllowList"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/access-window": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Open an access window */
        post: operations["openAccessWindow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/access-window/close": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Close the access window */
        post: operations["closeAccessWindow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve a pending or rejected device
         * @description Sets approved_by and approved_at. Audited as device.approved.
         *     A device without a group is placed by the group patterns (see POST /groups/{id}/rules); with two or more matching groups it stays ungrouped and gets a group_conflict alert.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition": the device is not in a state this action applies to. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reject a pending device
         * @description A rejected device is ignored by the client API. Audited as device.rejected.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition": the device is not in a state this action applies to. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Return a rejected or approved device to pending
         * @description The undo of a reject or an approve: the device waits for approval again, and approved_by and approved_at are cleared. Audited as device.reopened, with the previous state in details.from.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition" or "window_open". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Archive an approved device
         * @description An archived device is ignored by the client API. Audited as device.archived.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition" or "window_open". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore an archived device to approved
         * @description Sets approved_by and approved_at. Audited as device.restored.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition": the device is not in a state this action applies to. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/alerts/{alert_id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
                alert_id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve an open device alert
         * @description "accept_new_uuid" re-pins the device to the alert's seen_uuid, so the client
         *     with that uuid is trusted from then on; "dismiss" keeps the pinned uuid.
         *     Audited as device.alert_resolved.
         *     For group_conflict only dismiss applies: the device stays where it is. A PATCH that sets group_id (even to the group the device is already in) also resolves it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                    alert_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "accept_new_uuid" | "dismiss";
                    };
                };
            };
            responses: {
                200: components["responses"]["Device"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description Unknown device, or the alert is not an open alert of this device. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/devices/{id}/connect": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /**
         * A rustdesk:// link and command for an approved device
         * @description The link is rustdesk://<id> for connect and rustdesk://<action>/<id> otherwise,
         *     with /r appended when relay=1. It carries no password. Each link handed out is
         *     audited as device.connect_link. Devices that are not approved are 404.
         *     For a User, a device outside their grants is 404.
         */
        get: {
            parameters: {
                query?: {
                    action?: "connect" | "file-transfer" | "port-forward" | "terminal";
                    relay?: "0" | "1";
                };
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Link. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @description When links_include_server is on, names the ID server and its key ('+' escaped), so it works from a client set to another ID server, e.g. rustdesk://123456789@rd.example.com?key=OeVu...= */
                            url: string;
                            /** @description When links_include_server is on, e.g. rustdesk --connect "123456789@rd.example.com?key=OeVu...=" */
                            command: string;
                            /** @description The device's rustdesk_id. */
                            id: string;
                            /** @description False when links_include_server is off; the link then works only from a client already set to this server and key. */
                            includes_server: boolean;
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "access_locked": the policy locks Connect. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List policies (Owner or Admin)
         * @description Default first, then by name; no paging.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Policies. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["Policy"][];
                        };
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        /**
         * Create a policy (Owner or Admin)
         * @description Audited as policy.created.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        settings: components["schemas"]["PolicySettings"];
                    };
                };
            };
            responses: {
                /** @description Created policy */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Policy"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description "name_taken". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/policies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get a policy (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Policy */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Policy"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        /**
         * Delete a policy (Owner or Admin)
         * @description Audited as policy.deleted.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deleted. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "default_policy" or "in_use". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        /**
         * Update a policy (Owner or Admin)
         * @description At least one field is required; settings replaces the whole map. Audited as policy.updated.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        settings?: components["schemas"]["PolicySettings"];
                    };
                };
            };
            responses: {
                /** @description Policy */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Policy"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "name_taken" or "default_policy". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/settings/log-export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Log export settings and per-output status (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Settings and status. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LogExport"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace the log export settings (Owner)
         * @description Replaces the settings of both outputs. An output switched on starts at that moment: events
         *     written before are not sent to it. A syslog output that is on needs a host. ca_pem, when not
         *     empty, must hold at least one PEM certificate. Audited as settings.log_export_updated with
         *     the names of the changed fields (never the certificate text); no change, no audit entry.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["LogExportSettings"];
                };
            };
            responses: {
                /** @description Saved settings and status. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LogExport"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/log-export/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a test event to one output (Owner)
         * @description Delivers one ferricade.test event straight to the output with the saved settings, also while
         *     that output is off (10 s timeout). Not queued and not audited. A failed delivery is a
         *     result (ok=false with the error), not an HTTP error.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        output: "file" | "syslog";
                    };
                };
            };
            responses: {
                /** @description Test result. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LogExportTestResult"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get sign-in duration (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Sign-in duration. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        /**
                         * @example {
                         *       "lifetime": "browser",
                         *       "updated_at": null,
                         *       "updated_by": null
                         *     }
                         */
                        "application/json": components["schemas"]["SessionSettings"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Set sign-in duration (Owner)
         * @description Read at password or OIDC sign-in; the session stores persistence and expires_at.
         *     browser (default) uses a browser-session cookie without Max-Age, ends after
         *     5 minutes idle (kept alive by an open /events stream), and is capped at 7 days.
         *     8h, 1d, 7d and 30d use persistent cookies with Max-Age equal to whole seconds
         *     remaining until expires_at, with no idle limit. TOTP rotation preserves both
         *     persistence and expires_at, setting the cookie's remaining Max-Age.
         *     A stricter value (browser < 8h < 1d < 7d < 30d) caps every open session at
         *     least(expires_at, created_at + duration), using 7 days for browser. Switching
         *     to browser also makes sessions non-persistent and restores the idle limit.
         *     This includes the owner's session, which may end immediately. A looser value
         *     affects only later sign-ins. Audited as session_lifetime.changed with
         *     before/after values only on change; the setting, session caps and audit are
         *     committed in the same transaction. Cookie flags, CSRF, Origin checks,
         *     rotation, MFA, lockout, sign-out and session revocation are unchanged.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        lifetime: "browser" | "8h" | "1d" | "7d" | "30d";
                    };
                };
            };
            responses: {
                /** @description Sign-in duration. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SessionSettings"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/id-allow-list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the global ID allow list (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Global ID allow list. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IdAllowList"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace the global ID allow list (Owner)
         * @description Audited as id_allow_list.updated in the same transaction as the replacement.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["IdAllowList"];
                };
            };
            responses: {
                /** @description Global ID allow list. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IdAllowList"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/policy-push": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get policy push switch (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Switch */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PolicyPush"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Set policy push switch (Owner)
         * @description Audited as policy_push.enabled or policy_push.disabled on change.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        enabled: boolean;
                    };
                };
            };
            responses: {
                /** @description Switch */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PolicyPush"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description "window_open": close the open access windows first. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/policy": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set a group's policy (Owner or Admin)
         * @description Audited as group.policy_changed.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        policy_id: string | null;
                    };
                };
            };
            responses: {
                200: components["responses"]["Group"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/id-allow-list": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /** Get a group's ID allow list (Owner or Admin) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Group ID allow list. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IdAllowList"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace a group's ID allow list (Owner or Admin)
         * @description Audited as id_allow_list.updated in the same transaction as the replacement.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["IdAllowList"];
                };
            };
            responses: {
                /** @description Group ID allow list. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["IdAllowList"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/group-rules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every automatic grouping pattern (Owner or Admin)
         * @description By group, then pattern. The list is returned whole; next_cursor is always "".
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Rules. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["GroupRule"][];
                            next_cursor: string;
                        };
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/rules": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add a hostname pattern to a group (Owner or Admin)
         * @description Approving a pending or rejected device without a group puts it into the one group
         *     whose patterns match its hostname (whole name, case-insensitive; * is any run of
         *     characters, ? exactly one). Two or more matching groups raise a group_conflict alert.
         *     At most 20 patterns per group. Audited as group.rule_added.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["GroupRuleInput"];
                };
            };
            responses: {
                /** @description The rule. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GroupRule"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "pattern_taken": the group already has this pattern (ignoring case). */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/rules/{rule_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
                rule_id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a hostname pattern (Owner or Admin)
         * @description Audited as group.rule_removed. Open group_conflict alerts that list this group drop it when none of the group's remaining rules matches the device; an alert left with fewer than two groups is resolved (the device is not moved).
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                    rule_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Removed. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description Unknown group, or the rule is not one of its rules. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/rules/preview": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Which devices a pattern would match (Owner or Admin)
         * @description Pending and approved devices only. Not saved and not audited.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["GroupRuleInput"];
                };
            };
            responses: {
                /** @description Preview. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GroupRulePreview"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The group tree
         * @description Root groups as items, each with its descendants in children, siblings by name. The tree is returned whole; next_cursor is always "". For a User: the granted groups as roots (a granted group with a granted ancestor appears only under it) with their subgroups; groups carry no device counts.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Group tree. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["Group"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        /**
         * Create a group
         * @description Audited as group.created.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        /**
                         * Format: uuid
                         * @description Absent or null for a root group.
                         */
                        parent_id?: string | null;
                    };
                };
            };
            responses: {
                201: components["responses"]["Group"];
                /** @description "bad_request": malformed body, bad name, or unknown parent. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description "name_taken": a sibling has this name. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/groups/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete an empty group
         * @description Audited as group.deleted. Open group_conflict alerts that list this group drop it; an alert left with fewer than two groups is resolved (the device is not moved).
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deleted. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "not_empty": the group has child groups or devices. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        /**
         * Rename a group
         * @description Audited as group.renamed.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                200: components["responses"]["Group"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "name_taken": a sibling has this name. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/groups/{id}/move": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move a group
         * @description Audited as group.moved.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /**
                         * Format: uuid
                         * @description The new parent; null makes the group a root.
                         */
                        parent_id: string | null;
                    };
                };
            };
            responses: {
                200: components["responses"]["Group"];
                /** @description "bad_request": malformed body, missing parent_id, or unknown parent. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "cycle": the parent is the group itself or one of its descendants; "name_taken": a sibling under the new parent has this name. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List tags
         * @description By name, case-insensitively. For a User: only tags on their visible devices.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Page size; default 50, at most 200 are returned. */
                    limit?: components["parameters"]["limit"];
                    /** @description The previous page's next_cursor. */
                    cursor?: components["parameters"]["cursor"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of tags. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["Tag"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        /**
         * Create a tag
         * @description Audited as tag.created.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        /**
                         * Format: int64
                         * @default 0
                         */
                        color?: number;
                    };
                };
            };
            responses: {
                201: components["responses"]["Tag"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description "name_taken": a tag has this name (case-insensitively). */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/tags/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete a tag
         * @description The tag is detached from every device. Audited as tag.deleted.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deleted. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        /**
         * Rename or recolor a tag
         * @description Absent fields are kept. Audited as tag.updated.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        /** Format: int64 */
                        color?: number;
                    };
                };
            };
            responses: {
                200: components["responses"]["Tag"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "name_taken": another tag has this name. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List users (Owner)
         * @description By username, case-insensitively.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Page size; default 50, at most 200 are returned. */
                    limit?: components["parameters"]["limit"];
                    /** @description The previous page's next_cursor. */
                    cursor?: components["parameters"]["cursor"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of users. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["User"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        /**
         * Create a user (Owner)
         * @description Username: 1 to 64 of letters, digits, '.', '_', '-', '@', unique
         *     case-insensitively. Password: at least 12 characters, not common, not the
         *     username. An owner always has totp_required. Audited as user.created.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        username: string;
                        password: string;
                        display_name?: string;
                        /** Format: email */
                        email?: string;
                        /** @enum {string} */
                        role: "owner" | "admin" | "user";
                        /** @default false */
                        totp_required?: boolean;
                    };
                };
            };
            responses: {
                201: components["responses"]["User"];
                /** @description "bad_request", or "weak_password". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description "username_taken". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
                503: components["responses"]["Busy"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit a user (Owner)
         * @description Absent fields are kept. A change that would leave no active owner (demoting or
         *     disabling the last one) gives 409 "last_owner". Promotion to owner turns
         *     totp_required on, and it cannot be turned off for an owner. Disabling a user
         *     ends their sessions at once. Audited as user.updated with the changed fields
         *     before and after.
         *     Any role change of a user, or to user, deletes that account's grants (PUT /users/{id}/grants) and ends their open event streams with resync.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        display_name?: string;
                        /** Format: email */
                        email?: string;
                        /** @enum {string} */
                        role?: "owner" | "admin" | "user";
                        /** @enum {string} */
                        status?: "active" | "disabled";
                        totp_required?: boolean;
                    };
                };
            };
            responses: {
                200: components["responses"]["User"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "last_owner". */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/users/{id}/reset-totp": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Remove a user's TOTP (Owner)
         * @description Deletes the user's TOTP secret and ends their sessions; with totp_required they
         *     must enroll again at their next sign-in. Audited as user.totp_reset.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["User"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/users/{id}/password": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set another account's password (Owner)
         * @description Sets the account's password, with the same rules as POST /users (at least 12 characters,
         *     not a common password, not the username in any capitalisation; at most 1024 bytes). Ends all
         *     of that account's sessions and clears its failed-sign-in lockout. TOTP is unchanged. Not for
         *     the caller's own account (use POST /auth/password, which asks for the current password):
         *     that gives 400 "bad_request". Audited as user.password_reset.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        password: string;
                    };
                };
            };
            responses: {
                200: components["responses"]["User"];
                /** @description "bad_request", or "weak_password". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
                503: components["responses"]["Busy"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/users/{id}/avatar": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /**
         * A user's photo
         * @description The image copied from the OIDC provider. Cache-Control private, max-age=300; X-Content-Type-Options nosniff. A User gets only their own photo; any other is 404.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The image. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "image/png": string;
                        "image/jpeg": string;
                        "image/webp": string;
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/users/{id}/oidc": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Unlink a user from the OIDC provider (Owner)
         * @description Clears the link and ends the user's sessions. Audited as user.oidc_unlinked. A user with
         *     no password cannot be unlinked: they could not sign in any more.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["User"];
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description no_password; unlinking would lock the user out. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/users/{id}/grants": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        /**
         * The devices and groups granted to a User (Owner)
         * @description For a user whose role is not user, both lists are empty.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Grants. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserGrants"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace a User's grants (Owner)
         * @description Replaces both lists. A device that is not approved may be granted; the User sees it
         *     once it is approved. An unknown group or device ID gives 400 "bad_request". Audited
         *     as user.grants_updated with details {added_group_ids, removed_group_ids,
         *     added_device_ids, removed_device_ids}. The User's open event streams end with resync.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["UserGrants"];
                };
            };
            responses: {
                /** @description The saved grants. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserGrants"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "bad_transition": grants apply to the user role only. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/server": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The server profile */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                200: components["responses"]["Server"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit the server profile (Owner)
         * @description Absent fields are kept; the result is validated as in /setup/server (an empty
         *     name becomes "default"). Run POST /server/check to test it. Audited as
         *     server.updated with the changed fields before and after.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        /** @description A DNS name, IPv4 address or IPv6 address (bracketed when a port follows), optionally with :port (1-65535). */
                        id_host?: string;
                        /** @description Same form as id_host. */
                        relay_host?: string;
                        /** @description Base64 of 32 bytes (hbbs id_ed25519.pub). */
                        public_key?: string;
                        /** @description Empty clears it. Otherwise https://host[:port] (port not 21114) with no path, query, fragment or user info; one trailing slash is trimmed. */
                        api_url?: string;
                        links_include_server?: boolean;
                    };
                };
            };
            responses: {
                200: components["responses"]["Server"];
                /** @description "bad_request" (malformed body, host or api_url), or "invalid_key". */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        trace?: never;
    };
    "/admin/api/v1/server/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check the server's reachability
         * @description Dials the ID server (default port 21116), relay (21117), the client API address the clients are given (ID host, default port 21114), and runs an online query against HBBS_ADDR when set. Nothing is written to the database; the result becomes the latest round of GET /server/health.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Check results. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            checks: components["schemas"]["Check"][];
                        };
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/server/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The RustDesk server's health from the background checks
         * @description ferricade runs the checks of POST /server/check every 60 s in the background (once
         *     setup is complete) and after each POST /server/check. This returns the latest
         *     round without dialing anything. Every role may read it; for a User every detail
         *     is empty. Not audited.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The latest round. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServerHealth"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The audit log
         * @description Newest first. For a User: only their own auth.* events and device.connect_link events; the actor filter is ignored.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Exact action, e.g. device.approved. */
                    action?: string;
                    /** @description Actor user ID. */
                    actor?: string;
                    /** @description Exact target_id. */
                    target?: string;
                    /** @description Inclusive. */
                    since?: string;
                    /** @description Exclusive. */
                    until?: string;
                    /** @description Page size; default 50, at most 200 are returned. */
                    limit?: components["parameters"]["limit"];
                    /** @description The previous page's next_cursor. */
                    cursor?: components["parameters"]["cursor"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of events. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["AuditEvent"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Remote session history
         * @description Newest start first. Sessions are built from the connection audits RustDesk clients post. The list includes connection attempts whose peer never authenticated (authed_at null); filter them with authenticated. For a User: only sessions of their visible devices. For a User, client_ip is null.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Only this device's sessions. */
                    device_id?: string;
                    /** @description true for open sessions, false for ended ones. */
                    active?: "true" | "false";
                    /** @description true for sessions whose peer authenticated (authed_at set), false for connection attempts that never did. Absent lists both; the statistics count only authenticated sessions. */
                    authenticated?: "true" | "false";
                    /** @description Inclusive; on started_at. */
                    since?: string;
                    /** @description Exclusive; on started_at. */
                    until?: string;
                    /** @description Page size; default 50, at most 200 are returned. */
                    limit?: components["parameters"]["limit"];
                    /** @description The previous page's next_cursor. */
                    cursor?: components["parameters"]["cursor"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of sessions. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["RemoteSession"][];
                            next_cursor: components["schemas"]["NextCursor"];
                        };
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/sessions/{id}/disconnect": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disconnect an open remote session
         * @description Owner and admin. Stores the request; the device's next heartbeat reply lists the connection, the stock client closes it (within a few seconds while a session is open) and the session then ends with end_reason "disconnected". Answers 202 with the session, whose disconnect_requested_at is set; that is the request, not proof that the connection is gone. Repeating the request on an open session is idempotent: 202, the original disconnect_requested_at, no second audit entry. Audited as session.disconnect_requested (target the session; details device_id and conn_id).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Resource ID; anything but a UUID is 404. */
                    id: components["parameters"]["id"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The request is stored. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RemoteSession"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                404: components["responses"]["NotFound"];
                /** @description "session_ended": the session has already ended. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                500: components["responses"]["Internal"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/sessions/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Session statistics
         * @description Authenticated sessions (authed_at set) started in the last 7 or 30 days (today included), by the day they started in the requested time zone. Open sessions count up to now. Connection attempts whose peer never authenticated are not counted. For a User: only sessions of their visible devices.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Default 7d. */
                    range?: "7d" | "30d";
                    /** @description IANA time zone name, e.g. America/New_York. Default UTC. */
                    tz?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The statistics. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SessionStats"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/stats/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fleet trend history
         * @description Snapshots of device and session counts taken every five minutes, grouped into buckets of step_seconds (24h: 300, 7d: 3600, 30d: 21600). approved, online and pending are the rounded mean over the bucket and sessions its peak. Buckets without a snapshot are left out; oldest first. Not available to a User (403).
         */
        get: {
            parameters: {
                query: {
                    range: "24h" | "7d" | "30d";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The history. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FleetHistory"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/stats/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Dashboard summary
         * @description Everything the dashboard's command center shows, in one call: device counts, open sessions and alerts, mixes by operating system and client version, per-group counts, and the devices needing attention (using the owner's thresholds from /settings/dashboard). Online state is the live state. For a User: computed over their visible devices; pending counts are 0.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The summary. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FleetSummary"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/stats/fleet-map": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Every approved device the caller can see, compact, for the Fleet overview
         * @description At most 2000 devices, ordered by name (case-insensitive) then id; truncated is true when more exist.
         *     name = alias, else hostname, else rustdesk_id. status = alert when the device has an open alert, else
         *     online/offline from the online tracker. For a User: only visible devices, and group_id is null when the
         *     device's group is outside their grants. Any signed-in role. Not audited.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The fleet map. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FleetMap"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                500: components["responses"]["Internal"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/settings/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Dashboard thresholds
         * @description The defaults (7 days, 24 hours, no minimum version) until the owner saves others.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The thresholds. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DashboardThresholds"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Set the dashboard thresholds (Owner)
         * @description Replaces all three thresholds. Audited as settings.dashboard_updated with the
         *     thresholds before and after.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DashboardThresholds"];
                };
            };
            responses: {
                /** @description The saved thresholds. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DashboardThresholds"];
                    };
                };
                /** @description "bad_request": a missing field, a malformed body, or a value out of range; the message names the field. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/dashboard/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Dashboard module catalog and presets
         * @description The one definition of the command center's modules (in canonical order, with
         *     their grid size) and presets. The UI reads it from here.
         *     For a User: only modules that work on their devices (no fleet history charts, no wall display).
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The catalog. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DashboardCatalog"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Live event stream (server-sent events)
         * @description A `text/event-stream` that stays open until the client disconnects. It starts with
         *     `retry: 3000`, then carries one message per change, written as
         *     `event: <type>` and `data: <json>` where the JSON is a
         *     [LiveEvent](#/components/schemas/LiveEvent) (`#/components/schemas/LiveEvent`)
         *     whose `type` is the event name: IDs only, so the client refetches what it shows.
         *     Types: `device.updated` (an admin change, or new sysinfo details),
         *     `device.enrolled`, `device.online`, `device.offline`, `session.started`,
         *     `session.updated` (the peer authenticated: peer and type are known),
         *     `session.ended`, `audit.created`, `preferences.updated` (sent only to the admin
         *     whose preferences changed). A `: ping` comment is sent every 25 seconds. When
         *     events may have been missed (the client read too slowly, the server's event
         *     listener reconnected, or the server is shutting down) the server sends
         *     `event: resync` with `data: {"type":"resync"}` and ends the stream; the client
         *     reconnects and refetches. At most 5 streams per session and 20 per user; excess
         *     streams are refused with 429.
         *     The response headers are `Cache-Control: no-store` and `X-Accel-Buffering: no`.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The event stream. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                /** @description The per-session or per-user stream cap is already open ("rate_limited"). */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/api/v1/me/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The signed-in admin's dashboard preferences
         * @description With nothing stored, the business preset. Stored preferences are reconciled with
         *     the catalog: unknown modules are dropped and modules the catalog gained are
         *     appended, disabled. Pinned devices that no longer exist or are not approved are
         *     dropped.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The preferences. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Preferences"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        /**
         * Replace the signed-in admin's dashboard preferences
         * @description Replaces the preferences; the body is at most 16 KiB. palette may be left out to keep
         *     the stored one (default for an admin who never saved preferences); toast_seconds may be
         *     left out to keep its stored value. Not audited (a personal setting). Returns the preferences
         *     as GET would, including toast_seconds.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PreferencesPut"];
                };
            };
            responses: {
                /** @description The saved preferences, normalized. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Preferences"];
                    };
                };
                /** @description "bad_request": a missing field, a malformed or oversize body, an unknown or repeated module, more than 24 or repeated pins, or a value outside its enum. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                401: components["responses"]["Unauthenticated"];
                403: components["responses"]["Forbidden"];
                500: components["responses"]["Internal"];
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            error: {
                /** @enum {string} */
                code: "bad_request" | "validation_error" | "weak_password" | "invalid_key" | "invalid_code" | "code_already_used" | "unauthenticated" | "csrf" | "mfa_required" | "totp_enroll_required" | "forbidden" | "reauthentication_required" | "not_found" | "incomplete" | "bad_transition" | "session_ended" | "last_owner" | "no_password" | "cycle" | "not_empty" | "username_taken" | "name_taken" | "pattern_taken" | "in_use" | "default_policy" | "window_open" | "push_off" | "always_reachable" | "access_locked" | "locked" | "rate_limited" | "internal" | "busy";
                message: string;
                /** @description Present for "internal"; matches the X-Request-ID header and the server log. */
                request_id?: string;
            };
        };
        User: {
            /** Format: uuid */
            id: string;
            username: string;
            display_name: string;
            email: string;
            /** @enum {string} */
            role: "owner" | "admin" | "user";
            /** @enum {string} */
            status: "active" | "disabled";
            totp_required: boolean;
            /** @description True when the account is linked to the OIDC provider. */
            sso: boolean;
            /** @description Path of the user's photo (GET /users/{id}/avatar?v=<version>), or null when there is none. */
            avatar_url: string | null;
        };
        UserRef: {
            /** Format: uuid */
            id: string;
            display_name: string;
        };
        /** @description Catalog keys of GET /deployment/profile's catalog mapped to one of that setting's values (Y/N for bool settings); approve-mode and verification-method are required. */
        PolicySettings: {
            [key: string]: string;
        };
        Policy: {
            /** Format: uuid */
            id: string;
            name: string;
            is_default: boolean;
            settings: components["schemas"]["PolicySettings"];
            /** Format: date-time */
            updated_at: string;
            updated_by: components["schemas"]["UserRef"] | null;
        };
        SessionSettings: {
            /**
             * @description How long a sign-in lasts. browser = until the browser closes (5 minutes without an open console tab), at most 7 days.
             * @enum {string}
             */
            lifetime: "browser" | "8h" | "1d" | "7d" | "30d";
            /**
             * Format: date-time
             * @description Null until first changed.
             */
            updated_at: string | null;
            updated_by: components["schemas"]["UserRef"] | null;
        };
        PolicyPush: {
            enabled: boolean;
            /** Format: date-time */
            updated_at: string;
            updated_by: components["schemas"]["UserRef"] | null;
        };
        LogExportSettings: {
            file: {
                enabled: boolean;
            };
            syslog: {
                enabled: boolean;
                /** @description Host name or IP address of the collector; may be empty only while off. */
                host: string;
                /** @description 6514 is usual with TLS */
                port: number;
                /** @description TLS 1.2 or later; the collector's host name is verified. */
                tls: boolean;
                /** @description Extra CA certificates (PEM) trusted besides the system roots; empty for none. */
                ca_pem: string;
                /** @enum {string} */
                facility: "kern" | "user" | "mail" | "daemon" | "auth" | "syslog" | "lpr" | "news" | "uucp" | "cron" | "authpriv" | "ftp" | "local0" | "local1" | "local2" | "local3" | "local4" | "local5" | "local6" | "local7";
                /**
                 * @description json sends the whole event; text sends key=value pairs followed by an escaped and quoted msg sentence.
                 * @enum {string}
                 */
                format: "json" | "text";
            };
        };
        LogExportOutputStatus: {
            /** @description Events waiting for this output; 0 while it is off. */
            pending: number;
            /**
             * Format: date-time
             * @description Null until the first delivery since the server started.
             */
            last_delivered_at: string | null;
            /** @description The last delivery error; cleared by the next successful delivery. */
            last_error: string | null;
            /** Format: date-time */
            last_error_at: string | null;
        };
        LogExport: {
            settings: components["schemas"]["LogExportSettings"];
            status: {
                file: components["schemas"]["LogExportOutputStatus"];
                syslog: components["schemas"]["LogExportOutputStatus"];
            };
            /** Format: date-time */
            updated_at: string;
            updated_by: components["schemas"]["UserRef"] | null;
        };
        LogExportTestResult: {
            ok: boolean;
            /** @description Null when ok. */
            error: string | null;
        };
        AccessWindow: {
            /** Format: uuid */
            id: string;
            /** @description null for a User, who cannot see who opened the window. */
            opened_by: components["schemas"]["UserRef"] | null;
            /** Format: date-time */
            opened_at: string;
            /** Format: date-time */
            ends_at: string | null;
            disconnect_on_close: boolean;
        };
        DevicePolicyStatus: {
            push_enabled: boolean;
            policy: {
                /** Format: uuid */
                id: string;
                name: string;
            };
            /** @enum {string} */
            source: "group" | "parent_group" | "default";
            /** @description null for a User when the source group is outside their visible groups. */
            source_group: {
                /** Format: uuid */
                id: string;
                name: string;
            } | null;
            effective_settings: components["schemas"]["PolicySettings"];
            /** @enum {string} */
            status: "applied" | "pending" | "off";
            /**
             * @description unrestricted: Policy does not restrict Connect.
             *     window: An open, unexpired access window allows Connect.
             *     attended: Someone at the device can accept.
             *     locked: Policy refuses password-only access.
             * @enum {string}
             */
            connect: "unrestricted" | "window" | "attended" | "locked";
            always_reachable: boolean;
            window: components["schemas"]["AccessWindow"] | null;
            /**
             * Format: date-time
             * @description A closed window the device has not confirmed; until it does, it may still accept password logins.
             */
            close_unconfirmed_since: string | null;
        };
        UserGrants: {
            /** @description Granted groups; each covers its subgroups and their devices. */
            group_ids: string[];
            /** @description Devices granted one by one. */
            device_ids: string[];
        };
        CSRFToken: {
            /** @description The session's new CSRF token; the session was rotated, so the previous token no longer works. */
            csrf_token: string;
        };
        Code: {
            code: string;
        };
        TOTPEnrollRequest: {
            /** @description Required to re-enroll TOTP for an account with a password. */
            current_password?: string;
        };
        TOTPSecret: {
            /** @description Base32, no padding. */
            secret: string;
            /** @description otpauth://totp/ferricade:<username>?secret=...&issuer=ferricade */
            otpauth_url: string;
        };
        Tag: {
            /** Format: uuid */
            id: string;
            /** @description Unique, compared case-insensitively. */
            name: string;
            /**
             * Format: int64
             * @description ARGB as an unsigned 32-bit value, e.g. 4280391411 (0xFF2196F3).
             */
            color: number;
        };
        Alert: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "uuid_mismatch" | "access_window_unconfirmed" | "group_conflict";
            /** @description The uuid the client sent */
            seen_uuid: string | null;
            /** @description The address the mismatching request came from. */
            ip: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            window_closed_at: string | null;
            /** @description group_conflict: the matching groups that still exist; empty for other kinds. */
            groups: components["schemas"]["GroupRef"][];
        };
        Device: {
            /** Format: uuid */
            id: string;
            rustdesk_id: string;
            /** @description The client uuid the device is pinned to. */
            uuid: string;
            /** @enum {string} */
            state: "pending" | "approved" | "rejected" | "archived";
            alias: string;
            hostname: string;
            os: string;
            cpu: string;
            memory: string;
            client_version: string;
            username: string;
            note: string;
            /** Format: uuid */
            group_id: string | null;
            /** Format: date-time */
            first_seen_at: string;
            /**
             * Format: date-time
             * @description Last heartbeat as stored; written every 30 s.
             */
            last_seen_at: string;
            /** Format: uuid */
            approved_by: string | null;
            /** Format: date-time */
            approved_at: string | null;
            /** Format: date-time */
            updated_at: string;
            tags: components["schemas"]["Tag"][];
            open_alerts: components["schemas"]["Alert"][];
            /** @description A heartbeat within 45 s, or reported online by hbbs. */
            online: boolean;
            /** @description Connection ids from the device's last heartbeat. */
            conns: number[];
        };
        IdAllowList: {
            /** @description Duplicate IDs are rejected ignoring case. */
            ids: string[];
        };
        DeviceIdAllowList: {
            ids: string[];
            effective: {
                id: string;
                /** @enum {string} */
                source: "global" | "group" | "device";
                /** Format: uuid */
                group_id: string | null;
                group_name: string | null;
            }[];
        };
        AutoSortResult: {
            /** @description By hostname. */
            moves: {
                device: components["schemas"]["RuleDeviceRef"];
                from_group: components["schemas"]["GroupRef"] | null;
                to_group: components["schemas"]["GroupRef"];
            }[];
            /** @description By hostname. Not moved; flagged with a group_conflict alert. */
            conflicts: {
                device: components["schemas"]["RuleDeviceRef"];
                groups: components["schemas"]["GroupRef"][];
            }[];
            unchanged: number;
        };
        GroupRef: {
            /** Format: uuid */
            id: string;
            name: string;
        };
        GroupRuleInput: {
            /** @description Wildcards: * any run of characters, ? exactly one. */
            pattern: string;
        };
        GroupRule: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            group_id: string;
            pattern: string;
            /** Format: date-time */
            created_at: string;
            created_by: components["schemas"]["UserRef"] | null;
        };
        RuleDeviceRef: {
            /** Format: uuid */
            id: string;
            rustdesk_id: string;
            hostname: string;
            alias: string;
            /** @enum {string} */
            state: "pending" | "approved";
            /** Format: uuid */
            group_id: string | null;
        };
        GroupRulePreview: {
            match_count: number;
            conflict_count: number;
            /** @description By hostname; at most 200. */
            matches: components["schemas"]["RuleDeviceRef"][];
            /** @description Matching devices that another group's patterns also match. */
            conflicts: {
                device: components["schemas"]["RuleDeviceRef"];
                groups: components["schemas"]["GroupRef"][];
            }[];
        };
        Group: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            parent_id: string | null;
            /** @description Unique among siblings. */
            name: string;
            /**
             * Format: uuid
             * @description The group's own policy.
             */
            policy_id: string | null;
            /**
             * Format: uuid
             * @description The nearest assigned ancestor policy
             */
            readonly effective_policy_id: string;
            /** @description Child groups by name (filled by GET /groups; empty elsewhere). */
            children: components["schemas"]["Group"][];
        };
        Server: {
            /** Format: uuid */
            id: string;
            name: string;
            id_host: string;
            relay_host: string;
            public_key: string;
            /** @description Client API address given to clients; empty means http://<id host>:<client API port>. */
            api_url: string;
            /** @description Connect links and commands name the ID server and key. False gives plain rustdesk://<id> links. */
            links_include_server: boolean;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        AuditEvent: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            at: string;
            /**
             * Format: uuid
             * @description Null for clients and the setup wizard.
             */
            actor_user_id: string | null;
            actor_ip: string;
            /** @description For example device.approved, device.id_blocked, device.id_blocked_repeated, device.id_blocked_overflow, device.login_locked_out, device.login_locked_out_repeated, user.updated, tag.created. */
            action: string;
            target_type: string;
            target_id: string;
            /** @description Action-specific, so open; changes carry {before, after} of the changed fields. */
            details: {
                [key: string]: unknown;
            };
        };
        RemoteSession: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            device_id: string;
            /** @description The device alias, else its hostname, else its rustdesk_id. */
            device_name: string;
            /** @description The device's RustDesk ID. */
            rustdesk_id: string;
            /** @description RustDesk ID of the connecting peer; "" until it authenticated. */
            peer_rustdesk_id: string;
            peer_name: string;
            /** @enum {string} */
            type: "remote" | "file_transfer" | "port_forward" | "camera" | "terminal" | "unknown";
            /** @description Address of the connecting peer */
            client_ip: string | null;
            /** Format: date-time */
            started_at: string;
            /** Format: date-time */
            authed_at: string | null;
            /**
             * Format: date-time
             * @description Null while the session is open.
             */
            ended_at: string | null;
            /**
             * @description disconnected: an admin had requested a disconnect when the session ended.
             * @enum {string|null}
             */
            end_reason: "closed" | "stale" | "disconnected" | null;
            /**
             * Format: date-time
             * @description When an admin asked for the session to be disconnected; null if nobody did.
             */
            disconnect_requested_at: string | null;
            /** @description To ended_at, or to now while open. */
            duration_seconds: number;
        };
        SessionStats: {
            /** @enum {string} */
            range: "7d" | "30d";
            tz: string;
            /** @description One entry per day of the range, oldest first, zero days included. */
            per_day: {
                /** Format: date */
                day: string;
                count: number;
                total_seconds: number;
            }[];
            /** @description Mean session duration; 0 without sessions. */
            average_seconds: number;
            /** @description By total_seconds, descending. */
            top_devices: {
                /** Format: uuid */
                device_id: string;
                device_name: string;
                count: number;
                total_seconds: number;
            }[];
        };
        FleetHistory: {
            /** @enum {string} */
            range: "24h" | "7d" | "30d";
            /** @enum {integer} */
            step_seconds: 300 | 3600 | 21600;
            points: {
                /**
                 * Format: date-time
                 * @description Start of the bucket.
                 */
                at: string;
                approved: number;
                online: number;
                pending: number;
                /** @description Peak of open, authenticated sessions of approved devices. */
                sessions: number;
            }[];
        };
        DashboardThresholds: {
            /** @description An approved device that is offline and was last seen longer ago than this needs attention. */
            offline_days: number;
            /** @description A pending device waiting longer than this needs attention. */
            pending_hours: number;
            /** @description Approved devices with an older client version need attention. "" turns it off. */
            min_client_version: string;
        };
        /** @enum {string} */
        DashboardModuleId: "fleet-pulse" | "quick-connect" | "approval-queue" | "needs-attention" | "live-sessions" | "activity-trend" | "fleet-overview" | "recent-sessions" | "session-analytics" | "platform-mix" | "admin-activity";
        /** @enum {string} */
        DashboardModuleSize: "small" | "medium" | "large";
        /** @description The dashboard is a grid of 4 columns and fixed-height rows. Each module offers its own sizes, as columns x rows of that grid. */
        DashboardCatalog: {
            modules: {
                id: components["schemas"]["DashboardModuleId"];
                default_size: components["schemas"]["DashboardModuleSize"];
                /** @description Small to large; a module offers some or all three. */
                sizes: {
                    name: components["schemas"]["DashboardModuleSize"];
                    cols: number;
                    rows: number;
                }[];
            }[];
            presets: {
                /** @enum {string} */
                id: "homelab" | "business" | "wall";
                name: string;
                /** @description The preset's modules, enabled, in order and at these sizes. */
                modules: {
                    id: components["schemas"]["DashboardModuleId"];
                    size: components["schemas"]["DashboardModuleSize"];
                }[];
            }[];
        };
        Preferences: {
            /** @enum {string} */
            preset: "homelab" | "business" | "wall" | "custom";
            /** @description Every catalog module once, in display order. */
            modules: {
                id: components["schemas"]["DashboardModuleId"];
                enabled: boolean;
                /** @description One of the module's sizes in GET /dashboard/catalog. Responses always carry it; a PUT may leave it out for the module's default_size. */
                size: components["schemas"]["DashboardModuleSize"];
            }[];
            pinned_device_ids: string[];
            /**
             * @description The colour mode.
             * @enum {string}
             */
            theme: "dark" | "light" | "system";
            /**
             * @description The colour theme; ferricade is the default, and each palette has light and dark variants. Responses always carry it; a PUT may leave it out to keep the stored palette.
             * @enum {string}
             */
            palette: "ferricade" | "indigo" | "graphite" | "ocean" | "violet" | "moss" | "sandstone";
            /** @enum {string} */
            density: "comfortable" | "compact";
            /**
             * @description How long notifications stay before closing on their own; 0 = until closed. Default 5. Responses always carry it; a PUT may leave it out to keep the stored value.
             * @enum {integer}
             */
            toast_seconds: 0 | 3 | 5 | 10 | 30;
        };
        PreferencesPut: {
            preset: components["schemas"]["Preferences"]["preset"];
            modules: components["schemas"]["Preferences"]["modules"];
            pinned_device_ids: components["schemas"]["Preferences"]["pinned_device_ids"];
            theme: components["schemas"]["Preferences"]["theme"];
            palette?: components["schemas"]["Preferences"]["palette"];
            density: components["schemas"]["Preferences"]["density"];
            toast_seconds?: components["schemas"]["Preferences"]["toast_seconds"];
        };
        FleetMap: {
            /** Format: date-time */
            generated_at: string;
            truncated: boolean;
            devices: components["schemas"]["FleetMapDevice"][];
        };
        FleetMapDevice: {
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: uuid */
            group_id: string | null;
            /** @enum {string} */
            status: "alert" | "offline" | "online";
        };
        FleetSummary: {
            /** Format: date-time */
            generated_at: string;
            devices: {
                approved: number;
                pending: number;
                rejected: number;
                archived: number;
                /** @description Approved devices that are online. */
                online: number;
            };
            sessions: {
                /** @description Open */
                active: number;
            };
            alerts: {
                open: number;
            };
            /** @description Approved devices by operating system, most devices first (ties by name), Other last. Linux devices are listed by distribution when the client reports one (Ubuntu, Debian, ...); Linux when it reports none; Other only when the OS is empty or unknown. */
            os: {
                name: string;
                count: number;
            }[];
            /** @description Approved devices by client version, newest first; "unknown" (no version reported) last and never outdated. */
            versions: {
                version: string;
                count: number;
                /** @description Below the owner's minimum client version. */
                outdated: boolean;
            }[];
            /** @description Approved devices per group, sorted by name; the "Ungrouped" entry (id null) comes last and only when it has devices. */
            groups: {
                /** Format: uuid */
                id: string | null;
                name: string;
                online: number;
                total: number;
            }[];
            /** @description Sorted by kind in the order below, then oldest since first. */
            attention: {
                /**
                 * @description uuid_mismatch: an open alert (since = when it was raised).
                 *     access_window_unconfirmed: an open access_window_unconfirmed alert; since = when it was raised.
                 *     group_conflict: an open group_conflict alert; since = when it was raised; detail = the matching groups.
                 *     pending_long: pending
                 *     longer than pending_hours (since = first seen). offline_long: approved, offline and
                 *     last seen longer ago than offline_days (since = last seen). outdated_client:
                 *     approved and below min_client_version (since = first seen).
                 * @enum {string}
                 */
                kind: "uuid_mismatch" | "access_window_unconfirmed" | "group_conflict" | "pending_long" | "offline_long" | "outdated_client";
                /** Format: uuid */
                device_id: string;
                rustdesk_id: string;
                /** @description Alias, else hostname, else RustDesk ID. */
                name: string;
                /** Format: date-time */
                since: string;
                /** @description A short sentence for display. */
                detail: string;
            }[];
        };
        /** @description The data of one message of the /events stream; the message's event name is its type. Only the IDs the type concerns are set: device_id for device.*, session_id and device_id for session.*, audit_id for audit.created, user_id for preferences.updated, none for group_rules.updated, id_allow_list.updated and resync. */
        LiveEvent: {
            /** @enum {string} */
            type: "device.updated" | "device.enrolled" | "device.deleted" | "device.online" | "device.offline" | "session.started" | "session.updated" | "session.ended" | "audit.created" | "preferences.updated" | "group_rules.updated" | "id_allow_list.updated" | "resync";
            /** Format: uuid */
            device_id?: string;
            /** Format: uuid */
            session_id?: string;
            /** Format: uuid */
            audit_id?: string;
            /** Format: uuid */
            user_id?: string;
        };
        /** @description Cursor of the next page; "" on the last page. */
        NextCursor: string;
        Check: {
            /** @enum {string} */
            name: "id-server" | "relay" | "client-api" | "hbbs-online-query";
            ok: boolean;
            /** @description Error text of a failed check; empty when ok. */
            detail: string;
            /** @description host:port the check dialed, as configured; empty for a User. */
            target: string;
            /** @description IP:port actually connected to, or where the dial failed; empty when the name did not resolve, and for a User. */
            address: string;
            /**
             * @description Why a failed check failed; null when ok.
             * @enum {string|null}
             */
            reason: "dns" | "refused" | "timeout" | "unreachable" | "other" | null;
        };
        ServerHealth: {
            /**
             * @description ok: every check of the latest round passed. degraded: at least one failed.
             *     unknown: no round has finished yet (just started, or setup is not complete).
             * @enum {string}
             */
            status: "ok" | "degraded" | "unknown";
            /**
             * Format: date-time
             * @description When the latest round finished; null while unknown.
             */
            checked_at: string | null;
            /** @description The latest round, in the order of POST /server/check; empty while unknown. */
            checks: components["schemas"]["HealthCheck"][];
        };
        HealthCheck: {
            /** @enum {string} */
            name: "id-server" | "relay" | "client-api" | "hbbs-online-query";
            ok: boolean;
            /** @description Error text of a failed check; empty when ok */
            detail: string;
            /** @description host:port the check dialed, as configured; empty for a User. */
            target: string;
            /** @description IP:port actually connected to, or where the dial failed; empty when the name did not resolve, and for a User. */
            address: string;
            /**
             * @description Why a failed check failed; null when ok.
             * @enum {string|null}
             */
            reason: "dns" | "refused" | "timeout" | "unreachable" | "other" | null;
            /**
             * Format: date-time
             * @description When this check last changed between passing and failing (its first round if it never changed).
             */
            since: string;
        };
        ClientConfig: {
            /**
             * @description reverse(base64url_nopad(JSON {host, relay, api, key})), as the RustDesk client imports it:
             *     paste it in Settings → Network → ID/Relay server → "Import server config".
             */
            config_string: string;
            /**
             * @description rustdesk://config/<config_string>. Mobile clients only, and only those built with the
             *     option that accepts config links; the 1.5.0 desktop client ignores it.
             */
            deep_link: string;
            /** @description api_url when set, otherwise http://<id host>:<client API port> */
            api: string;
            host: string;
            relay: string;
            key: string;
            install: {
                windows: string;
                macos: string;
                linux: string;
            };
        };
        OIDCPublic: {
            enabled: boolean;
            /** @description The sign-in button's label */
            display_name: string;
        };
        OIDCTestResult: {
            /** Format: date-time */
            tested_at: string;
            ok: boolean;
            /**
             * @description Null when ok.
             * @enum {string|null}
             */
            error: "unreachable" | "bad_status" | "not_json" | "issuer_mismatch" | "missing_endpoints" | null;
            authorization_endpoint: string | null;
            token_endpoint: string | null;
            userinfo_endpoint: string | null;
            groups_scope_supported: boolean;
        };
        OIDCSettings: {
            enabled: boolean;
            display_name: string;
            /** @description Empty until set. */
            issuer: string;
            client_id: string;
            /** @description The secret itself is never returned. */
            client_secret_set: boolean;
            /** @description <PUBLIC_URL>/admin/api/v1/auth/oidc/callback, to register at the provider. */
            redirect_uri: string;
            groups_claim: string;
            owner_groups: string[];
            admin_groups: string[];
            user_groups: string[];
            jit_enabled: boolean;
            last_test: components["schemas"]["OIDCTestResult"] | null;
            /** Format: date-time */
            updated_at: string | null;
        };
        DeploymentSecretState: {
            /** @description A value is stored. After a SECRET_KEY change it may be unreadable; the script download then fails with bad_request until the value is set again. */
            set: boolean;
            /** Format: date-time */
            set_at: string | null;
            set_by: {
                /** Format: uuid */
                id: string;
                display_name: string;
            } | null;
        };
        DeploymentSetting: {
            key: string;
            label: string;
            help: string;
            /** @enum {string} */
            type: "bool" | "enum";
            values: string[];
            value_labels: {
                [key: string]: string;
            };
            default: string;
            os: ("windows" | "linux" | "macos")[];
            source: string;
        };
        DeploymentSettingValue: {
            include: boolean;
            value: string;
        };
        DeploymentEditable: {
            /** @enum {string} */
            installer_source: "github" | "url";
            /** @description latest: the script asks GitHub for the newest RustDesk release each time it runs (GitHub installer source only); otherwise major.minor.patch. */
            client_version: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_windows. */
            url_windows: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_deb. */
            url_deb: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_rpm. */
            url_rpm: string;
            /** @description SHA-256 required when url_windows is not HTTPS. */
            sha256_windows: string;
            /** @description SHA-256 required when url_deb is not HTTPS. */
            sha256_deb: string;
            /** @description SHA-256 required when url_rpm is not HTTPS. */
            sha256_rpm: string;
            allow_downgrade: boolean;
            include_install: boolean;
            /** @description When true, the script sets the stored fleet password, or removes the device's permanent password when none is stored. When false, the script leaves it unchanged. */
            include_password: boolean;
            /** @description When true, the script sets the stored unlock PIN, or removes the device's unlock PIN when none is stored. When false, the script leaves it unchanged. */
            include_unlock_pin: boolean;
            /** @description When true, the script sets the device's ID allow list (`id-whitelist`) to the global ID allow list as it is when the script is generated. Nothing is set when the list is empty. */
            include_id_allow_list: boolean;
            settings: {
                [key: string]: components["schemas"]["DeploymentSettingValue"];
            };
        };
        DeploymentProfile: {
            /** @enum {string} */
            installer_source: "github" | "url";
            /** @description latest: the script asks GitHub for the newest RustDesk release each time it runs (GitHub installer source only); otherwise major.minor.patch. */
            client_version: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_windows. */
            url_windows: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_deb. */
            url_deb: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_rpm. */
            url_rpm: string;
            /** @description SHA-256 required when url_windows is not HTTPS. */
            sha256_windows: string;
            /** @description SHA-256 required when url_deb is not HTTPS. */
            sha256_deb: string;
            /** @description SHA-256 required when url_rpm is not HTTPS. */
            sha256_rpm: string;
            allow_downgrade: boolean;
            include_install: boolean;
            /** @description When true, the script sets the stored fleet password, or removes the device's permanent password when none is stored. When false, the script leaves it unchanged. */
            include_password: boolean;
            /** @description When true, the script sets the stored unlock PIN, or removes the device's unlock PIN when none is stored. When false, the script leaves it unchanged. */
            include_unlock_pin: boolean;
            /** @description When true, the script sets the device's ID allow list (`id-whitelist`) to the global ID allow list as it is when the script is generated. Nothing is set when the list is empty. */
            include_id_allow_list: boolean;
            settings: {
                [key: string]: components["schemas"]["DeploymentSettingValue"];
            };
            catalog: components["schemas"]["DeploymentSetting"][];
            password: components["schemas"]["DeploymentSecretState"];
            unlock_pin: components["schemas"]["DeploymentSecretState"];
            /** Format: date-time */
            updated_at: string | null;
        };
        DeploymentProfilePut: {
            /** @enum {string} */
            installer_source: "github" | "url";
            /** @description latest: the script asks GitHub for the newest RustDesk release each time it runs (GitHub installer source only); otherwise major.minor.patch. */
            client_version: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_windows. */
            url_windows: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_deb. */
            url_deb: string;
            /** @description Installer URL; non-HTTPS URLs require sha256_rpm. */
            url_rpm: string;
            /** @description SHA-256 required when url_windows is not HTTPS. */
            sha256_windows: string;
            /** @description SHA-256 required when url_deb is not HTTPS. */
            sha256_deb: string;
            /** @description SHA-256 required when url_rpm is not HTTPS. */
            sha256_rpm: string;
            allow_downgrade: boolean;
            include_install: boolean;
            /** @description When true, the script sets the stored fleet password, or removes the device's permanent password when none is stored. When false, the script leaves it unchanged. */
            include_password: boolean;
            /** @description When true, the script sets the stored unlock PIN, or removes the device's unlock PIN when none is stored. When false, the script leaves it unchanged. */
            include_unlock_pin: boolean;
            /** @description When true, the script sets the device's ID allow list (`id-whitelist`) to the global ID allow list as it is when the script is generated. Nothing is set when the list is empty. */
            include_id_allow_list: boolean;
            settings: {
                [key: string]: components["schemas"]["DeploymentSettingValue"];
            };
            fleet_password?: string | null;
            unlock_pin?: string | null;
        };
    };
    responses: {
        /** @description The device. */
        Device: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Device"];
            };
        };
        /** @description The group. */
        Group: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Group"];
            };
        };
        /** @description The tag. */
        Tag: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Tag"];
            };
        };
        /** @description The user. Password hashes and TOTP secrets are never returned. */
        User: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["User"];
            };
        };
        /** @description The server profile. */
        Server: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Server"];
            };
        };
        /**
         * @description Malformed body (unknown field, wrong type, trailing data, over 64 KiB), an invalid
         *     field, or, for a change (which is audited with the client's address), a client
         *     address that cannot be determined.
         */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description No valid session (or setup token). */
        Unauthenticated: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description "csrf", "mfa_required", "totp_enroll_required", "forbidden" or "reauthentication_required". */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Not found; for /setup, setup is already complete. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description An earlier step is missing. */
        Incomplete: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Too many consecutive failures; the lock lasts 1 minute and doubles with each further failure, up to 1 hour. */
        Locked: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description 20 failed attempts from this address (an IPv6 /64) within 10 minutes. */
        RateLimited: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Internal error; the body carries request_id. */
        Internal: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description "busy": every password-hashing slot stayed taken for 2 seconds. Nothing was
         *     checked or counted as a failure; retry after the Retry-After delay (1 s).
         */
        Busy: {
            headers: {
                "Retry-After"?: 1;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        /** @description Resource ID; anything but a UUID is 404. */
        id: string;
        /** @description Page size; default 50, at most 200 are returned. */
        limit: number;
        /** @description The previous page's next_cursor. */
        cursor: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getDevicePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Device policy status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DevicePolicyStatus"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
        };
    };
    openAccessWindow: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {integer|null} */
                    duration_minutes: 60 | 240 | 480 | null;
                    disconnect_on_close: boolean;
                };
            };
        };
        responses: {
            /** @description Open access window. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccessWindow"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description "window_open", "push_off", "always_reachable", or "bad_transition". */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            500: components["responses"]["Internal"];
        };
    };
    closeAccessWindow: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource ID; anything but a UUID is 404. */
                id: components["parameters"]["id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    disconnect: boolean;
                };
            };
        };
        responses: {
            /** @description Closed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
        };
    };
}
