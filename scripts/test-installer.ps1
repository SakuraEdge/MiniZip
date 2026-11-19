param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$PreviousInstaller,
  [string]$PreviousTag
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath((Join-Path $workspace ('.test-work\installer\MiniZip-' + [guid]::NewGuid().ToString('N').Substring(0, 8))))
if (-not $target.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer target outside workspace.' }
if (Test-Path -LiteralPath 'HKCU:\Software\MiniZip') { throw 'An existing MiniZip installation was found. Test stopped without changes.' }
if (Test-Path -LiteralPath $target) { throw 'Test target already exists; refusing to overwrite.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$config = Get-Content -LiteralPath (Join-Path $workspace 'release-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installedConfig = Join-Path $target 'resources\app\release-config.json'
$choicePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.zip\UserChoice'
$choiceBefore = if (Test-Path -LiteralPath $choicePath) { (Get-ItemProperty -LiteralPath $choicePath).ProgId } else { $null }
$installed = $false
try {
  if ($PreviousInstaller) {
    $previousPath = (Resolve-Path -LiteralPath $PreviousInstaller).Path
    $process = Start-Process -FilePath $previousPath -ArgumentList @('/S', '/currentuser', "/D=$target") -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Previous installation failed: $($process.ExitCode)" }
    $installed = $true
    $prior = Get-Content -LiteralPath $installedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($PreviousTag -and $prior.tag -cne $PreviousTag) -or $prior.tag -ceq $config.tag) { throw 'Unexpected previous release in upgrade fixture.' }
    Write-Output 'Installed previous release for upgrade verification.'
  }
  $process = Start-Process -FilePath $installerPath -ArgumentList @('/S', '/currentuser', "/D=$target") -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  $installed = $true
  if (-not (Test-Path -LiteralPath (Join-Path $target 'MiniZip.exe'))) { throw 'Installed executable missing.' }
  $current = Get-Content -LiteralPath $installedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($current.tag -cne $config.tag -or $current.installerName -cne $config.installerName) { throw 'Installed release metadata does not match the build.' }
  foreach ($file in @('desktop\program-runs.cjs', 'engines\shell\MiniZip.ExternalFile.exe', 'file-gestures.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target "resources\app\$file") -PathType Leaf)) { throw "Installed component missing: $file" }
  }
  $archiveIcon = Join-Path $target 'resources\app\assets\archive.ico'
  if (-not (Test-Path -LiteralPath $archiveIcon -PathType Leaf)) { throw 'Installed archive icon missing.' }
  $expectedIcon = Join-Path $workspace 'assets\archive.ico'
  if ((Get-FileHash -LiteralPath $archiveIcon).Hash -ne (Get-FileHash -LiteralPath $expectedIcon).Hash) { throw 'Unexpected archive icon content.' }
  $registeredIcon = (Get-Item -LiteralPath 'HKCU:\Software\Classes\MiniZip.Archive\DefaultIcon').GetValue('')
  if ($registeredIcon -ne ('"{0}",0' -f $archiveIcon)) { throw 'Archive association does not use the stacked-page icon.' }
  $appIcon = (Get-Item -LiteralPath 'HKCU:\Software\MiniZip\Capabilities').GetValue('ApplicationIcon')
  if ($appIcon -ne ('"{0}",0' -f (Join-Path $target 'MiniZip.exe'))) { throw 'Application should keep its own icon.' }
  $open = (Get-Item -LiteralPath 'HKCU:\Software\Classes\MiniZip.Archive\shell\open\command').GetValue('')
  $compress = (Get-Item -LiteralPath 'HKCU:\Software\Classes\Directory\shell\MiniZip\shell\20Compress\command').GetValue('')
  if ($open -notlike '*--open --*' -or $compress -notlike '*--compress --*') { throw 'Shell command registration is incorrect.' }
  if (-not $open.Contains($target) -or -not $compress.Contains($target)) { throw 'Shell registration does not target the test installation.' }
  foreach ($type in @('*', 'Directory')) {
    $menu = Get-Item -LiteralPath "HKCU:\Software\Classes\$type\shell\MiniZip"
    if ($menu.GetValue('MUIVerb') -ne 'MiniZip' -or $menu.GetValueNames() -notcontains 'SubCommands') { throw 'MiniZip submenu missing.' }
  }
  foreach ($id in @('01Open', '02ExtractTo', '03ExtractHere', '04ExtractFolder')) {
    $filter = (Get-Item -LiteralPath "HKCU:\Software\Classes\*\shell\MiniZip\shell\$id").GetValue('AppliesTo')
    if (-not $filter.Contains('.zip') -or -not $filter.Contains('.rar')) { throw "Archive action filter missing: $id" }
  }
  foreach ($id in @('20Compress', '21Zip', '22SevenZip')) {
    if ((Get-Item -LiteralPath "HKCU:\Software\Classes\*\shell\MiniZip\shell\$id").GetValueNames() -contains 'AppliesTo') { throw 'Compression must remain available for archives too.' }
  }
  foreach ($command in @(@('02ExtractTo', '--extract-to'), @('03ExtractHere', '--extract-here'), @('04ExtractFolder', '--extract-folder'), @('21Zip', '--compress-zip'), @('22SevenZip', '--compress-7z'))) {
    $value = (Get-Item -LiteralPath "HKCU:\Software\Classes\*\shell\MiniZip\shell\$($command[0])\command").GetValue('')
    if (-not $value.Contains($command[1] + ' --')) { throw "Incorrect submenu command: $($command[0])" }
  }
  foreach ($key in @('HKCU:\Software\Classes\*\shell\MiniZip.Open', 'HKCU:\Software\Classes\*\shell\MiniZip.Compress', 'HKCU:\Software\Classes\Directory\shell\MiniZip.Compress')) {
    if (Test-Path -LiteralPath $key) { throw "Legacy flat menu remains: $key" }
  }
  $association = Get-Item -LiteralPath 'HKCU:\Software\Classes\.zip\OpenWithProgids'
  if ($association.GetValueNames() -notcontains 'MiniZip.Archive') { throw 'ZIP OpenWith association missing.' }
  $choiceAfter = if (Test-Path -LiteralPath $choicePath) { (Get-ItemProperty -LiteralPath $choicePath).ProgId } else { $null }
  if ($choiceBefore -ne $choiceAfter) { throw 'Protected default file association was changed.' }
  Write-Output 'PASS: distinct application/archive icons, file association, quoted Explorer commands and unchanged Windows UserChoice.'
} finally {
  if ($installed) {
    $uninstaller = Get-ChildItem -LiteralPath $target -File -Filter 'Uninstall*.exe' | Select-Object -First 1
    if (-not $uninstaller) { throw 'Uninstaller missing; test installation retained for recovery.' }
    $resolvedUninstaller = [IO.Path]::GetFullPath($uninstaller.FullName)
    if (-not $resolvedUninstaller.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected uninstaller location.' }
    $process = Start-Process -FilePath $resolvedUninstaller -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      if (-not (Test-Path -LiteralPath (Join-Path $target 'MiniZip.exe'))) { break }
      Start-Sleep -Seconds 1
    }
    foreach ($key in @('HKCU:\Software\Classes\MiniZip.Archive', 'HKCU:\Software\Classes\*\shell\MiniZip', 'HKCU:\Software\Classes\Directory\shell\MiniZip', 'HKCU:\Software\Classes\*\shell\MiniZip.Open', 'HKCU:\Software\Classes\*\shell\MiniZip.Compress', 'HKCU:\Software\Classes\Directory\shell\MiniZip.Compress')) {
      if (Test-Path -LiteralPath $key) { throw "Uninstall left registration: $key" }
    }
    if (Test-Path -LiteralPath (Join-Path $target 'MiniZip.exe')) { throw 'Uninstall left executable behind.' }
    if (Test-Path -LiteralPath (Join-Path $target 'resources\app\assets\archive.ico')) { throw 'Uninstall left archive icon behind.' }
    Write-Output 'PASS: uninstaller removed MiniZip registration and application files.'
  }
}
