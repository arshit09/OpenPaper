# Install the OpenPaper CLI on Windows.
#
#   irm https://github.com/arshit09/OpenPaper/releases/latest/download/install.ps1 | iex
#
# Installs the `openpaper` command: the OpenPaper server and editor, a Node.js runtime of its own, and the voice
# input engine. No admin needed. Every download is checked against its SHA-256 before it's used.
#
#   %LOCALAPPDATA%\Programs\OpenPaper CLI\server\   OpenPaper, from this project's GitHub release
#   %LOCALAPPDATA%\Programs\OpenPaper CLI\node\     Node.js, the official build from nodejs.org
#   %LOCALAPPDATA%\Programs\OpenPaper CLI\bin\      openpaper.cmd, added to your PATH
#
# Your designs live in %USERPROFILE%\.openpaper and are never touched. Running the script again updates in place.
# `openpaper uninstall` removes the CLI. The desktop app (OpenPaper-Setup.exe) is separate and unaffected.
#
# Environment (all optional):
#   OPENPAPER_VERSION          a version to install, such as 0.3.0 (default: the latest release)
#   OPENPAPER_INSTALL_DIR      where to install
#   OPENPAPER_MANIFEST_URL     read this release manifest instead of GitHub's
#   OPENPAPER_NODE_MIRROR      download Node.js from this mirror of https://nodejs.org/dist
#   OPENPAPER_NO_SPEECH=1      skip the voice input engine (about 25 MB)
#   OPENPAPER_NO_MODIFY_PATH=1 don't add the command's folder to your PATH
#
# This file is plain ASCII on purpose: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

# Everything runs inside a script block, so `irm | iex` leaves no functions or variables behind in your session.
& {
function Install-OpenPaperCli {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repoUrl = 'https://github.com/arshit09/OpenPaper'

  function Step($text) { Write-Host "> $text" -ForegroundColor DarkGray }

  # Run a native command with its stderr dropped. (Windows PowerShell 5.1 turns redirected stderr into a terminating
  # error while $ErrorActionPreference is Stop.) $LASTEXITCODE is set as usual.
  function Invoke-Quiet([scriptblock]$block) {
    $ErrorActionPreference = 'Continue'
    & $block 2>$null
  }

  function Get-File($url, $path) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path
    } catch {
      throw "Couldn't download $url ($($_.Exception.Message))"
    }
  }

  function Assert-Hash($path, $expected, $what) {
    # .NET rather than Get-FileHash, which can fail to load when PowerShell 7 started this Windows PowerShell.
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($path)
    try { $actual = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose(); $sha.Dispose() }
    if ($actual -ne $expected.ToLowerInvariant()) {
      throw "$what doesn't match its published SHA-256 (expected $expected, got $actual). Try again, or report it at $repoUrl/issues."
    }
  }

  # A URL from the manifest, resolved against the manifest's own URL when it's relative.
  function Resolve-Url($url, $base) {
    if ($url -match '^https?://') { return $url }
    return $base.Substring(0, $base.LastIndexOf('/') + 1) + $url
  }

  # OpenPaper servers running from this install's node.exe (agents' `openpaper mcp` relays are left alone).
  function Get-Servers($nodeExe) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $nodeExe) -and ($_.CommandLine -match '\sserve(\s|$)') }
  }

  # Ask each server to shut down (it saves and closes cleanly), then make sure it's gone. Returns whether any ran.
  function Stop-Servers($nodeExe) {
    try { $servers = @(Get-Servers $nodeExe) } catch { $servers = @() }
    if ($servers.Count -eq 0) { return $false }
    Step 'Stopping the OpenPaper server running from this install'
    foreach ($server in $servers) {
      try {
        $port = (Get-NetTCPConnection -OwningProcess $server.ProcessId -State Listen -ErrorAction Stop | Select-Object -First 1).LocalPort
        if ($port) { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 3 | Out-Null }
      } catch {}
      try { Wait-Process -Id $server.ProcessId -Timeout 10 -ErrorAction Stop } catch {}
      try { Stop-Process -Id $server.ProcessId -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 300
    return $true
  }

  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar)) {
    throw 'This version of Windows has no tar.exe. Use Windows 10 version 1803 or later, or download the desktop app.'
  }

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { $target = 'win-x64' }
    'ARM64' { $target = 'win-arm64' }
    default { throw "OpenPaper needs 64-bit Windows (this PC reports $arch)." }
  }

  $installDir = $env:OPENPAPER_INSTALL_DIR
  if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'Programs\OpenPaper CLI' }
  $installDir = [IO.Path]::GetFullPath($installDir)
  $binDir = Join-Path $installDir 'bin'
  $nodeDir = Join-Path $installDir 'node'
  $nodeExe = Join-Path $nodeDir 'node.exe'
  $serverDir = Join-Path $installDir 'server'

  if ($env:OPENPAPER_MANIFEST_URL) {
    $manifestUrl = $env:OPENPAPER_MANIFEST_URL
  } elseif ($env:OPENPAPER_VERSION) {
    $manifestUrl = "$repoUrl/releases/download/v$($env:OPENPAPER_VERSION.TrimStart('v'))/OpenPaper-cli.json"
  } else {
    $manifestUrl = "$repoUrl/releases/latest/download/OpenPaper-cli.json"
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  # Leftovers from an earlier run that couldn't be removed while in use.
  Get-ChildItem -LiteralPath $installDir -Force -Filter '.*-old-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $installDir -Force -Filter '.install-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $nodeDir -Force -Filter '*.old-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  # Unpack next to the install, so swapping it in is a rename.
  $work = Join-Path $installDir ('.install-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    Write-Host "Installing OpenPaper ($target)" -ForegroundColor White
    $manifestFile = Join-Path $work 'manifest.json'
    Get-File $manifestUrl $manifestFile
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if (-not ($manifest.version -and $manifest.url -and $manifest.sha256 -and $manifest.node)) {
      throw "The release manifest at $manifestUrl is missing fields."
    }

    # 1. OpenPaper.
    Step "Downloading OpenPaper $($manifest.version) ($([Math]::Round($manifest.size / 1MB, 1)) MB)"
    $bundle = Join-Path $work 'openpaper.tar.gz'
    Get-File (Resolve-Url $manifest.url $manifestUrl) $bundle
    Assert-Hash $bundle $manifest.sha256 'The OpenPaper download'
    $stage = Join-Path $work 'stage'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    & $tar -xzf $bundle -C $stage
    if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $bundle." }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'server\cli.js'))) { throw 'The OpenPaper download is missing server\cli.js.' }

    # 2. Node.js, unless this install already has the same version.
    $newNode = $null
    $currentNode = $null
    if (Test-Path -LiteralPath $nodeExe) { $currentNode = Invoke-Quiet { & $nodeExe --version } }
    if ($currentNode -ne "v$($manifest.node)") {
      $mirror = $env:OPENPAPER_NODE_MIRROR
      if (-not $mirror) { $mirror = 'https://nodejs.org/dist' }
      $name = "node-v$($manifest.node)-$target"
      Step "Downloading Node.js $($manifest.node)"
      $sums = Join-Path $work 'SHASUMS256.txt'
      Get-File "$mirror/v$($manifest.node)/SHASUMS256.txt" $sums
      $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "\s$([Regex]::Escape("$name.zip"))$" } | Select-Object -First 1
      if (-not $line) { throw "nodejs.org has no $name.zip." }
      $nodeZip = Join-Path $work 'node.zip'
      Get-File "$mirror/v$($manifest.node)/$name.zip" $nodeZip
      Assert-Hash $nodeZip ($line -split '\s+')[0] 'The Node.js download'
      $newNode = Join-Path $work 'node'
      New-Item -ItemType Directory -Force -Path $newNode | Out-Null
      & $tar -xf $nodeZip -C $newNode --strip-components=1 "$name/node.exe" "$name/LICENSE"
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $newNode 'node.exe'))) { throw "Couldn't unpack $name.zip." }
    }

    # 3. The voice input engine (optional: OpenPaper works without it, minus dictation).
    $speechUrl = $manifest."speech-$target-url"
    $speechSha = $manifest."speech-$target-sha256"
    if ($env:OPENPAPER_NO_SPEECH -ne '1' -and $speechUrl -and $speechSha) {
      Step 'Downloading the voice input engine'
      try {
        $speech = Join-Path $work 'speech.tgz'
        Get-File (Resolve-Url $speechUrl $manifestUrl) $speech
        Assert-Hash $speech $speechSha 'The voice input engine'
        $speechDir = Join-Path $stage "server\node_modules\sherpa-onnx-$target"
        New-Item -ItemType Directory -Force -Path $speechDir | Out-Null
        & $tar -xzf $speech -C $speechDir --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack it." }
      } catch {
        Write-Warning "The voice input engine wasn't installed, so dictation will be unavailable. Everything else works. ($($_.Exception.Message))"
      }
    }

    # 4. Swap it in. A server running from this install is stopped first and started again after.
    $restart = Stop-Servers $nodeExe
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    if ($newNode) {
      if (Test-Path -LiteralPath $nodeDir) {
        try {
          Move-Item -LiteralPath $nodeDir -Destination (Join-Path $installDir ".node-old-$suffix")
        } catch {
          # An agent's `openpaper mcp` relay is using node.exe. A running exe can be renamed, though not replaced.
          Move-Item -LiteralPath $nodeExe -Destination "$nodeExe.old-$suffix"
          Copy-Item -LiteralPath (Join-Path $newNode 'node.exe') -Destination $nodeExe -Force
          Copy-Item -LiteralPath (Join-Path $newNode 'LICENSE') -Destination (Join-Path $nodeDir 'LICENSE') -Force
          $newNode = $null
        }
      }
      if ($newNode) { Move-Item -LiteralPath $newNode -Destination $nodeDir }
    }
    $oldServer = Join-Path $installDir ".server-old-$suffix"
    if (Test-Path -LiteralPath $serverDir) {
      try {
        Move-Item -LiteralPath $serverDir -Destination $oldServer
      } catch {
        throw "OpenPaper is in use from $serverDir. Run ``openpaper stop``, close agents that use it, and run the installer again."
      }
    }
    try {
      Move-Item -LiteralPath (Join-Path $stage 'server') -Destination $serverDir
    } catch {
      if (Test-Path -LiteralPath $oldServer) { Move-Item -LiteralPath $oldServer -Destination $serverDir }
      throw "Couldn't move OpenPaper into $installDir."
    }
    Remove-Item -LiteralPath $oldServer -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $installDir -Force -Filter '.node-old-*' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    # 5. The command, the uninstaller and PATH.
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $cmd = @(
      '@echo off',
      'rem The openpaper command, written by the OpenPaper installer.',
      'rem `openpaper uninstall` deletes this file, so (goto) ends the batch before PowerShell runs.',
      'if /i "%~1"=="uninstall" (',
      '  (goto) 2>nul & powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\uninstall.ps1"',
      ')',
      '"%~dp0..\node\node.exe" "%~dp0..\server\cli.js" %*'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $binDir 'openpaper.cmd'), $cmd + "`r`n", (New-Object Text.ASCIIEncoding))

    $uninstall = @'
# Remove the OpenPaper CLI. Your designs in %USERPROFILE%\.openpaper stay.
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $installDir 'bin'
$nodeExe = Join-Path $installDir 'node\node.exe'
$servers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -ieq $nodeExe })
foreach ($p in $servers) {
  if ($p.CommandLine -match '\sserve(\s|$)') {
    try {
      $port = (Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction Stop | Select-Object -First 1).LocalPort
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 3 | Out-Null
      Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction Stop
    } catch {}
  }
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Milliseconds 300
$key = Get-Item 'HKCU:\Environment'
$path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$parts = @($path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $binDir) })
if ($parts.Count -ne @($path -split ';' | Where-Object { $_ }).Count) {
  Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value ($parts -join ';') -Type ExpandString
  [Environment]::SetEnvironmentVariable('OPENPAPER_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('OPENPAPER_PATH_REFRESH', $null, 'User')
}
Set-Location -LiteralPath $env:TEMP
try {
  Remove-Item -LiteralPath $installDir -Recurse -Force
  $data = $env:OPENPAPER_HOME
  if (-not $data) { $data = Join-Path $env:USERPROFILE '.openpaper' }
  Write-Host "OpenPaper CLI removed. Your designs are still in $data."
} catch {
  Write-Host "Some files in $installDir are in use. Close the agents that use OpenPaper, then delete that folder." -ForegroundColor Yellow
}
'@
    [IO.File]::WriteAllText((Join-Path $installDir 'uninstall.ps1'), $uninstall, (New-Object Text.ASCIIEncoding))

    $onPath = $false
    if ($env:OPENPAPER_NO_MODIFY_PATH -ne '1') {
      $key = Get-Item 'HKCU:\Environment'
      $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $entries = @($userPath -split ';' | Where-Object { $_ })
      if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $binDir })) {
        Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value (($entries + $binDir) -join ';') -Type ExpandString
        # Setting any user variable through .NET tells Explorer and new terminals that the environment changed.
        [Environment]::SetEnvironmentVariable('OPENPAPER_PATH_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('OPENPAPER_PATH_REFRESH', $null, 'User')
      }
      $onPath = $true
      if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir })) { $env:Path = "$env:Path;$binDir" }
    }

    $openpaper = Join-Path $binDir 'openpaper.cmd'
    $installed = Invoke-Quiet { & $openpaper --version }
    if ($LASTEXITCODE -ne 0 -or -not $installed) { throw "OpenPaper was installed, but ``$openpaper --version`` failed." }
    if ($restart) {
      Invoke-Quiet { & $openpaper start --no-open } | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warning "Couldn't restart the server. Run ``openpaper start``." }
    }

    Write-Host ''
    Write-Host "OpenPaper $installed is installed." -ForegroundColor Green
    Write-Host ''
    Write-Host '  openpaper start                  # open the editor'
    Write-Host '  openpaper install claude-code    # connect an agent (or --all)'
    Write-Host ''
    if (-not $onPath) {
      Write-Host "Add $binDir to your PATH to use it, or run $openpaper."
    } elseif ($env:OPENPAPER_INSTALL_CMD -eq '1') {
      Write-Host 'Open a new terminal to use it.'
    }
  } finally {
    # Antivirus can hold a fresh download open for a moment, so try a few times.
    for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $work); $i++) {
      if ($i) { Start-Sleep -Milliseconds 300 }
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  Install-OpenPaperCli
} catch {
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
  # install.cmd runs this in its own PowerShell, so it can report failure. Run through `irm | iex`, `exit` would
  # close the user's window instead.
  if ($env:OPENPAPER_INSTALL_CMD -eq '1') { exit 1 }
}
}
