<#
.SYNOPSIS
    Self-sign all PageSignal native-client binaries with a self-issued code-signing
    certificate. Uses only built-in PowerShell + Windows; no Visual Studio /
    Windows SDK / signtool required.

.DESCRIPTION
    1. Looks up (or creates) a self-signed code-signing cert in CurrentUser\My
       with subject "CN=PageSignal Self-Signed".
    2. Installs that cert into:
         - CurrentUser\TrustedPublisher  (so SmartScreen + AV trust signatures)
         - CurrentUser\Root              (so the cert chain validates)
    3. Signs every artifact with Set-AuthenticodeSignature using the SHA256
       Authenticode + RFC3161 timestamp from the DigiCert public TSA.

    Re-running the script is safe: it reuses an existing cert, skips files
    already signed by it, and refreshes trust-store enrollment.

.NOTES
    Self-signed certs are trusted ONLY on machines where this script (or
    equivalent enrollment) has been run. They eliminate the SmartScreen prompt
    on developer / kiosk / managed machines but DO NOT replace an EV / OV
    code-signing certificate for public distribution.
#>

[CmdletBinding()]
param(
    [string]$Subject     = 'CN=PageSignal Self-Signed',
    [string]$FriendlyName = 'PageSignal Self-Signed Code Signing',
    [int]   $YearsValid   = 5,
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is ...\capture_client_agent ; the repo root is its parent.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Get-OrCreate-CodeSigningCert {
    $existing = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if ($existing) {
        Write-Host "[sign] reusing existing cert  thumbprint=$($existing.Thumbprint)"
        return $existing
    }
    Write-Host "[sign] creating new self-signed code-signing cert: $Subject"
    return New-SelfSignedCertificate `
        -Subject       $Subject `
        -FriendlyName  $FriendlyName `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Type          CodeSigningCert `
        -KeyUsage      DigitalSignature `
        -KeyAlgorithm  RSA `
        -KeyLength     2048 `
        -HashAlgorithm SHA256 `
        -NotAfter      (Get-Date).AddYears($YearsValid)
}

function Ensure-InStore {
    param($cert, [string]$storeName)
    $path = "Cert:\CurrentUser\$storeName"
    $exists = Get-ChildItem $path -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if ($exists) { return $true }
    Write-Host "[sign] installing cert into CurrentUser\$storeName (a Windows security dialog may appear)"
    try {
        $certStore = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
        $certStore.Open('ReadWrite')
        try { $certStore.Add($cert) } finally { $certStore.Close() }
        return $true
    } catch {
        Write-Warning "[sign] could not enroll into CurrentUser\$storeName : $($_.Exception.Message)"
        return $false
    }
}

function Sign-File {
    param($cert, [string]$path)
    if (-not (Test-Path $path)) {
        Write-Host "[sign] skipping (not built): $path"
        return
    }
    $sig = Get-AuthenticodeSignature -FilePath $path -ErrorAction SilentlyContinue
    if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Thumbprint -eq $cert.Thumbprint) {
        Write-Host "[sign] already signed (valid): $path"
        return
    }
    Write-Host "[sign] signing: $path"
    $result = Set-AuthenticodeSignature `
        -FilePath          $path `
        -Certificate       $cert `
        -HashAlgorithm     SHA256 `
        -IncludeChain      All `
        -TimestampServer   $TimestampUrl
    # 'Valid' = chain-trusted; 'UnknownError' usually means "signed OK but the
    # self-signed root isn't in CurrentUser\Root yet" — the signature is still
    # embedded and will validate as soon as Ensure-InStore Root succeeds.
    if ($result.Status -eq 'Valid') {
        Write-Host "[sign] OK (chain trusted): $path"
    } elseif ($result.Status -eq 'UnknownError') {
        Write-Host "[sign] signed (chain not yet trusted): $path"
    } else {
        throw "Signing failed for $path - status=$($result.Status) message=$($result.StatusMessage)"
    }
}

# ---------- main ----------
$cert = Get-OrCreate-CodeSigningCert

# Sign first: signing only needs the private key from CurrentUser\My, which is
# already in place after Get-OrCreate. Trust-store enrollment (next step) may
# trigger a Windows security dialog for the Root store; we don't want signing
# to be blocked by it.
$targets = @(
    'capture_client_agent\dll\dist\PageSignalAgent.dll',
    'capture_client_agent\dll\dist\PageSignalAgentHost.exe',
    'capture_client_agent\dll\dist\PageSignalAgentHost.x86.exe',
    'capture_client_agent\dll\dist\PageSignalBootstrap.dll',
    'capture_client_agent\exe\dist\PageSignalNativeClient.exe'
)
foreach ($t in $targets) { Sign-File -cert $cert -path $t }

# Now enroll for trust. TrustedPublisher is silent; Root may pop a UI dialog
# the first time — click "Yes" to make Authenticode chain-validation succeed.
Ensure-InStore -cert $cert -storeName 'TrustedPublisher' | Out-Null
$rootOk = Ensure-InStore -cert $cert -storeName 'Root'
if (-not $rootOk) {
    Write-Warning "[sign] cert not in CurrentUser\Root — Authenticode chain may show 'UnknownError'."
    Write-Warning "       Re-run sign.ps1 and click 'Yes' on the security prompt to fix this."
}

Write-Host "[sign] done. Cert thumbprint: $($cert.Thumbprint)"
Write-Host "[sign] export it for other machines with:"
Write-Host "       Export-Certificate -Cert (Get-Item Cert:\CurrentUser\My\$($cert.Thumbprint)) -FilePath PageSignal-SelfSigned.cer"
