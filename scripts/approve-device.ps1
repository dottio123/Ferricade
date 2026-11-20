# Signs in to ferricade like a browser (cookie, Origin, X-CSRF-Token), approves
# a pending device and prints its connect link (README "Approve devices").
# Your password and TOTP code are read from the terminal and never printed.
#
#   pwsh -File scripts/approve-device.ps1 -AdminUrl http://203.0.113.10:21120
param([Parameter(Mandatory)] [string] $AdminUrl)   # your PUBLIC_URL
$ErrorActionPreference = 'Stop'
$AdminUrl = $AdminUrl.TrimEnd('/')
$api  = "$AdminUrl/admin/api/v1"
$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$csrf = ''

function Call([string]$method, [string]$path, $body) {
    $req = @{
        Uri = "$api$path"; Method = $method; WebSession = $script:sess
        SkipHttpErrorCheck = $true; StatusCodeVariable = 'code'
        Headers = @{ Origin = $AdminUrl; 'X-CSRF-Token' = $script:csrf }
    }
    if ($null -ne $body) { $req.Body = ($body | ConvertTo-Json -Compress); $req.ContentType = 'application/json' }
    $r = Invoke-RestMethod @req
    if ($code -ge 300) { throw "$method $path -> HTTP $code $($r | ConvertTo-Json -Compress -Depth 5)" }
    $r
}

# Password, then TOTP; each step rotates the session and its CSRF token.
$user = Read-Host 'Username [owner]'; if (-not $user) { $user = 'owner' }
$pw = [Net.NetworkCredential]::new('', (Read-Host 'Password' -AsSecureString)).Password
$r = Call 'Post' '/auth/login' @{ username = $user; password = $pw }
$pw = $null; $csrf = $r.csrf_token
if ($r.mfa_required) {
    $csrf = (Call 'Post' '/auth/totp' @{ code = (Read-Host 'TOTP code').Trim() }).csrf_token
}
Write-Host "signed in as $user" -ForegroundColor Green

$pending = @((Call 'Get' '/devices?state=pending' $null).items)
if ($pending.Count -eq 0) { Write-Host 'no pending devices'; return }
for ($i = 0; $i -lt $pending.Count; $i++) {
    $d = $pending[$i]
    '[{0}] {1,-12} {2,-16} {3}  online={4}' -f $i, $d.rustdesk_id, $d.hostname, $d.os, $d.online
}
$pick = Read-Host 'Number to approve [0]'; if (-not $pick) { $pick = 0 }
$dev = $pending[[int]$pick]

$a = Call 'Post' "/devices/$($dev.id)/approve" $null
Write-Host "approved $($dev.rustdesk_id) ($($dev.hostname)): state=$($a.state) online=$($a.online)" -ForegroundColor Green

$c = Call 'Get' "/devices/$($dev.id)/connect" $null
"connect url: $($c.url)"
"command:     $($c.command)"
if ((Read-Host 'Open the link with the RustDesk client on this machine? [y/N]') -match '^[yY]') { Start-Process $c.url }
