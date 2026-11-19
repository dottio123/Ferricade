# Completes ferricade's first-run setup (README "Complete setup") from PowerShell,
# for the Compose stack in deploy/. Your password and TOTP code are read from
# the terminal and never printed.
#
#   pwsh -File scripts/setup.ps1 -AdminUrl http://203.0.113.10:21120 -IdHost 203.0.113.10
#
# -IdHost/-RelayHost are the addresses RustDesk clients reach hbbs/hbbr at.
# The hbbs public key is read from the hbbs container (Compose profile
# "rustdesk"); pass -PublicKey when you run hbbs elsewhere.
param(
    [Parameter(Mandatory)] [string] $AdminUrl,   # your PUBLIC_URL
    [Parameter(Mandatory)] [string] $IdHost,
    [string] $RelayHost = $IdHost,
    [string] $PublicKey = '',
    [string] $EnvFile = "$PSScriptRoot/../deploy/.env",
    [string] $ComposeFile = "$PSScriptRoot/../deploy/compose.yml"
)
$ErrorActionPreference = 'Stop'
$AdminUrl = $AdminUrl.TrimEnd('/')
$dc = @('compose', '--env-file', $EnvFile, '-f', $ComposeFile)

# The newest setup token from the app log (a restart issues a new one).
$line = docker @dc logs app --no-log-prefix 2>&1 | Select-String 'setup token: ' | Select-Object -Last 1
if (-not $line -or $line.Line -notmatch 'setup token: ([^\s"\\]+)') {
    throw 'No setup token in the app log. Is the app running, or is setup already complete?'
}
$token = $Matches[1]

function Setup([string]$path, $body) {
    $req = @{
        Uri = "$AdminUrl/setup$path"; Method = 'Post'; SkipHttpErrorCheck = $true
        StatusCodeVariable = 'code'; ContentType = 'application/json'
        Headers = @{ Origin = $AdminUrl; 'X-Setup-Token' = $token }
    }
    if ($null -ne $body) { $req.Body = ($body | ConvertTo-Json -Compress) }
    $r = Invoke-RestMethod @req
    if ($code -ge 300) { throw "/setup$path -> HTTP $code $($r | ConvertTo-Json -Compress -Depth 5)" }
    $r
}

if (-not $PublicKey) {
    # The rustdesk-server image has no shell tools (no cat), so copy the file out.
    $tmp = New-TemporaryFile
    try {
        docker @dc cp hbbs:/root/id_ed25519.pub $tmp.FullName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy id_ed25519.pub from the hbbs container; pass -PublicKey.' }
        $PublicKey = (Get-Content $tmp.FullName -Raw).Trim()
    } finally { Remove-Item $tmp.FullName -ErrorAction SilentlyContinue }
}

# 1. Owner account.
$user = Read-Host 'Owner username [owner]'; if (-not $user) { $user = 'owner' }
$name = Read-Host "Display name [$user]"; if (-not $name) { $name = $user }
$pw = [Net.NetworkCredential]::new('', (Read-Host 'Password (12+ chars, not common, not the username)' -AsSecureString)).Password
$null = Setup '/owner' @{ username = $user; password = $pw; display_name = $name; email = '' }
$pw = $null
Write-Host "1/5 owner '$user' created" -ForegroundColor Green

# 2. TOTP secret.
$t = Setup '/owner/totp' $null
Write-Host "`n2/5 Add this to your authenticator app:" -ForegroundColor Green
Write-Host "    secret: $($t.secret)"
Write-Host "    otpauth URL: $($t.otpauth_url)`n"

# 3. Prove it.
$null = Setup '/owner/totp/verify' @{ code = (Read-Host 'Current 6-digit code from the app').Trim() }
Write-Host '3/5 TOTP verified (sign in later with the next code: a code is used once)' -ForegroundColor Green

# 4. RustDesk server profile.
$s = Setup '/server' @{ name = 'main'; id_host = $IdHost; relay_host = $RelayHost; public_key = $PublicKey }
Write-Host '4/5 server saved; reachability checks:' -ForegroundColor Green
$s.checks | ForEach-Object { '    {0,-20} {1}  {2}' -f $_.name, $(if ($_.ok) { 'ok' } else { 'FAILED' }), $_.detail }

# 5. Finish.
$c = (Setup '/complete' $null).client_config
Write-Host "`n5/5 setup complete. Client values:" -ForegroundColor Green
'    ID server:    {0}' -f $c.host
'    Relay server: {0}' -f $c.relay
'    Key:          {0}' -f $c.key
'    API server:   leave empty (the client derives {0})' -f $c.api
"`n    config_string (Settings -> Network -> ID/Relay server -> Import server config):"
"    $($c.config_string)"
