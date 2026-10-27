[CmdletBinding()]
param(
    [string] $DshHome,
    [string] $Remote = 'https://github.com/PC2005-cloud/dsh-pet.git',
    [string] $Tag = 'v0.3.8',
    [string] $Target
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Full-Path([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) {
        throw 'PET_SOURCE_ABSOLUTE_PATH_REQUIRED'
    }
    return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-Within([string] $Root, [string] $Path) {
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'PET_SOURCE_OUTSIDE_SOURCES' }
}

function Assert-NoLinks([string] $Path) {
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.PSProvider.Name -ne 'FileSystem' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'PET_SOURCE_LINK_REJECTED'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Git-Output([string[]] $Arguments) {
    $result = & git -C $script:destination @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_GIT_FAILED' }
    return $result
}

function Assert-Identity {
    $script:packageRelative = ''
    $script:packageRoot = $script:destination
    if (-not (Test-Path -LiteralPath (Join-Path $script:packageRoot 'package.json'))) {
        $script:packageRelative = 'dsh-pet'
        $script:packageRoot = Full-Path (Join-Path $script:destination $script:packageRelative)
    }
    Assert-NoLinks (Join-Path $script:packageRoot 'package.json')
    try { $package = Get-Content -LiteralPath (Join-Path $script:packageRoot 'package.json') -Raw | ConvertFrom-Json }
    catch { throw 'PET_SOURCE_VERSION_MISMATCH' }
    if ($package.name -cne 'dsh-pet' -or $package.version -cne '0.3.8') { throw 'PET_SOURCE_VERSION_MISMATCH' }
    Assert-NoLinks (Join-Path $script:destination '.git')
    if (-not (Test-Path -LiteralPath (Join-Path $script:destination '.git') -PathType Container)) { throw 'PET_SOURCE_NOT_REPOSITORY' }
    $headCommit = Git-Output @('rev-parse', 'HEAD')
    $tagCommit = Git-Output @('rev-parse', "$Tag^{commit}")
    if ($headCommit -ne $tagCommit) { throw 'PET_SOURCE_TAG_MISMATCH' }
    if ((Git-Output @('remote', 'get-url', 'origin')) -ne $Remote) { throw 'PET_SOURCE_REMOTE_MISMATCH' }
    return $headCommit
}

function Apply-Output([string[]] $Arguments) {
    $options = @('apply')
    if ($script:packageRelative) { $options += "--directory=$script:packageRelative" }
    Git-Output ($options + $Arguments + @($script:patch))
}

function Assert-Prepared($State) {
    if ($State.patchHash -ne $script:patchHash -or $State.baseCommit -ne $script:baseCommit -or $State.tag -ne $Tag -or $State.remote -ne $Remote -or $State.packageRelative -ne $script:packageRelative) {
        throw 'PET_SOURCE_STATE_MISMATCH'
    }
    & git -C $script:destination diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_DIRTY' }
    $actual = @(Git-Output @('status', '--porcelain', '--untracked-files=all'))
    $prefix = if ($script:packageRelative) { "$script:packageRelative/" } else { '' }
    $expected = @(" M ${prefix}src/host/index.ts", "?? ${prefix}src/host/unified-memory.test.ts", "?? ${prefix}src/host/unified-memory.ts")
    if (@(Compare-Object $actual $expected).Count) { throw 'PET_SOURCE_DIRTY' }
    foreach ($file in $State.files) {
        $path = Full-Path (Join-Path $script:destination $file.path)
        Assert-Within $script:destination $path
        Assert-NoLinks $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.hash) {
            throw 'PET_SOURCE_DIRTY'
        }
    }
    Apply-Output @('--reverse', '--check') | Out-Null
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
    elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
    else { throw 'PET_SOURCE_HOME_REQUIRED' }
}
$sourceRoot = Full-Path (Join-Path (Full-Path $DshHome) 'sources')
if ([string]::IsNullOrWhiteSpace($Target)) { $Target = Join-Path $sourceRoot 'dsh-pet-unified-memory' }
$script:destination = Full-Path $Target
Assert-Within $sourceRoot $script:destination
Assert-NoLinks $script:destination
$script:patch = Full-Path (Join-Path $PSScriptRoot '../integrations/dsh-pet/patches/0.3.8-unified-memory.patch')
$script:patchHash = (Get-FileHash -LiteralPath $script:patch -Algorithm SHA256).Hash

if (-not (Test-Path -LiteralPath $script:destination)) {
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($script:destination)) -Force | Out-Null
    & git clone --depth 1 --branch $Tag -- $Remote $script:destination
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_CLONE_FAILED' }
}
$script:baseCommit = Assert-Identity
$statePath = Join-Path $script:destination '.git/dafeiyu-unified-memory.json'
Assert-NoLinks $statePath
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-Prepared $state
} else {
    if (@(Git-Output @('status', '--porcelain', '--untracked-files=all')).Count) { throw 'PET_SOURCE_DIRTY' }
    Apply-Output @('--check') | Out-Null
    Apply-Output @() | Out-Null
    $prefix = if ($script:packageRelative) { "$script:packageRelative/" } else { '' }
    $files = @('src/host/index.ts', 'src/host/unified-memory.ts', 'src/host/unified-memory.test.ts') | ForEach-Object {
        @{ path = "$prefix$_"; hash = (Get-FileHash -LiteralPath (Join-Path $script:packageRoot $_) -Algorithm SHA256).Hash }
    }
    $state = @{ patchHash = $script:patchHash; baseCommit = $script:baseCommit; tag = $Tag; remote = $Remote; packageRelative = $script:packageRelative; files = @($files) }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
}
$workspaceRoot = $script:packageRoot
if (Test-Path -LiteralPath (Join-Path $script:destination 'pnpm-lock.yaml')) { $workspaceRoot = $script:destination }
$usePnpm = Test-Path -LiteralPath (Join-Path $workspaceRoot 'pnpm-lock.yaml')
foreach ($name in @('pnpm-lock.yaml', 'pnpm-workspace.yaml')) { Assert-NoLinks (Join-Path $workspaceRoot $name) }
if (-not $usePnpm -and (Test-Path -LiteralPath (Join-Path $workspaceRoot 'pnpm-workspace.yaml'))) {
    throw 'PET_SOURCE_LOCKFILE_REQUIRED'
}
$previousAutoPin = $env:COREPACK_ENABLE_AUTO_PIN
$env:COREPACK_ENABLE_AUTO_PIN = '0'
Push-Location -LiteralPath $workspaceRoot
try {
    if ($usePnpm) { & corepack pnpm install --frozen-lockfile }
    else { & npm install --ignore-scripts --no-audit --no-fund --package-lock=false }
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_INSTALL_FAILED' }
    if ($usePnpm) { & corepack pnpm --dir $script:packageRoot test }
    else { & npm test }
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_TEST_FAILED' }
    if ($usePnpm) { & corepack pnpm --dir $script:packageRoot build }
    else { & npm run build }
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_BUILD_FAILED' }
} finally {
    Pop-Location
    $env:COREPACK_ENABLE_AUTO_PIN = $previousAutoPin
}
# A source-patch state is not a successful build. Publish a separate receipt only after both commands.
Assert-Prepared $state
$canonicalBridge = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../integrations/dsh-pet/bridge.ts') -Raw).Replace("`r`n", "`n")
$actualBridge = (Get-Content -LiteralPath (Join-Path $script:packageRoot 'src/host/unified-memory.ts') -Raw).Replace("`r`n", "`n")
if ($canonicalBridge -cne $actualBridge) { throw 'PET_SOURCE_CANONICAL_MISMATCH' }
$bridgeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonicalBridge)))
$prefix = if ($script:packageRelative) { "$script:packageRelative/" } else { '' }
$artifacts = @('lib/index.js', 'lib/types/index.d.ts', 'runtime/electron-helper/shared-core.js') | ForEach-Object {
    $path = Full-Path (Join-Path $script:packageRoot $_); Assert-NoLinks $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) { throw 'PET_SOURCE_BUILD_ARTIFACT_INVALID' }
    @{ path = "$prefix$_"; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; size = (Get-Item -LiteralPath $path).Length }
}
$sources = @(@('src/host/index.ts', 'src/host/unified-memory.ts', 'src/host/unified-memory.test.ts') | ForEach-Object {
    $path = Full-Path (Join-Path $script:packageRoot $_); Assert-NoLinks $path
    @{ path = "$prefix$_"; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; size = (Get-Item -LiteralPath $path).Length }
})
$receipt = @{ version = 1; test = 'passed'; build = 'passed'; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    patchHash = $script:patchHash; baseCommit = $script:baseCommit; tag = $Tag; remote = $Remote; packageRelative = $script:packageRelative
    packageSha256 = (Get-FileHash -LiteralPath (Join-Path $script:packageRoot 'package.json') -Algorithm SHA256).Hash
    bridgeSha256 = $bridgeHash; sources = $sources; artifacts = @($artifacts) }
$receiptPath = Join-Path $script:destination '.git/dafeiyu-unified-memory-build.json'; Assert-NoLinks $receiptPath
$receiptTemp = Join-Path $script:destination ('.git/dafeiyu-build-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($receiptTemp, ($receipt | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $stream = [IO.File]::Open($receiptTemp, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($receiptTemp, $receiptPath, $true)
} finally {
    if (Test-Path -LiteralPath $receiptTemp) { Remove-Item -LiteralPath $receiptTemp -Force }
}
Write-Output 'PET_SOURCE_READY'
