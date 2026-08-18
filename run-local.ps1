param(
    [ValidateSet("sync", "monitor", "check")]
    [string]$Job = "sync"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
    throw "Create a .env file from .env.example before running the job."
}

Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -eq 2) {
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1], "Process")
    }
}

npm install --no-audit --no-fund
npx playwright install chromium
npm run $Job
