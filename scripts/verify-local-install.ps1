[CmdletBinding()]
param([string] $DshHome = $env:DSH_HOME, [switch] $RequireActivated)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$checks = [Collections.Generic.List[object]]::new()
function Add-Check([string] $Code, [string] $Status, [bool] $Required, $Details = $null) {
    $checks.Add([ordered]@{ code = $Code; status = $Status; required = $Required; details = $Details })
}
function Assert-NoLinks([string] $Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'VERIFY_LINK_REJECTED' }
        $next = [IO.Path]::GetDirectoryName($cursor)
        if ($next -eq $cursor) { break }; $cursor = $next
    }
}
function Test-LocalReference($Dependency, [string] $Expected, [string] $Name, [string] $Version, [string] $ProfileDirectory) {
    try {
        if ($Dependency -isnot [string] -or -not $Dependency.StartsWith('file:', [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $value = $Dependency.Substring(5)
        if ($value.StartsWith('//')) { $value = ([Uri]$Dependency).LocalPath }
        elseif (-not [IO.Path]::IsPathFullyQualified($value)) { $value = Join-Path $ProfileDirectory $value }
        $actual = [IO.Path]::GetFullPath($value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $expectedPath = [IO.Path]::GetFullPath($Expected).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        if (-not $actual.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        Assert-NoLinks $actual
        if (-not (Test-Path -LiteralPath $actual -PathType Container)) { return $false }
        $manifestPath = Join-Path $actual 'package.json'; Assert-NoLinks $manifestPath
        $identity = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        return $identity.name -ceq $Name -and $identity.version -ceq $Version
    } catch { return $false }
}
try {
    if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
    if (-not [IO.Path]::IsPathFullyQualified($DshHome)) { throw 'VERIFY_ABSOLUTE_HOME_REQUIRED' }
    $DshHome = [IO.Path]::GetFullPath($DshHome); Assert-NoLinks $DshHome
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
    $nodeVersion = (& node --version 2>$null | Out-String).Trim()
    Add-Check 'NODE_VERSION' $(if ($nodeVersion -match '^v(\d+)\.(\d+)\.(\d+)$' -and [version]$nodeVersion.TrimStart('v') -ge [version]'24.21.0') { 'pass' } else { 'fail' }) $true $nodeVersion
    $dshVersion = (& dsh --version 2>$null | Out-String).Trim()
    $dshVersionMatch = [regex]::Match($dshVersion, '(?<![0-9A-Za-z.+-])[vV]?(?<version>[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*)(?![0-9A-Za-z.+-])')
    $dshVersionNumber = if ($dshVersionMatch.Success) { $dshVersionMatch.Groups['version'].Value } else { 'UNKNOWN' }
    Add-Check 'DSH_VERSION' $(if ($dshVersionNumber -cin @('0.2.1-rc.2', '0.2.1-rc.3')) { 'pass' } else { 'fail' }) $true $dshVersionNumber
    Add-Check 'PLUGIN_VERSION' 'pass' $true $package.version
    $root = Join-Path $DshHome 'dafeiyu-memory'; Assert-NoLinks $root
    foreach ($relative in @('', 'backups', 'spool', 'reports')) {
        $path = if ($relative) { Join-Path $root $relative } else { $root }; Assert-NoLinks $path
        $parent = $path
        while (-not (Test-Path -LiteralPath $parent -PathType Container)) { $parent = [IO.Path]::GetDirectoryName($parent); if (-not $parent) { throw 'VERIFY_DIRECTORY_UNAVAILABLE' } }
        # ACL evaluation never writes probe files. Group membership is included; any matching deny wins conservatively.
        $acl = Get-Acl -LiteralPath $parent
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $sids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $sids -contains $_.IdentityReference.Value })
        $mask = [Security.AccessControl.FileSystemRights]::Write
        $deny = @($rules | Where-Object { $_.AccessControlType -eq 'Deny' -and ($_.FileSystemRights -band $mask) }).Count -gt 0
        $allow = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $mask) -eq $mask }).Count -gt 0
        Add-Check "DIRECTORY_$(if ($relative) { $relative.ToUpperInvariant() } else { 'CORE' })" $(if ($allow -and -not $deny) { 'pass' } else { 'fail' }) $true 'ACL_ONLY'
    }
    $db = Join-Path $root 'memory.sqlite'; Assert-NoLinks $db
    $dbReport = (& node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'inspect-local-database.mjs') $db | Out-String) | ConvertFrom-Json
    Add-Check 'CORE_DATABASE' $dbReport.status $true $dbReport
    $qqRoot = Join-Path $DshHome 'plugins-data/aurabot/modules/dafeiyu-memory'
    foreach ($file in @('index.mjs', 'spool.mjs')) {
        $path = Join-Path $qqRoot $file; Assert-NoLinks $path
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
            $expected = (Get-FileHash -LiteralPath (Join-Path $repo "aurabot-module/dafeiyu-memory/$file") -Algorithm SHA256).Hash
            Add-Check "QQ_$(if ($file -eq 'index.mjs') { 'MODULE' } else { 'SPOOL' })" $(if ($hash -eq $expected) { 'pass' } else { 'fail' }) $true @{ sha256 = $hash }
        } else { Add-Check "QQ_$(if ($file -eq 'index.mjs') { 'MODULE' } else { 'SPOOL' })" 'pending' $true 'NOT_INSTALLED' }
    }
    $petRoot = Join-Path $DshHome 'sources/dsh-pet-unified-memory'
    $statePath = Join-Path $petRoot '.git/dafeiyu-unified-memory.json'; Assert-NoLinks $statePath
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.packageRelative -cnotin @('', 'dsh-pet')) { throw 'VERIFY_PET_STATE_INVALID' }
        $petPackage = Join-Path $petRoot "$($state.packageRelative)/package.json"; Assert-NoLinks $petPackage
        $pet = Get-Content -LiteralPath $petPackage -Raw | ConvertFrom-Json
        $valid = $pet.name -ceq 'dsh-pet' -and $pet.version -ceq '0.3.8' -and $state.tag -ceq 'v0.3.8'
        $valid = $valid -and $state.patchHash -eq (Get-FileHash -LiteralPath (Join-Path $repo 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch') -Algorithm SHA256).Hash
        $prefix = if ($state.packageRelative) { "$($state.packageRelative)/" } else { '' }
        $expectedFiles = @("${prefix}src/host/index.ts", "${prefix}src/host/unified-memory.ts", "${prefix}src/host/unified-memory.test.ts")
        $valid = $valid -and @($state.files).Count -eq 3 -and @(Compare-Object @($state.files | ForEach-Object { $_.path }) $expectedFiles).Count -eq 0
        if ($valid) {
            $head = (& git -C $petRoot rev-parse HEAD 2>$null | Out-String).Trim()
            $tagCommit = (& git -C $petRoot rev-parse 'v0.3.8^{commit}' 2>$null | Out-String).Trim()
            $remote = (& git -C $petRoot remote get-url origin 2>$null | Out-String).Trim()
            $valid = $head -eq $state.baseCommit -and $head -eq $tagCommit -and $remote -ceq 'https://github.com/PC2005-cloud/dsh-pet.git' -and $remote -ceq $state.remote
            $status = @(& git --no-optional-locks -c core.fsmonitor=false -C $petRoot status --porcelain --untracked-files=all 2>$null)
            $valid = $valid -and $LASTEXITCODE -eq 0
            $expectedStatus = @(" M ${prefix}src/host/index.ts", "?? ${prefix}src/host/unified-memory.ts", "?? ${prefix}src/host/unified-memory.test.ts")
            $valid = $valid -and @(Compare-Object $status $expectedStatus).Count -eq 0
            & git --no-optional-locks -C $petRoot diff --cached --quiet 2>$null
            $valid = $valid -and $LASTEXITCODE -eq 0
            $patchArgs = @('apply', '--reverse', '--check')
            if ($state.packageRelative) { $patchArgs += "--directory=$($state.packageRelative)" }
            $patchArgs += (Join-Path $repo 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch')
            & git --no-optional-locks -C $petRoot @patchArgs 2>$null | Out-Null
            $valid = $valid -and $LASTEXITCODE -eq 0
            $bridgePath = Join-Path ([IO.Path]::GetDirectoryName($petPackage)) 'src/host/unified-memory.ts'; Assert-NoLinks $bridgePath
            if (Test-Path -LiteralPath $bridgePath -PathType Leaf) {
                $bridge = (Get-Content -LiteralPath $bridgePath -Raw).Replace("`r`n", "`n")
                $canonicalBridge = (Get-Content -LiteralPath (Join-Path $repo 'integrations/dsh-pet/bridge.ts') -Raw).Replace("`r`n", "`n")
                $valid = $valid -and $bridge -ceq $canonicalBridge
            } else { $valid = $false }
        }
        foreach ($file in $state.files) {
            $path = [IO.Path]::GetFullPath((Join-Path $petRoot $file.path))
            if (-not $path.StartsWith($petRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'VERIFY_PET_STATE_INVALID' }
            Assert-NoLinks $path
            $valid = $valid -and (Test-Path -LiteralPath $path -PathType Leaf) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $file.hash
        }
        $buildPath = Join-Path ([IO.Path]::GetDirectoryName($petPackage)) 'lib/index.js'; Assert-NoLinks $buildPath
        $built = Test-Path -LiteralPath $buildPath -PathType Leaf
        if ($built) {
            foreach ($relative in @('lib/types/index.d.ts', 'runtime/electron-helper/shared-core.js')) {
                $artifact = Join-Path ([IO.Path]::GetDirectoryName($petPackage)) $relative; Assert-NoLinks $artifact
                $valid = $valid -and (Test-Path -LiteralPath $artifact -PathType Leaf) -and (Get-Item -LiteralPath $artifact).Length -gt 0
            }
        }
        $receiptPath = Join-Path $petRoot '.git/dafeiyu-unified-memory-build.json'; Assert-NoLinks $receiptPath
        $hasReceipt = Test-Path -LiteralPath $receiptPath -PathType Leaf
        if ($hasReceipt) {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            $valid = $valid -and $built -and $receipt.version -eq 1 -and $receipt.test -ceq 'passed' -and $receipt.build -ceq 'passed' -and $receipt.completedAt -gt 0
            $valid = $valid -and $receipt.patchHash -eq $state.patchHash -and $receipt.baseCommit -ceq $head -and $receipt.tag -ceq 'v0.3.8' -and $receipt.remote -ceq $remote -and $receipt.packageRelative -ceq $state.packageRelative
            $valid = $valid -and $receipt.packageSha256 -eq (Get-FileHash -LiteralPath $petPackage -Algorithm SHA256).Hash
            $canonicalText = (Get-Content -LiteralPath (Join-Path $repo 'integrations/dsh-pet/bridge.ts') -Raw).Replace("`r`n", "`n")
            $canonicalHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonicalText)))
            $valid = $valid -and $receipt.bridgeSha256 -eq $canonicalHash
            $expectedArtifacts = @("${prefix}lib/index.js", "${prefix}lib/types/index.d.ts", "${prefix}runtime/electron-helper/shared-core.js")
            $valid = $valid -and @($receipt.sources).Count -eq 3 -and @(Compare-Object @($receipt.sources | ForEach-Object { $_.path }) $expectedFiles).Count -eq 0
            $valid = $valid -and @($receipt.artifacts).Count -eq 3 -and @(Compare-Object @($receipt.artifacts | ForEach-Object { $_.path }) $expectedArtifacts).Count -eq 0
            if ($valid) {
                foreach ($file in @($receipt.sources) + @($receipt.artifacts)) {
                    $path = Join-Path $petRoot $file.path; Assert-NoLinks $path
                    $valid = $valid -and $file.size -gt 0 -and (Test-Path -LiteralPath $path -PathType Leaf) -and (Get-Item -LiteralPath $path).Length -eq $file.size -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $file.sha256
                }
            }
        }
        Add-Check 'PET_PREPARED' $(if ($valid -and $built -and $hasReceipt) { 'pass' } elseif ($valid) { 'pending' } else { 'fail' }) $true @{ version = $pet.version; code = $(if (-not $built) { 'BUILD_PENDING' } elseif (-not $hasReceipt) { 'BUILD_RECEIPT_MISSING' } elseif ($valid) { 'BUILD_VERIFIED' } else { 'BUILD_VERIFICATION_FAILED' }) }
    } else { Add-Check 'PET_PREPARED' 'pending' $true 'SOURCE_NOT_PREPARED' }
    $profile = Join-Path $DshHome 'profiles/desktop/package.json'; Assert-NoLinks $profile
    $coreRef = 'pending'; $petRef = 'pending'
    $petPackageRoot = $petRoot
    if (-not (Test-Path -LiteralPath (Join-Path $petRoot 'package.json') -PathType Leaf)) { $petPackageRoot = Join-Path $petRoot 'dsh-pet' }
    if (Test-Path -LiteralPath $profile -PathType Leaf) {
        $manifest = Get-Content -LiteralPath $profile -Raw | ConvertFrom-Json
        if ($manifest.PSObject.Properties.Name -contains 'dependencies') {
            $deps = $manifest.dependencies
            if ($deps.PSObject.Properties.Name -contains 'dsh-dafeiyu-memory') {
                if (Test-LocalReference $deps.'dsh-dafeiyu-memory' $repo 'dsh-dafeiyu-memory' $package.version ([IO.Path]::GetDirectoryName($profile))) { $coreRef = 'pass' }
                elseif ($RequireActivated) { $coreRef = 'fail' }
            }
            if ($deps.PSObject.Properties.Name -contains 'dsh-pet') {
                if (Test-LocalReference $deps.'dsh-pet' $petPackageRoot 'dsh-pet' '0.3.8' ([IO.Path]::GetDirectoryName($profile))) { $petRef = 'pass' }
                elseif ($RequireActivated) { $petRef = 'fail' }
            }
        }
    }
    Add-Check 'CORE_ACTIVATION' $coreRef ([bool]$RequireActivated) 'PROFILE_REFERENCE_ONLY_RUNTIME_UNVERIFIED'
    Add-Check 'PET_ACTIVATION' $petRef ([bool]$RequireActivated) 'PROFILE_REFERENCE_ONLY_RUNTIME_UNVERIFIED'
    Add-Check 'DOUYIN_OPTIONAL' 'skipped' $false 'NOT_INSPECTED_OPTIONAL'
    $ok = @($checks | Where-Object { $_.required -and ($_.status -eq 'fail' -or ($RequireActivated -and $_.status -eq 'pending')) }).Count -eq 0
    [ordered]@{ ok = $ok; code = $(if ($ok) { 'LOCAL_CHECK_OK' } else { 'LOCAL_CHECK_FAILED' }); time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
    if (-not $ok) { exit 1 }
} catch {
    [ordered]@{ ok = $false; code = 'LOCAL_INSPECTION_FAILED'; checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
