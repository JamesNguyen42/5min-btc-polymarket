param(
  [double]$DurationHours = 12,
  [double]$StartingCash = 8,
  [int]$PollSeconds = 60,
  [int]$ResearchPerCycle = 2
)

$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputPath = Join-Path $repoPath 'runtime\kalshi-any-market-paper'
$runtimeRoot = (Join-Path $repoPath 'runtime')
if (-not $outputPath.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Refusing to launch with an unexpected runtime output path'
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$lockPath = Join-Path $outputPath 'runner.lock'
if (Test-Path -LiteralPath $lockPath) {
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $existing = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
  if ($existing) {
    throw "A Kalshi paper runner is already active with PID $($lock.pid)"
  }
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
$runnerPath = Join-Path $repoPath 'scripts\kalshi_any_market_paper.mjs'
$stdoutPath = Join-Path $outputPath 'stdout.log'
$stderrPath = Join-Path $outputPath 'stderr.log'
$arguments = @(
  $runnerPath,
  '--duration-hours', [string]$DurationHours,
  '--starting-cash', [string]$StartingCash,
  '--poll-seconds', [string]$PollSeconds,
  '--max-pages', '50',
  '--research-per-cycle', [string]$ResearchPerCycle,
  '--output-dir', $outputPath
)

$runner = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $repoPath -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
Start-Sleep -Seconds 2
if ($runner.HasExited) {
  $errorText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
  throw "Paper runner exited during startup. $errorText"
}

$record = [ordered]@{
  pid = $runner.Id
  startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  paperOnly = $true
  stdout = $stdoutPath
  stderr = $stderrPath
}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputPath 'launcher.json') -Encoding utf8
[pscustomobject]$record
