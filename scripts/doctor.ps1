$ErrorActionPreference = 'Stop'

function Write-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Passed,
        [Parameter(Mandatory = $true)][string]$Detail
    )

    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "[$status] $Name - $Detail"
    if (-not $Passed) { $script:Failed = $true }
}

$script:Failed = $false
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repositoryRoot

Write-Check 'Repository' ((Test-Path AGENTS.md) -and (Test-Path package.json)) $repositoryRoot

$localNodeRoot = Join-Path $env:LOCALAPPDATA 'MGPL\tools\node-v22.22.1-win-x64'
$nodeExecutable = if (Test-Path -LiteralPath (Join-Path $localNodeRoot 'node.exe')) {
    Join-Path $localNodeRoot 'node.exe'
} else {
    'node'
}
$nodeVersion = (& $nodeExecutable --version 2>$null)
$nodeMajor = if ($nodeVersion -match '^v(\d+)') { [int]$Matches[1] } else { 0 }
$nodeDetail = if ($nodeVersion) { $nodeVersion } else { 'not found' }
Write-Check 'Node.js' ($nodeMajor -eq 22) "$nodeDetail ($nodeExecutable)"

$doppler = Get-Command doppler -ErrorAction SilentlyContinue
if (-not $doppler) {
    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\Doppler\doppler.exe'
    if (Test-Path -LiteralPath $fallback) { $doppler = Get-Item -LiteralPath $fallback }
}
$dopplerPath = if ($doppler -and $doppler.Source) { $doppler.Source } elseif ($doppler) { $doppler.FullName } else { $null }
Write-Check 'Doppler CLI' ($null -ne $doppler) $(if ($dopplerPath) { $dopplerPath } else { 'not found' })

if ($doppler) {
    try {
        $project = (& $dopplerPath configure get project --plain 2>$null)
        $config = (& $dopplerPath configure get config --plain 2>$null)
        Write-Check 'Doppler binding' (($project -eq 'mgpl') -and ($config -match '^dev')) "project=$project config=$config"
    } catch {
        Write-Check 'Doppler binding' $false 'unable to read the local project/config binding'
    }
}

$gitBash = 'C:\Program Files\Git\bin\bash.exe'
$bash = if (Test-Path -LiteralPath $gitBash) {
    Get-Item -LiteralPath $gitBash
} else {
    Get-Command bash -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\System32\bash.exe' }
}
$bashPath = if ($bash -and $bash.Source) { $bash.Source } elseif ($bash) { $bash.FullName } else { $null }
Write-Check 'Git Bash' ($null -ne $bash) $(if ($bashPath) { $bashPath } else { 'not found' })

$branch = (& git branch --show-current).Trim()
Write-Check 'Feature branch' ($branch -like 'feature/*' -or $branch -like 'fix/*' -or $branch -like 'hotfix/*') $branch

$upstream = (& git rev-parse --abbrev-ref '@{upstream}' 2>$null)
if ($LASTEXITCODE -eq 0 -and $upstream) {
    $counts = (& git rev-list --left-right --count "$upstream...HEAD").Trim() -split '\s+'
    $behind = [int]$counts[0]
    $ahead = [int]$counts[1]
    Write-Check 'Upstream divergence' ($behind -eq 0) "upstream=$upstream behind=$behind ahead=$ahead"
} else {
    Write-Check 'Upstream divergence' $false 'no upstream configured'
}

$listener = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
Write-Check 'Development port 4000' (-not $listener) $(if ($listener) { 'already in use' } else { 'available' })

if ($script:Failed) {
    Write-Host 'MGPL doctor found one or more blocking environment issues.'
    exit 1
}

Write-Host 'MGPL doctor passed.'
