# SPDX-License-Identifier: MPL-2.0
# Invoked only after explicit native-plugin setup consent.
param(
    [Parameter(Mandatory=$true)][string]$PluginRoot,
    [Parameter(Mandatory=$true)][string]$DataDir,
    [Parameter(Mandatory=$true)][string]$HostAlias,
    [switch]$RecoverLock
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Native callers may inherit PowerShell 7's module search path. Use only this
# engine's bundled modules; this changes the bootstrap process, not user settings.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$message = 'Cannot prepare private runtime storage. Check plugin data permissions.'
$work = $null
$privateStorageReady = $false
function Publish-File([string]$source, [string]$destination) {
    # PowerShell 5.1 converts $null to an empty string for .NET string parameters.
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($source, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($source, $destination) }
}
function Set-State([string]$status) {
    $state = @{ schema=1; status=$status; stage='runtime'; message=$script:message; updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $temporary = Join-Path $DataDir ('.setup-state.' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $destination = Join-Path $DataDir 'setup-state.json'
    Publish-File $temporary $destination
}
function Assert-RealDirectory([string]$directory) {
    if (Test-Path -LiteralPath $directory) {
        $item = Get-Item -LiteralPath $directory -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe directory' }
    } else { [void][IO.Directory]::CreateDirectory($directory) }
}
function Test-Bun([string]$candidate) {
    if (-not $candidate -or -not [IO.File]::Exists($candidate)) { return $false }
    try {
        if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $version = (& $candidate --version 2>$null | Out-String).Trim()
        return $LASTEXITCODE -eq 0 -and $version -match '^\d+\.\d+\.\d+$' -and [Version]$version -ge [Version]'1.4.3'
    } catch { return $false }
}
try {
    if (-not [IO.Path]::IsPathRooted($DataDir)) { throw 'Absolute data path required' }
    Assert-RealDirectory $DataDir
    # Private ACL before writing logs, source, runtime, or progress. No broad grants.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($DataDir, $acl)
    $privateStorageReady = $true
    Set-State 'installing'
    $runtime = Join-Path $DataDir 'runtime'
    Assert-RealDirectory $runtime
    $bun = Join-Path $runtime 'bun.exe'
    if (-not (Test-Bun $bun)) {
        $candidate = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($candidate -and (Test-Bun $candidate.Source)) { $bun = $candidate.Source }
        else {
            # Official release asset SHA-256 metadata: oven-sh/bun, bun-v1.4.3.
            $arch = $env:PROCESSOR_ARCHITEW6432
            if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
            switch ($arch) {
                'ARM64' { $asset='bun-windows-aarch64'; $sha='5e8f142ef722cbc9f67dc068a166e46ee72be8307b38cac7186589d2face668f' }
                'AMD64' { $asset='bun-windows-x64-baseline'; $sha='d7a7d3eb216614544aab0cde2d8d9f2e4e87839bf5a30a1cd11d077f02d84e0c' }
                default { $message='Unsupported Windows architecture. Bun requires x64 or arm64 Windows.'; throw 'Unsupported platform' }
            }
            $work = Join-Path $runtime ('.download.' + [Guid]::NewGuid().ToString('N'))
            [void][IO.Directory]::CreateDirectory($work)
            $archive = Join-Path $work 'bun.zip'
            $message = 'Bun download failed. Check HTTPS access to github.com and retry setup.'
            Set-State 'installing'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$asset.zip" -OutFile $archive -TimeoutSec 300
            $message = 'Bun checksum verification failed. No downloaded runtime was installed; retry on a trusted network.'
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) { throw 'Checksum mismatch' }
            $message = 'Bun extraction failed. Check free space and retry setup.'
            Expand-Archive -LiteralPath $archive -DestinationPath $work
            $downloaded = Join-Path (Join-Path $work $asset) 'bun.exe'
            $message = 'Downloaded Bun cannot run on this Windows version. Check Bun platform requirements.'
            if (-not (Test-Bun $downloaded)) { throw 'Unsupported runtime' }
            Publish-File $downloaded $bun
        }
    }
    $message = 'Cannot launch package preparation. Reinstall the complete Tern plugin and retry.'
    $preparer = Join-Path $PluginRoot 'scripts/build.ts'
    if (-not [IO.File]::Exists($preparer)) { throw 'Missing preparer' }
    $arguments = @($preparer, 'bootstrap', $PluginRoot, $DataDir, $HostAlias)
    if ($RecoverLock) { $arguments += '--recover-lock' }
    # Windows PowerShell turns redirected native stderr into ErrorRecords. The
    # preparer owns detailed progress now; preserve its exit code and state.
    try {
        $ErrorActionPreference = 'Continue'
        $LASTEXITCODE = $null
        & $bun @arguments 2>$null
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
    if ($null -eq $code) { throw 'Cannot launch preparer' }
    if ($code -ne 0) { exit $code }
} catch {
    # Never surface raw exceptions, URLs with credentials, environment, or child stderr.
    if ($privateStorageReady) {
        try { Set-State 'failed' }
        catch { [Console]::Error.WriteLine('Cannot record setup failure in private runtime storage.') }
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($work -and [IO.Directory]::Exists($work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
