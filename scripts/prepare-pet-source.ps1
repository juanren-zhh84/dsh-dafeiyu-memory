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
    Assert-NoLinks (Join-Path $script:destination 'package.json')
    try { $package = Get-Content -LiteralPath (Join-Path $script:destination 'package.json') -Raw | ConvertFrom-Json }
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

function Assert-Prepared($State) {
    if ($State.patchHash -ne $script:patchHash -or $State.baseCommit -ne $script:baseCommit -or $State.tag -ne $Tag -or $State.remote -ne $Remote) {
        throw 'PET_SOURCE_STATE_MISMATCH'
    }
    & git -C $script:destination diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_DIRTY' }
    $actual = @(Git-Output @('status', '--porcelain', '--untracked-files=all'))
    $expected = @(' M src/host/index.ts', '?? src/host/unified-memory.test.ts', '?? src/host/unified-memory.ts')
    if (@(Compare-Object $actual $expected).Count) { throw 'PET_SOURCE_DIRTY' }
    foreach ($file in $State.files) {
        $path = Full-Path (Join-Path $script:destination $file.path)
        Assert-Within $script:destination $path
        Assert-NoLinks $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.hash) {
            throw 'PET_SOURCE_DIRTY'
        }
    }
    Git-Output @('apply', '--reverse', '--check', $script:patch) | Out-Null
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
    Git-Output @('apply', '--check', $script:patch) | Out-Null
    Git-Output @('apply', $script:patch) | Out-Null
    $files = @('src/host/index.ts', 'src/host/unified-memory.ts', 'src/host/unified-memory.test.ts') | ForEach-Object {
        @{ path = $_; hash = (Get-FileHash -LiteralPath (Join-Path $script:destination $_) -Algorithm SHA256).Hash }
    }
    $state = @{ patchHash = $script:patchHash; baseCommit = $script:baseCommit; tag = $Tag; remote = $Remote; files = @($files) }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
}
Push-Location -LiteralPath $script:destination
try {
    & npm install --ignore-scripts --no-audit --no-fund --package-lock=false
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_INSTALL_FAILED' }
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_TEST_FAILED' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'PET_SOURCE_BUILD_FAILED' }
} finally { Pop-Location }
Write-Output 'PET_SOURCE_READY'
