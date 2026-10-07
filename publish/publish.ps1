# Publishes the two fixes as pull requests to weshayoub92/shadPS4-AYOUB1080p.
# Before running: open https://github.com/weshayoub92/shadPS4-AYOUB1080p and click "Fork"
# (logged in as T-Damer). The first push opens a browser window to authorize git (Git Credential
# Manager) - approve it once.
$ErrorActionPreference = 'Stop'
$repo = 'E:\Projects\shadPS4-AYOUB1080p'
$fork = 'https://github.com/T-Damer/shadPS4-AYOUB1080p.git'
$branches = 'fix/patches-fixed-address-eboot', 'feature/motion-shake'

if (-not (git -C $repo remote | Select-String -SimpleMatch 'fork')) { git -C $repo remote add fork $fork }
git -C $repo fetch origin
foreach ($b in $branches) {
    git -C $repo push -u fork $b
    $url = "https://github.com/weshayoub92/shadPS4-AYOUB1080p/compare/main...T-Damer:shadPS4-AYOUB1080p:$($b)?expand=1"
    Write-Host "Open the pull request: $url"
    Start-Process $url
}
Write-Host 'PR texts to paste: E:\Projects\ps4kit\publish\pr-1-patcher-fixed-address.md and pr-2-motion-shake.md'
