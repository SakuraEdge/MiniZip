param(
  [Parameter(Mandatory = $true)][string]$Installer
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath((Join-Path $workspace '.test-work\installer\MiniZip'))
if (-not $target.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer target outside workspace.' }
if (Test-Path -LiteralPath 'HKCU:\Software\MiniZip') { throw 'An existing MiniZip installation was found. Test stopped without changes.' }
if (Test-Path -LiteralPath $target) { throw 'Test target already exists; refusing to overwrite.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$choicePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.zip\UserChoice'
$choiceBefore = if (Test-Path -LiteralPath $choicePath) { (Get-ItemProperty -LiteralPath $choicePath).ProgId } else { $null }
$installed = $false
try {
  $process = Start-Process -FilePath $installerPath -ArgumentList @('/S', '/currentuser', "/D=$target") -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  $installed = $true
  if (-not (Test-Path -LiteralPath (Join-Path $target 'MiniZip.exe'))) { throw 'Installed executable missing.' }
  $open = (Get-Item -LiteralPath 'HKCU:\Software\Classes\MiniZip.Archive\shell\open\command').GetValue('')
  $compress = (Get-Item -LiteralPath 'HKCU:\Software\Classes\Directory\shell\MiniZip.Compress\command').GetValue('')
  if ($open -notlike '*--open --*' -or $compress -notlike '*--compress --*') { throw 'Shell command registration is incorrect.' }
  if (-not $open.Contains($target) -or -not $compress.Contains($target)) { throw 'Shell registration does not target the test installation.' }
  $association = Get-Item -LiteralPath 'HKCU:\Software\Classes\.zip\OpenWithProgids'
  if ($association.GetValueNames() -notcontains 'MiniZip.Archive') { throw 'ZIP OpenWith association missing.' }
  $choiceAfter = if (Test-Path -LiteralPath $choicePath) { (Get-ItemProperty -LiteralPath $choicePath).ProgId } else { $null }
  if ($choiceBefore -ne $choiceAfter) { throw 'Protected default file association was changed.' }
  Write-Output 'PASS: installed executable, file association, quoted Explorer commands and unchanged Windows UserChoice.'
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
    foreach ($key in @('HKCU:\Software\Classes\MiniZip.Archive', 'HKCU:\Software\Classes\*\shell\MiniZip.Open', 'HKCU:\Software\Classes\*\shell\MiniZip.Compress', 'HKCU:\Software\Classes\Directory\shell\MiniZip.Compress')) {
      if (Test-Path -LiteralPath $key) { throw "Uninstall left registration: $key" }
    }
    if (Test-Path -LiteralPath (Join-Path $target 'MiniZip.exe')) { throw 'Uninstall left executable behind.' }
    Write-Output 'PASS: uninstaller removed MiniZip registration and application files.'
  }
}
