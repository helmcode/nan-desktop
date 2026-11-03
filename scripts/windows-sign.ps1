# Authenticode signing hook for Helmcode Desktop (Windows release builds).
#
# Wired as Tauri's `bundle.windows.signCommand` by the release workflow ONLY
# when the WINDOWS_CERTIFICATE secret exists. Tauri calls it once per file it
# produces (the app exe, the NSIS setup exe, the MSI), so the binary INSIDE
# the installers is signed too, not just the installer wrappers.
#
#   pwsh -NoProfile -File scripts/windows-sign.ps1 <file>
#
# Environment:
#   WINDOWS_CERTIFICATE           base64 of the code-signing .pfx (required)
#   WINDOWS_CERTIFICATE_PASSWORD  .pfx password (required)
#   WINDOWS_TIMESTAMP_URL         RFC 3161 server (default: DigiCert)
#
# A signing failure is fatal (non-zero exit) so Tauri aborts the build rather
# than shipping a silently unsigned installer.

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = 'Stop'

if (-not $env:WINDOWS_CERTIFICATE) { throw 'WINDOWS_CERTIFICATE is not set' }
if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw 'WINDOWS_CERTIFICATE_PASSWORD is not set' }
if (-not (Test-Path -LiteralPath $File)) { throw "file to sign not found: $File" }

$timestamp = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

# Latest x64 signtool from the Windows SDK preinstalled on GitHub runners.
$signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found (Windows SDK missing?)' }

$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$pfx = Join-Path $tmp ("hcd-sign-" + [guid]::NewGuid().ToString('N') + '.pfx')
try {
  [System.IO.File]::WriteAllBytes($pfx, [System.Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))

  & $signtool.FullName sign /fd SHA256 /td SHA256 /tr $timestamp `
    /f $pfx /p $env:WINDOWS_CERTIFICATE_PASSWORD `
    /d 'Helmcode Desktop' /du 'https://helmcode.com' $File
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed ($LASTEXITCODE) for $File" }

  & $signtool.FullName verify /pa /q $File
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed ($LASTEXITCODE) for $File" }
  Write-Host "[windows-sign] signed $File"
}
finally {
  Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
}
