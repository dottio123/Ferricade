#!/bin/sh
# ferricade RustDesk deployment; run as root.
if [ "$(id -u)" -ne 0 ]; then exit 10; fi
mkdir -p /var/log || exit 30
log_file=/var/log/ferricade-deploy.log
log_step() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$log_file"; }
fail() { log_step "$2"; exit "$1"; }
log_step 'Preflight completed'
exe=/usr/bin/rustdesk

log_step 'Install check started'
need_install=1
if [ -x "$exe" ]; then
  current_version=$($exe --version 2>/dev/null || true)
  if [ "$current_version" = '1.5.0' ]; then need_install=0; fi
  if [ "$need_install" -eq 1 ] && printf '%s\n' "$current_version" | awk -F. -v target='1.5.0' 'BEGIN { split(target,t,".") } NF==3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { if ($1+0>t[1]+0 || ($1+0==t[1]+0 && $2+0>t[2]+0) || ($1+0==t[1]+0 && $2+0==t[2]+0 && $3+0>t[3]+0)) exit 0 } { exit 1 }'; then
    need_install=0
    log_step 'Newer installed version retained'
  fi
fi
if [ "$need_install" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    url='https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-x86_64.deb'
    checksum=''
    suffix=deb
    installer=apt
  elif command -v dnf >/dev/null 2>&1 || command -v rpm >/dev/null 2>&1; then
    url='https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-0.x86_64.rpm'
    checksum=''
    suffix=rpm
    installer=rpm
  else fail 30 'No supported package manager'; fi
  [ -n "$url" ] || fail 20 'Installer URL missing'
  tmpdir=$(mktemp -d /tmp/ferricade-rustdesk.XXXXXX) || fail 20 'Temporary installer directory failed'
  chmod 0755 "$tmpdir" || fail 20 'Temporary installer permissions failed'
  file="$tmpdir/pkg.$suffix"
  trap 'rm -rf "$tmpdir"' 0 HUP INT TERM
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$file" || fail 20 'Installer download failed'
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$file" || fail 20 'Installer download failed'
  else fail 20 'No downloader available'; fi
  chmod 0644 "$file" || fail 20 'Installer permissions failed'
  if [ -n "$checksum" ]; then
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file" | cut -d ' ' -f 1)
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
    else fail 20 'Checksum tool missing'; fi
    [ "$actual" = "$(printf '%s' "$checksum" | tr 'A-F' 'a-f')" ] || fail 20 'Installer checksum mismatch'
  fi
  if [ "$installer" = apt ]; then apt-get install -y "$file" >/dev/null 2>&1 || fail 30 'Installer failed'
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$file" >/dev/null 2>&1 || fail 30 'Installer failed'
  else rpm -U "$file" >/dev/null 2>&1 || fail 30 'Installer failed'; fi
  rm -f "$file"
  trap - 0 HUP INT TERM
  [ -x "$exe" ] || fail 30 'Installed executable missing'
  service_restarted=0
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || fail 30 'RustDesk service did not start'
    systemctl enable rustdesk || fail 30 'RustDesk service did not start'
    systemctl restart rustdesk || fail 30 'RustDesk service did not start'
    service_active=0
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      sleep 1
      if systemctl is-active --quiet rustdesk; then service_active=1; break; fi
    done
    [ "$service_active" -eq 1 ] || fail 30 'RustDesk service did not start'
    service_restarted=1
  else
    log_step 'No systemd: service not restarted'
  fi
  installed_version=$("$exe" --version 2>/dev/null || true)
  [ "$installed_version" = '1.5.0' ] || fail 30 "Installed version is $installed_version, expected 1.5.0"
  if [ "$service_restarted" -eq 1 ]; then log_step 'RustDesk service restarted'; fi
fi
log_step 'Install check completed'

[ -x "$exe" ] || fail 30 'RustDesk executable missing'
"$exe" --config 'host=rd.example,key=abc,relay=relay.example' >/dev/null 2>&1 || fail 40 'Server configuration failed'
readback=$("$exe" --option 'custom-rendezvous-server' 2>/dev/null) || fail 40 'Server readback failed'
[ "$readback" = 'rd.example' ] || fail 40 'Server verification failed'
readback=$("$exe" --option 'key' 2>/dev/null) || fail 40 'Server key verification failed'
if [ "$readback" != 'abc' ]; then
  "$exe" --option 'key' 'abc' >/dev/null 2>&1 || fail 40 'Server key verification failed'
  readback=$("$exe" --option 'key' 2>/dev/null) || fail 40 'Server key verification failed'
  [ "$readback" = 'abc' ] || fail 40 'Server key verification failed'
fi
readback=$("$exe" --option 'relay-server' 2>/dev/null) || fail 40 'Relay verification failed'
if [ "$readback" != 'relay.example' ]; then
  "$exe" --option 'relay-server' 'relay.example' >/dev/null 2>&1 || fail 40 'Relay verification failed'
  readback=$("$exe" --option 'relay-server' 2>/dev/null) || fail 40 'Relay verification failed'
  [ "$readback" = 'relay.example' ] || fail 40 'Relay verification failed'
fi
log_step 'Server configuration completed'

out=$("$exe" --password 'P@ss'\''w$rd1' 2>/dev/null) || fail 40 'Password configuration failed'
case $out in *'Done!'*) ;; *) fail 40 'Password configuration failed' ;; esac
log_step 'Password configuration completed'


"$exe" --option 'approve-mode' 'password' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'approve-mode' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'password' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'verification-method' 'use-temporary-password' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'verification-method' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'use-temporary-password' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-lan-discovery' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-lan-discovery' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'direct-server' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'direct-server' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-keyboard' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-keyboard' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-clipboard' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-clipboard' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-file-transfer' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-file-transfer' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-audio' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-audio' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-remote-restart' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-remote-restart' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-record-session' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-record-session' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'

"$exe" --option 'enable-tunnel' 'N' >/dev/null 2>&1 || fail 40 'Option configuration failed'
readback=$("$exe" --option 'enable-tunnel' 2>/dev/null) || fail 40 'Option readback failed'
[ "$readback" = 'N' ] || fail 40 'Option verification failed'
log_step 'Option configuration completed'


out=$("$exe" --set-unlock-pin '12'\''34' 2>/dev/null) || fail 40 'Unlock PIN configuration failed'
case $out in *'Done!'*) ;; *) fail 40 'Unlock PIN configuration failed' ;; esac
log_step 'Unlock PIN configuration completed'

device_id=$("$exe" --get-id 2>/dev/null || true)
if [ -n "$device_id" ]; then printf '%s\n' "$device_id"; else log_step 'Device ID unavailable'; fi
log_step 'Deployment completed'
exit 0
