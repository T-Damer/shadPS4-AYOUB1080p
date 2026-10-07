# A/B of the write fault window experiment on FixBuild (SHADPS4_FAULT_WINDOW_KB), alternating
# runs to even out laptop heat. Stops if a game is already running (the user playing).
param([int]$Seconds = 100, [string[]]$Runs = @('0', '64', '0', '64', '256', '256'))
Set-Location E:\Projects\ps4kit
$i = 0
foreach ($kb in $Runs) {
    if (Get-Process shadps4 -ErrorAction SilentlyContinue) { 'game running: stopped'; break }
    $i++
    $env:SHADPS4_FAULT_WINDOW_KB = $kb
    "== run $i window $kb KB"
    node ps4kit.js bench "fw$kb-$i" --build fixbuild --seconds $Seconds 2>&1 | Select-String 'FPS|draws|CRASH|No "Perf'
    $log = "E:\Projects\ps4kit\perf-logs\bench-fw$kb-$i.txt"
    Select-String -Path $log -Pattern 'Perf: game threads made' | Select-Object -Last 1 |
        ForEach-Object { '   ' + ($_.Line -split 'Perf: ')[1] }
    Select-String -Path $log -Pattern 'Perf: threads that spent' | Select-Object -Last 1 |
        ForEach-Object { '   ' + ($_.Line -split 'Perf: ')[1] }
}
Remove-Item Env:SHADPS4_FAULT_WINDOW_KB -ErrorAction SilentlyContinue
