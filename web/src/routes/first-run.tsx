import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, CheckCircle2Icon, CheckIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { setupClient, unwrap } from '@/api/client'
import { ApiError, describeError } from '@/api/errors'
import type { components } from '@/api/schema'
import { TotpEnrollment } from '@/components/auth/totp-enrollment'
import { CopyField } from '@/components/brand/copy-field'
import { ClientConfig } from '@/components/client-config'
import { PasswordRules, passwordRulesMet } from '@/components/password-rules'
import { ServerChecks } from '@/components/server/server-checks'
import { serverHostWarning } from '@/components/server/server-host-hint'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { queryKeys } from '@/lib/queryKeys'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/first-run')({
  component: FirstRunWizard,
})

type SetupStep = 'token' | 'owner' | 'totp' | 'server' | 'finish'

const STEPS: { id: SetupStep; label: string }[] = [
  { id: 'token', label: 'Token' },
  { id: 'owner', label: 'Owner' },
  { id: 'totp', label: 'Two-factor' },
  { id: 'server', label: 'Server' },
  { id: 'finish', label: 'Finish' },
]

const TOKEN_COMMAND =
  'docker compose --env-file deploy/.env -f deploy/compose.yml logs app | grep "setup token"'
const KEY_COMMAND =
  "docker compose --env-file deploy/.env -f deploy/compose.yml logs hbbs | grep -A1 'Key:'"

function FirstRunWizard() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // The one-time setup token is held strictly in React memory
  const [token, setToken] = React.useState<string | null>(null)
  const [step, setStep] = React.useState<SetupStep>('token')
  const [tokenError, setTokenError] = React.useState<string | null>(null)

  // Step 1: Token form state
  const [inputToken, setInputToken] = React.useState('')
  const [showToken, setShowToken] = React.useState(false)

  // Step 2: Owner form state
  const [ownerUsername, setOwnerUsername] = React.useState('')
  const [ownerPassword, setOwnerPassword] = React.useState('')
  const [ownerDisplayName, setOwnerDisplayName] = React.useState('')
  const [ownerEmail, setOwnerEmail] = React.useState('')
  const [ownerError, setOwnerError] = React.useState<string | null>(null)
  const [weakPasswordMessage, setWeakPasswordMessage] = React.useState<string | null>(null)
  const [isCreatingOwner, setIsCreatingOwner] = React.useState(false)

  // Step 4: Server form state
  const defaultHost =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : 'localhost'
  const [serverName, setServerName] = React.useState('')
  const [idHost, setIdHost] = React.useState(defaultHost)
  const [relayHost, setRelayHost] = React.useState(defaultHost)
  const [publicKey, setPublicKey] = React.useState('')
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [isCheckingServer, setIsCheckingServer] = React.useState(false)
  const [serverChecks, setServerChecks] = React.useState<components['schemas']['Check'][] | null>(
    null,
  )

  // Step 5: Finish state
  const [isCompleting, setIsCompleting] = React.useState(false)
  const [completeError, setCompleteError] = React.useState<string | null>(null)
  const [clientConfig, setClientConfig] = React.useState<
    components['schemas']['ClientConfig'] | null
  >(null)

  // Helper when token expires (401 from any setup endpoint)
  const handleTokenExpired = React.useCallback(() => {
    setToken(null)
    setTokenError('That setup token is wrong or has expired. Copy it again from the Ferricade log.')
    setStep('token')
  }, [])

  // Helper when setup is already completed (404 from setup endpoint)
  const handleSetupAlreadyComplete = React.useCallback(async () => {
    queryClient.setQueryData(queryKeys.setupStatus(), { setup_complete: true })
    await navigate({ to: '/sign-in', replace: true })
  }, [navigate, queryClient])

  // --- Step 1 Handlers ---
  const handleTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = inputToken.trim()
    if (!trimmed) return
    setToken(trimmed)
    setTokenError(null)
    setStep('owner')
  }

  // --- Step 2 Handlers ---
  const handleOwnerSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) {
      handleTokenExpired()
      return
    }
    const trimmedUsername = ownerUsername.trim()
    if (!trimmedUsername || !ownerPassword) return

    setIsCreatingOwner(true)
    setOwnerError(null)

    try {
      const client = setupClient(token)
      await unwrap(
        client.POST('/setup/owner', {
          body: {
            username: trimmedUsername,
            password: ownerPassword,
            display_name: ownerDisplayName.trim() || undefined,
            email: ownerEmail.trim() || undefined,
          },
        }),
      )
      setStep('totp')
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          handleTokenExpired()
          return
        }
        if (err.status === 404) {
          await handleSetupAlreadyComplete()
          return
        }
        if (err.code === 'weak_password') {
          setWeakPasswordMessage(err.message || 'That password is too weak or common.')
          return
        }
      }
      setOwnerError(describeError(err).message)
    } finally {
      setIsCreatingOwner(false)
    }
  }

  // --- Step 4 Handlers ---
  const runServerChecks = async () => {
    if (!token) {
      handleTokenExpired()
      return
    }
    const trimmedId = idHost.trim()
    const trimmedRelay = relayHost.trim()
    const trimmedKey = publicKey.trim()

    if (!trimmedId || !trimmedRelay || !trimmedKey) return

    setIsCheckingServer(true)
    setServerError(null)

    try {
      const client = setupClient(token)
      const data = await unwrap(
        client.POST('/setup/server', {
          body: {
            name: serverName.trim() || undefined,
            id_host: trimmedId,
            relay_host: trimmedRelay,
            public_key: trimmedKey,
          },
        }),
      )
      setServerChecks(data.checks)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          handleTokenExpired()
          return
        }
        if (err.status === 404) {
          await handleSetupAlreadyComplete()
          return
        }
        if (err.code === 'invalid_key') {
          setServerError('Public key must be base64 of 32 bytes.')
          return
        }
      }
      setServerError(describeError(err).message)
    } finally {
      setIsCheckingServer(false)
    }
  }

  // --- Step 5 Handlers ---
  const handleFinishSetup = async () => {
    if (!token) {
      handleTokenExpired()
      return
    }

    setIsCompleting(true)
    setCompleteError(null)

    try {
      const client = setupClient(token)
      const data = await unwrap(client.POST('/setup/complete'))
      // Setup successful: cache setupStatus, clear token from state, show client config
      queryClient.setQueryData(queryKeys.setupStatus(), { setup_complete: true })
      setToken(null)
      setClientConfig(data.client_config)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          handleTokenExpired()
          return
        }
        if (err.status === 404) {
          await handleSetupAlreadyComplete()
          return
        }
      }
      setCompleteError(describeError(err).message)
    } finally {
      setIsCompleting(false)
    }
  }

  // Password rules validation (counted as Unicode code points via [...password].length)
  const validOwnerPassword = passwordRulesMet(ownerPassword, ownerUsername.trim())

  const currentStepIndex = STEPS.findIndex((s) => s.id === step)

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-4 sm:p-8">
      <Card className="w-full max-w-xl border-border shadow-lg">
        <CardHeader className="text-center pb-4">
          <CardTitle>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">First-run setup</h1>
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Set up your Ferricade command center in five steps.
          </CardDescription>

          {/* Progress Rail */}
          <nav
            aria-label="Setup steps"
            className="mt-6 flex items-center justify-between px-1 sm:px-4"
          >
            {STEPS.map((s, idx) => {
              const isPast = idx < currentStepIndex
              const isCurrent = idx === currentStepIndex
              return (
                <div key={s.id} className="flex flex-1 items-center last:flex-none">
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        'flex size-7 items-center justify-center rounded-full text-xs transition-colors duration-150',
                        isPast && 'bg-primary text-primary-foreground',
                        isCurrent &&
                          'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-background font-semibold',
                        !isPast &&
                          !isCurrent &&
                          'border border-border text-muted-foreground bg-muted/40',
                      )}
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      {isPast ? <CheckIcon className="size-3.5" /> : idx + 1}
                    </div>
                    <span
                      className={cn(
                        'text-xs select-none',
                        isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {s.label}
                    </span>
                  </div>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={cn(
                        'h-0.5 flex-1 mx-2 transition-colors duration-150',
                        idx < currentStepIndex ? 'bg-primary' : 'bg-border',
                      )}
                    />
                  )}
                </div>
              )
            })}
          </nav>
        </CardHeader>

        <CardContent className="pt-2">
          {/* STEP 1: TOKEN */}
          {step === 'token' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1 text-center sm:text-left">
                <h2 className="text-base font-medium text-foreground">Paste setup token</h2>
                <p className="text-xs text-muted-foreground">
                  Paste the one-time setup token generated when Ferricade started.
                </p>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
                <p className="text-xs text-muted-foreground">
                  Find the setup token in the Ferricade log:
                </p>
                <CopyField value={TOKEN_COMMAND} />
              </div>

              <form onSubmit={handleTokenSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="setup-token"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Setup token
                  </label>
                  <div className="relative flex items-center">
                    <Input
                      id="setup-token"
                      name="token"
                      type={showToken ? 'text' : 'password'}
                      value={inputToken}
                      onChange={(e) => setInputToken(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste setup token"
                      required
                      autoFocus
                      className="pr-10 font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowToken(!showToken)}
                      aria-label={showToken ? 'Hide token' : 'Show token'}
                      className="absolute right-1 size-8 p-0 text-muted-foreground hover:text-foreground"
                    >
                      {showToken ? (
                        <EyeOffIcon className="size-4" />
                      ) : (
                        <EyeIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {tokenError && (
                  <p role="alert" className="text-xs text-center text-destructive">
                    {tokenError}
                  </p>
                )}

                <Button type="submit" disabled={!inputToken.trim()} className="w-full">
                  Continue
                </Button>
              </form>
            </div>
          )}

          {/* STEP 2: OWNER */}
          {step === 'owner' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1 text-center sm:text-left">
                <h2 className="text-base font-medium text-foreground">Create owner account</h2>
                <p className="text-xs text-muted-foreground">
                  The owner has full administrative privileges and can manage other users.
                </p>
              </div>

              <form onSubmit={handleOwnerSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="owner-username"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Username
                  </label>
                  <Input
                    id="owner-username"
                    name="username"
                    value={ownerUsername}
                    onChange={(e) => setOwnerUsername(e.target.value)}
                    autoComplete="username"
                    placeholder="admin"
                    required
                    autoFocus
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="owner-password"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Password
                  </label>
                  <Input
                    id="owner-password"
                    name="password"
                    type="password"
                    maxLength={256}
                    aria-describedby="owner-password-rules"
                    value={ownerPassword}
                    onChange={(e) => {
                      setOwnerPassword(e.target.value)
                      setWeakPasswordMessage(null)
                      setOwnerError(null)
                    }}
                    autoComplete="new-password"
                    required
                  />

                  <PasswordRules
                    id="owner-password-rules"
                    password={ownerPassword}
                    username={ownerUsername.trim()}
                    usernameWording="the"
                    weakPasswordMessage={weakPasswordMessage}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="owner-display-name"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Display name (optional)
                  </label>
                  <Input
                    id="owner-display-name"
                    name="displayName"
                    value={ownerDisplayName}
                    onChange={(e) => setOwnerDisplayName(e.target.value)}
                    placeholder="Administrator"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="owner-email"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Email (optional)
                  </label>
                  <Input
                    id="owner-email"
                    name="email"
                    type="email"
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                    placeholder="admin@example.com"
                  />
                </div>

                {ownerError && (
                  <p role="alert" className="text-xs text-center text-destructive">
                    {ownerError}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={isCreatingOwner || !ownerUsername.trim() || !validOwnerPassword}
                  className="w-full"
                >
                  {isCreatingOwner ? 'Creating owner…' : 'Create owner and continue'}
                </Button>
              </form>
            </div>
          )}

          {/* STEP 3: TOTP */}
          {step === 'totp' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1 text-center sm:text-left">
                <h2 className="text-base font-medium text-foreground">
                  Set up two-factor authentication
                </h2>
                <p className="text-xs text-muted-foreground">
                  Scan the QR code with your authenticator app to secure the owner account.
                </p>
              </div>

              {token && (
                <TotpEnrollment
                  requestSecret={() => unwrap(setupClient(token).POST('/setup/owner/totp'))}
                  verifyCode={(code) =>
                    unwrap(setupClient(token).POST('/setup/owner/totp/verify', { body: { code } }))
                  }
                  onSuccess={() => setStep('server')}
                  onErrorSecret={(err) => {
                    if (err instanceof ApiError) {
                      if (err.status === 401) {
                        handleTokenExpired()
                        return
                      }
                      if (err.status === 404) {
                        void handleSetupAlreadyComplete()
                        return
                      }
                      if (err.status === 409 || err.code === 'incomplete') {
                        setOwnerError('Create the owner account first.')
                        setStep('owner')
                        return
                      }
                    }
                  }}
                  onErrorVerify={(err) => {
                    if (err instanceof ApiError) {
                      if (err.status === 401) {
                        handleTokenExpired()
                        return
                      }
                      if (err.status === 404) {
                        void handleSetupAlreadyComplete()
                        return
                      }
                    }
                  }}
                />
              )}
            </div>
          )}

          {/* STEP 4: SERVER */}
          {step === 'server' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1 text-center sm:text-left">
                <h2 className="text-base font-medium text-foreground">Configure server profile</h2>
                <p className="text-xs text-muted-foreground">
                  Point clients to your RustDesk relay and ID servers.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="server-name"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Profile name (optional)
                  </label>
                  <Input
                    id="server-name"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="default"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="id-host" className="text-xs font-medium text-muted-foreground">
                      ID server host
                    </label>
                    <Input
                      id="id-host"
                      value={idHost}
                      onChange={(e) => {
                        setIdHost(e.target.value)
                        setServerChecks(null)
                      }}
                      placeholder="rd.example.com"
                      required
                    />
                    {serverHostWarning(idHost) && (
                      <p className="text-xs text-muted-foreground">{serverHostWarning(idHost)}</p>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Suggested from current host
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="relay-host"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Relay server host
                    </label>
                    <Input
                      id="relay-host"
                      value={relayHost}
                      onChange={(e) => {
                        setRelayHost(e.target.value)
                        setServerChecks(null)
                      }}
                      placeholder="rd.example.com"
                      required
                    />
                    {serverHostWarning(relayHost) && (
                      <p className="text-xs text-muted-foreground">
                        {serverHostWarning(relayHost)}
                      </p>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Suggested from current host
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="public-key" className="text-xs font-medium text-muted-foreground">
                    Public key
                  </label>
                  <Input
                    id="public-key"
                    value={publicKey}
                    onChange={(e) => {
                      setPublicKey(e.target.value)
                      setServerChecks(null)
                    }}
                    placeholder="Base64 public key"
                    className="font-mono text-xs"
                    required
                  />
                </div>

                <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 p-3">
                  <p className="text-xs text-muted-foreground">
                    Find the public key in the hbbs container log:
                  </p>
                  <CopyField value={KEY_COMMAND} />
                </div>

                {serverError && (
                  <p role="alert" className="text-xs text-center text-destructive">
                    {serverError}
                  </p>
                )}

                {/* Probe results */}
                <ServerChecks checks={serverChecks} isRunning={isCheckingServer} />

                {/* Actions */}
                <div className="flex flex-col gap-2 sm:flex-row">
                  {!serverChecks ? (
                    <Button
                      type="button"
                      onClick={() => void runServerChecks()}
                      disabled={
                        isCheckingServer || !idHost.trim() || !relayHost.trim() || !publicKey.trim()
                      }
                      className="w-full"
                    >
                      {isCheckingServer ? 'Checking server…' : 'Save and check server'}
                    </Button>
                  ) : serverChecks.every((c) => c.ok) ? (
                    <Button type="button" onClick={() => setStep('finish')} className="w-full">
                      Continue
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void runServerChecks()}
                        disabled={isCheckingServer}
                        className="flex-1"
                      >
                        {isCheckingServer ? 'Checking…' : 'Re-check'}
                      </Button>
                      <Button type="button" onClick={() => setStep('finish')} className="flex-1">
                        Continue anyway
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: FINISH */}
          {step === 'finish' && (
            <div className="flex flex-col gap-5">
              {!clientConfig ? (
                // Summary Review Stage
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-1 text-center sm:text-left">
                    <h2 className="text-base font-medium text-foreground">
                      Review and complete setup
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Confirm your configuration before completing first-run setup.
                    </p>
                  </div>

                  <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-4 text-xs">
                    <div className="flex justify-between border-b border-border/50 pb-2">
                      <span className="text-muted-foreground">Owner Account</span>
                      <span className="font-mono font-medium text-foreground">{ownerUsername}</span>
                    </div>
                    <div className="flex justify-between border-b border-border/50 pb-2">
                      <span className="text-muted-foreground">ID Server Host</span>
                      <span className="font-mono font-medium text-foreground">{idHost}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Relay Server Host</span>
                      <span className="font-mono font-medium text-foreground">{relayHost}</span>
                    </div>
                  </div>

                  {completeError && (
                    <p role="alert" className="text-xs text-center text-destructive">
                      {completeError}
                    </p>
                  )}

                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setStep('server')}
                      disabled={isCompleting}
                      className="flex items-center gap-1.5"
                    >
                      <ArrowLeftIcon className="size-3.5" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void handleFinishSetup()}
                      disabled={isCompleting}
                      className="flex-1"
                    >
                      {isCompleting ? 'Completing setup…' : 'Finish setup'}
                    </Button>
                  </div>
                </div>
              ) : (
                // Setup Complete & Client Configuration Stage
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col gap-1 text-center sm:text-left">
                    <div className="flex items-center gap-2">
                      <CheckCircle2Icon className="size-5 text-status-online" />
                      <h2 className="text-base font-medium text-foreground">Setup complete</h2>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Your Ferricade command center is configured and ready to connect devices.
                    </p>
                  </div>

                  <ClientConfig config={clientConfig} />

                  <Button
                    type="button"
                    onClick={() => void navigate({ to: '/sign-in', replace: true })}
                    className="w-full"
                  >
                    Sign in to the command center
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
