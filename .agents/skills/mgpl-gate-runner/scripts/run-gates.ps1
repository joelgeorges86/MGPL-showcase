$ErrorActionPreference = "Stop"

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:NO_COLOR = "1"

$gateLogPath = if ($env:MGPL_GATE_LOG) {
    $env:MGPL_GATE_LOG
} else {
    Join-Path (Get-Location).Path "mgpl-gate-runner.log"
}

$script:GateLogWriter = [System.IO.StreamWriter]::new($gateLogPath, $false, [System.Text.UTF8Encoding]::new($false))

function Write-GateLine {
    param([AllowNull()][string]$Message = "")

    Write-Host $Message
    $script:GateLogWriter.WriteLine($Message)
    $script:GateLogWriter.Flush()
}

function Get-PortOwnerDescription {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) {
        return $null
    }

    $owners = @()
    foreach ($connection in $connections) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        $commandLine = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
        $owners += "PID $($connection.OwningProcess) $($process.ProcessName): $($commandLine.CommandLine)"
    }

    return ($owners -join "`n")
}

function Assert-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    $ownerDescription = Get-PortOwnerDescription -Port $Port
    if ($ownerDescription) {
        throw "Port $Port is already listening before Playwright starts. Stop the stale server/process first.`n$ownerDescription"
    }
}

function ConvertTo-CmdArgumentString {
    param([Parameter(Mandatory = $true)][string[]]$Command)

    return (($Command | ForEach-Object {
        if ($_ -match '[\s&()^|<>"]') {
            '"' + ($_ -replace '"', '\"') + '"'
        } else {
            $_
        }
    }) -join " ")
}

function Resolve-DopplerExecutable {
    $dopplerCommand = Get-Command doppler -ErrorAction SilentlyContinue
    if ($dopplerCommand -and (Test-Path -LiteralPath $dopplerCommand.Source)) {
        return $dopplerCommand.Source
    }

    $standardPath = Join-Path $env:LOCALAPPDATA "Programs\Doppler\doppler.exe"
    if (Test-Path -LiteralPath $standardPath) {
        return $standardPath
    }

    throw "Doppler CLI is required and was not found in PATH or the standard user installation directory. Install the Doppler CLI, open a new terminal, and retry. A new worktree also needs 'doppler setup --project mgpl --config dev' in its directory."
}

function Resolve-GitBashExecutable {
    $candidates = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files\Git\usr\bin\bash.exe",
        "C:\Program Files (x86)\Git\bin\bash.exe",
        "C:\Program Files (x86)\Git\usr\bin\bash.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $bashCommand = Get-Command bash -ErrorAction SilentlyContinue
    if ($bashCommand -and (Test-Path -LiteralPath $bashCommand.Source) -and ($bashCommand.Source -notlike "$env:WINDIR\system32\bash.exe")) {
        return $bashCommand.Source
    }

    $resolved = if ($bashCommand) { $bashCommand.Source } else { "not found" }
    throw "Git Bash is required for gates/run-all.sh and was not found. Plain 'bash' resolved to '$resolved', which is not acceptable because the Windows WSL launcher can fail when no Linux /bin/bash exists. Install Git for Windows or add Git Bash to PATH, then retry."
}

function Resolve-NodeRuntime {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    $missing = @()
    if (-not $nodeCommand) { $missing += "node" }
    if (-not $npmCommand) { $missing += "npm" }
    if ($missing.Count -gt 0) {
        throw "Node.js 22.15 or a later 22.x release is required, but these were not found on PATH: $($missing -join ', '). If nvm-windows is installed, run 'nvm use 22.23.2' or open a new terminal, then retry."
    }

    $ErrorActionPreference = "Continue"
    $nodeVersion = ((& $nodeCommand.Source --version 2>&1) | ForEach-Object { "$_" }) -join " "
    $nodeVersion = $nodeVersion.Trim()
    $nodeExitCode = $LASTEXITCODE
    $supported = $false
    if ($nodeExitCode -eq 0 -and $nodeVersion -match '^v22\.(\d+)\.\d+') {
        $supported = ([int]$Matches[1] -ge 15)
    }
    if (-not $supported) {
        throw "Node.js 22.15 or a later 22.x release is required because the gates use --use-system-ca, but '$($nodeCommand.Source) --version' returned '$nodeVersion' (exit $nodeExitCode). Run 'nvm use 22.23.2', then retry."
    }

    return [pscustomobject]@{ Path = $nodeCommand.Source; Version = $nodeVersion }
}

function Set-GateNodeOptions {
    $flag = "--use-system-ca"
    $current = $env:NODE_OPTIONS
    if ([string]::IsNullOrWhiteSpace($current)) {
        $env:NODE_OPTIONS = $flag
        return "NODE_OPTIONS for gate processes: $flag (added by the runner)"
    }

    if (($current.Trim() -split '\s+') -contains $flag) {
        return "NODE_OPTIONS for gate processes: $flag (already set)"
    }

    $env:NODE_OPTIONS = "$($current.Trim()) $flag"
    return "NODE_OPTIONS for gate processes: $flag (appended to the existing options)"
}

function Invoke-Gate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Command
    )

    Write-GateLine ""
    Write-GateLine "=== $Name ==="

    $stdoutPath = Join-Path $env:TEMP ("mgpl-gate-{0}-stdout.log" -f ([guid]::NewGuid().ToString("N")))
    $stderrPath = Join-Path $env:TEMP ("mgpl-gate-{0}-stderr.log" -f ([guid]::NewGuid().ToString("N")))
    $commandLine = ConvertTo-CmdArgumentString $Command

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = "cmd.exe"
    $processInfo.Arguments = "/d /s /c `"$commandLine 1> `"$stdoutPath`" 2> `"$stderrPath`"`""
    $processInfo.WorkingDirectory = (Get-Location).Path
    $processInfo.UseShellExecute = $false

    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()

    foreach ($path in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $path) {
            foreach ($line in [System.IO.File]::ReadLines($path, [System.Text.UTF8Encoding]::new($false))) {
                Write-GateLine $line
            }
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }

    if ($exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode."
    }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
Set-Location -LiteralPath $repositoryRoot

if (-not (Test-Path -LiteralPath "package.json") -or -not (Test-Path -LiteralPath "gates\run-all.sh")) {
    throw "The MGPL repository root could not be verified. Run this script from within the checked-out MGPL repository."
}

try {
    $dopplerExecutable = Resolve-DopplerExecutable
    $bashExecutable = Resolve-GitBashExecutable
    $nodeRuntime = Resolve-NodeRuntime
    $nodeOptionsLine = Set-GateNodeOptions

    Write-GateLine "Using Doppler: $dopplerExecutable"
    Write-GateLine "Using Git Bash: $bashExecutable"
    Write-GateLine "Using Node: $($nodeRuntime.Path) ($($nodeRuntime.Version))"
    Write-GateLine $nodeOptionsLine

    Invoke-Gate "AGENTS.md integrity" @("npm", "run", "check:agents")
    Invoke-Gate "Environment doctor" @("npm", "run", "doctor")
    Invoke-Gate "TypeScript" @($dopplerExecutable, "run", "--", "npm", "run", "test:types")
    Invoke-Gate "Client syntax" @($dopplerExecutable, "run", "--", "npm", "run", "test:client")
    Invoke-Gate "Spelling" @($dopplerExecutable, "run", "--", "npm", "run", "test:spell")
    Invoke-Gate "Unit tests" @($dopplerExecutable, "run", "--", "npm", "run", "test:unit")
    Invoke-Gate "Security and quality gates" @($dopplerExecutable, "run", "--", $bashExecutable, "gates/run-all.sh")
    $env:MGPL_GATE_RUNNER_ID = "powershell"
    $env:MGPL_GATE_SCOPE = "local"

    Write-GateLine ""
    Write-GateLine "All MGPL gates passed."
    Invoke-Gate "Record gate evidence" @($dopplerExecutable, "run", "--", "node", "scripts/mgpl-gate-guard.js", "record")
} catch {
    Write-GateLine ""
    Write-GateLine "MGPL gate runner failed: $($_.Exception.Message)"
    exit 1
} finally {
    $script:GateLogWriter.Dispose()
}
