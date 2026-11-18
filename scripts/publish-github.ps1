param(
  [string]$GitHubCli = 'gh',
  [string]$RepositoryName = 'MiniZip'
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $workspace
if ($RepositoryName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid repository name.' }
& $GitHubCli auth status
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI login is required. Run gh auth login first.' }
$profileJson = & $GitHubCli api user
if ($LASTEXITCODE -ne 0) { throw 'Could not read authenticated GitHub profile.' }
$profile = $profileJson | ConvertFrom-Json
$repository = "$($profile.login)/$RepositoryName"
node scripts/configure-release.cjs $repository 'dev-v1.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Release configuration failed.' }
npm install --package-lock-only --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Lockfile update failed.' }
git config user.name $profile.login
git config user.email "$($profile.id)+$($profile.login)@users.noreply.github.com"
git add --all
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Whitespace validation failed.' }
git commit -m 'Release MiniZip Dev v1.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Commit failed; inspect the repository before retrying.' }
& $GitHubCli repo view $repository --json nameWithOwner 2>$null
if ($LASTEXITCODE -eq 0) { throw "Repository $repository already exists; refusing to overwrite or change its visibility automatically." }
& $GitHubCli repo create $repository --public --description 'MiniZip - Windows archive manager with quick compression and Chinese password support' --source . --remote origin --push
if ($LASTEXITCODE -ne 0) { throw 'Repository creation or push failed; inspect remote state before retrying.' }
git tag dev-v1.0.0
if ($LASTEXITCODE -ne 0) { throw 'Release tag already exists or could not be created.' }
git push origin dev-v1.0.0
if ($LASTEXITCODE -ne 0) { throw 'Tag push failed.' }
Write-Output "Created public repository: https://github.com/$repository"
Write-Output 'GitHub Actions will build, verify and publish the Dev v1.0.0 prerelease.'
