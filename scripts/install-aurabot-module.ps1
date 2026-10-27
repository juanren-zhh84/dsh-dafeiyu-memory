[CmdletBinding()]
param([string] $DshHome)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-AbsolutePath([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) {
        throw 'INSTALL_ABSOLUTE_PATH_REQUIRED'
    }
    return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-Within([string] $Root, [string] $Path) {
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($Path -ne $Root -and -not $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'INSTALL_PATH_OUTSIDE_ROOT'
    }
}

function Assert-NoLinks([string] $Path) {
    # Reject even in-root links: an unknown/reparse provider cannot prove destination containment.
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALL_LINK_REJECTED' }
            if ($item.PSProvider.Name -ne 'FileSystem') { throw 'INSTALL_UNKNOWN_PATH' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-Tree([string] $Root) {
    Assert-NoLinks $Root
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($Root)
    while ($stack.Count) {
        $folder = $stack.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
            Assert-Within $Root $item.FullName
            Assert-NoLinks $item.FullName
            if ($item.PSIsContainer) { $stack.Push($item.FullName) }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
    elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
    else { throw 'INSTALL_HOME_UNAVAILABLE' }
}
$targetRoot = Get-AbsolutePath $DshHome
$sourceRoot = Get-AbsolutePath (Join-Path $PSScriptRoot '../aurabot-module/dafeiyu-memory')
$aurabotRoot = Get-AbsolutePath (Join-Path $targetRoot 'plugins-data/aurabot')
$modulesRoot = Get-AbsolutePath (Join-Path $aurabotRoot 'modules')
$destination = Get-AbsolutePath (Join-Path $modulesRoot 'dafeiyu-memory')
foreach ($candidate in @($aurabotRoot, $modulesRoot, $destination)) {
    Assert-Within $targetRoot $candidate
    Assert-NoLinks $candidate
}
Assert-Tree $sourceRoot
Assert-Tree $destination
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'index.mjs') -PathType Leaf)) { throw 'INSTALL_SOURCE_MISSING' }
foreach ($name in @('index.mjs', 'spool.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name) -PathType Leaf)) { throw 'INSTALL_SOURCE_MISSING' }
}

$backup = $null
if (Test-Path -LiteralPath $destination) {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
    $backup = Get-AbsolutePath (Join-Path $aurabotRoot "dafeiyu-memory-backup-$stamp")
    Assert-Within $aurabotRoot $backup
    Assert-NoLinks $backup
    if (Test-Path -LiteralPath $backup) { throw 'INSTALL_BACKUP_EXISTS' }
}
# Resolve and validate every mutation target before the first directory is created.
New-Item -ItemType Directory -Path $modulesRoot -Force | Out-Null
if ($backup) { Move-Item -LiteralPath $destination -Destination $backup }
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($name in @('index.mjs', 'spool.mjs')) {
    $targetFile = Get-AbsolutePath (Join-Path $destination $name)
    Assert-Within $destination $targetFile
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $targetFile
}
Write-Output 'INSTALL_OK'
