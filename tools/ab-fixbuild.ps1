# A/B: own build vs FixBuild, both at native 1080p, alternating to even out laptop heat.
# Turns the 2560x1080 ultrawide patch off for the own build's runs and restores the patch file.
param([int]$Seconds = 100, [int]$WarmUp = 240)
$ErrorActionPreference = 'Stop'
$xml = 'E:\Entertaiment\shadPS4-user\patches\shadPS4-AYOUB1080p\inFAMOUS Second Son.xml'
$backup = "$xml.before-ab"
Copy-Item $xml $backup -Force
Set-Location E:\Projects\ps4kit
try {
    $s = Get-Content -Raw $xml
    $s = [regex]::Replace($s, '(<Metadata[^>]*?Name="Ultrawide 2560x1080 21:9 \(render and output\)"[^>]*>)', {
        param($m) $m.Value -replace 'isEnabled="true"', 'isEnabled="false"' })
    Set-Content $xml $s -NoNewline
    ([xml]$s).SelectNodes('//Metadata') | Where-Object isEnabled -eq 'true' | ForEach-Object { "own build patches on: $($_.Name)" }
    if ($WarmUp -gt 0) {
        "== warm-up fixbuild ($WarmUp s, shader compilation)"
        node ps4kit.js bench fix-warmup --build fixbuild --seconds $WarmUp 2>&1 | Select-String 'FPS|draws|CRASH|No "Perf'
    }
    foreach ($r in 'own-a', 'fix-a', 'own-b', 'fix-b') {
        $build = if ($r -like 'own*') { 'own' } else { 'fixbuild' }
        "== $r ($build)"
        node ps4kit.js bench "ab-$r" --build $build --seconds $Seconds 2>&1 | Select-String 'FPS|draws|CRASH|No "Perf'
    }
} finally {
    Copy-Item $backup $xml -Force
    'patch file restored'
}
