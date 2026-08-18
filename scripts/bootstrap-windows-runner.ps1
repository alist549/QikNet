param(
    [string]$RepositoryUrl = "https://github.com/alist549/qiknet-voucher-automation",
    [string]$RunnerName = "QikNet-VPS"
)

$ErrorActionPreference = "Stop"
$runnerVersion = "2.336.0"
$runnerSha256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162"
$runnerRoot = Join-Path $env:USERPROFILE "qiknet-actions-runner"
$runnerZip = Join-Path $env:TEMP "actions-runner-win-x64-$runnerVersion.zip"
$runnerUrl = "https://github.com/actions/runner/releases/download/v$runnerVersion/actions-runner-win-x64-$runnerVersion.zip"

# Windows Server 2016 PowerShell may otherwise negotiate obsolete TLS versions.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (Test-Path (Join-Path $runnerRoot ".runner")) {
    throw "A GitHub runner is already configured at $runnerRoot. Remove it through GitHub before rerunning this script."
}

if (Test-Path -LiteralPath $runnerRoot) {
    Write-Output "Removing an incomplete previous runner extraction..."
    Remove-Item -LiteralPath $runnerRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $runnerRoot -Force | Out-Null
Write-Output "Downloading the official GitHub Actions runner..."
Invoke-WebRequest -UseBasicParsing -Uri $runnerUrl -OutFile $runnerZip

$actualSha256 = (Get-FileHash -LiteralPath $runnerZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $runnerSha256) {
    throw "GitHub Actions runner checksum mismatch."
}

Expand-Archive -LiteralPath $runnerZip -DestinationPath $runnerRoot -Force
Remove-Item -LiteralPath $runnerZip -Force

$registrationToken = Read-Host "Paste a fresh one-hour GitHub runner registration token"
if ([string]::IsNullOrWhiteSpace($registrationToken)) {
    throw "A registration token is required."
}

Push-Location $runnerRoot
try {
    & .\config.cmd --unattended --url $RepositoryUrl --token $registrationToken --name $RunnerName --labels "qiknet" --work "_work" --replace
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub runner registration failed with exit code $LASTEXITCODE."
    }
} finally {
    $registrationToken = $null
    Pop-Location
}

$startupDirectory = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDirectory "QikNet GitHub Runner.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $runnerRoot "run.cmd"
$shortcut.WorkingDirectory = $runnerRoot
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Runner registered. Starting it in an interactive window..."
Start-Process -FilePath (Join-Path $runnerRoot "run.cmd") -WorkingDirectory $runnerRoot -WindowStyle Normal
Write-Output "Keep the VPS user logged in. Disconnect RDP without signing out."
