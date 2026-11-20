# ferricade RustDesk deployment; run in Windows PowerShell 5.1 as administrator or SYSTEM.
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 10 }
$logDir = Join-Path $env:ProgramData 'ferricade'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'deploy.log'
function Log-Step([string]$message) { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message) }
function Fail([int]$code, [string]$message) { Log-Step $message; exit $code }
$uninstallKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RustDesk'
$installed = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
$msi = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'RustDesk*' -and $_.WindowsInstaller -eq 1 } | Select-Object -First 1
if ($installed -and -not $msi) { Fail 50 'Existing EXE installation; no changes made' }
$exe = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
if ($installed -and $installed.InstallLocation) { $exe = Join-Path $installed.InstallLocation 'rustdesk.exe' }
function Run-Client([string[]]$clientArgs) {
    $ErrorActionPreference = 'Continue'
    $output = (& $exe @clientArgs 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'RustDesk command failed' }
    return $output
}
function Run-ClientRaw([string]$arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $stderr = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    $null = $stderr.Result
    if ($p.ExitCode -ne 0) { throw 'RustDesk command failed' }
    return $out.Trim()
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Log-Step 'Install check started'
$needInstall = $true
if (Test-Path -LiteralPath $exe) {
    try { $currentVersion = Run-Client @('--version') }
    catch { $currentVersion = [string]::Empty; Log-Step 'Installed version unreadable' }
    if ($currentVersion -eq '1.5.0') { $needInstall = $false }
    elseif (-not $false -and $currentVersion -match '^\d+\.\d+\.\d+$' -and [version]$currentVersion -gt [version]'1.5.0') { $needInstall = $false; Log-Step 'Newer installed version retained' }
}
if ($needInstall) {
    $url = 'https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-x86_64.msi'
    $file = Join-Path $env:TEMP ('ferricade-rustdesk-' + [guid]::NewGuid().ToString('N') + '.msi')
    try {
        if ($url -match '^\\\\') { Copy-Item -LiteralPath $url -Destination $file -Force }
        else { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }

    } catch { Fail 20 'Installer download failed' }
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $file + '"'), '/qn', '/norestart') -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010 -and $process.ExitCode -ne 1641) { Fail 30 'Installer failed' }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    $installed = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
    if ($installed -and $installed.InstallLocation) { $exe = Join-Path $installed.InstallLocation 'rustdesk.exe' }
    if (-not (Test-Path -LiteralPath $exe)) { Fail 30 'Installed executable missing' }
    try {
        $service = Get-Service -Name RustDesk -ErrorAction SilentlyContinue
        if ($service -and $service.Status -eq 'Running') { Restart-Service -Name RustDesk -Force }
        else { Start-Service -Name RustDesk }
    } catch { Fail 30 'RustDesk service did not start' }
    $serviceRunning = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Seconds 1
        if ((Get-Service -Name RustDesk -ErrorAction SilentlyContinue).Status -eq 'Running') { $serviceRunning = $true; break }
    }
    if (-not $serviceRunning) { Fail 30 'RustDesk service did not start' }
    try { $installedVersion = Run-Client @('--version') }
    catch { $installedVersion = [string]::Empty }
    if ($installedVersion -ne '1.5.0') { Fail 30 ('Installed version is ' + $installedVersion + ', expected ' + '1.5.0') }
    Log-Step 'RustDesk service restarted'
}
Log-Step 'Install check completed'

if (-not (Test-Path -LiteralPath $exe)) { Fail 30 'RustDesk executable missing' }
try {
    $null = Run-Client @('--config', 'host=rd.example,key=abc,relay=relay.example')
    if ((Run-Client @('--option', 'custom-rendezvous-server')) -ne 'rd.example') { Fail 40 'Server configuration verification failed' }
} catch { Fail 40 'Server configuration failed' }
try {
    if ((Run-Client @('--option', 'key')) -cne 'abc') {
        $null = Run-Client @('--option', 'key', 'abc')
        if ((Run-Client @('--option', 'key')) -cne 'abc') { Fail 40 'Server key verification failed' }
    }
} catch { Fail 40 'Server key verification failed' }
try {
    if ((Run-Client @('--option', 'relay-server')) -cne 'relay.example') {
        $null = Run-Client @('--option', 'relay-server', 'relay.example')
        if ((Run-Client @('--option', 'relay-server')) -cne 'relay.example') { Fail 40 'Relay verification failed' }
    }
} catch { Fail 40 'Relay verification failed' }
Log-Step 'Server configuration completed'

try { if (-not ((Run-Client @('--password', 'P@ss''w$rd1')) -like '*Done!*')) { Fail 40 'Password configuration failed' } } catch { Fail 40 'Password configuration failed' }
Log-Step 'Password configuration completed'


try {
    $null = Run-Client @('--option', 'approve-mode', 'password')
    if ((Run-Client @('--option', 'approve-mode')) -ne 'password') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'verification-method', 'use-temporary-password')
    if ((Run-Client @('--option', 'verification-method')) -ne 'use-temporary-password') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-lan-discovery', 'N')
    if ((Run-Client @('--option', 'enable-lan-discovery')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'direct-server', 'N')
    if ((Run-Client @('--option', 'direct-server')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-keyboard', 'N')
    if ((Run-Client @('--option', 'enable-keyboard')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-clipboard', 'N')
    if ((Run-Client @('--option', 'enable-clipboard')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-file-transfer', 'N')
    if ((Run-Client @('--option', 'enable-file-transfer')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-audio', 'N')
    if ((Run-Client @('--option', 'enable-audio')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-remote-restart', 'N')
    if ((Run-Client @('--option', 'enable-remote-restart')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-record-session', 'N')
    if ((Run-Client @('--option', 'enable-record-session')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'

try {
    $null = Run-Client @('--option', 'enable-tunnel', 'N')
    if ((Run-Client @('--option', 'enable-tunnel')) -ne 'N') { Fail 40 'Option verification failed' }
} catch { Fail 40 'Option configuration failed' }
Log-Step 'Option configuration completed'


try { if (-not ((Run-Client @('--set-unlock-pin', '12''34')) -like '*Done!*')) { Fail 40 'Unlock PIN configuration failed' } } catch { Fail 40 'Unlock PIN configuration failed' }
Log-Step 'Unlock PIN configuration completed'

try { $deviceId = Run-Client @('--get-id') } catch { $deviceId = $null }
if ($deviceId) { Write-Output $deviceId } else { Log-Step 'Device ID unavailable' }
Log-Step 'Deployment completed'
exit 0
