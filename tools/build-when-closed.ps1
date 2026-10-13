# Waits until no shadPS4 runs (the user stopped playing), then builds and installs FixBuild, and
# switches its gamepad Select binding from a touchpad tap to the new touch mode.
while (Get-Process shadps4 -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 15 }
"game closed at $(Get-Date -Format HH:mm:ss), building"
$t = Get-Date
& E:\Projects\ps4kit\build-fixbuild.bat 2>&1 | Select-String 'error|Installed|FAILED' | Select-Object -First 20
"build took $([int]((Get-Date) - $t).TotalMinutes) min"
$installed = (Get-Item E:\Entertaiment\shadPS4-FixBuild\shadps4.exe).LastWriteTime -gt $t
if ($installed) {
    $ini = 'E:\Entertaiment\shadPS4-FixBuild\user\input_config\default.ini'
    Copy-Item $ini "$ini.bak" -Force
    $s = Get-Content -Raw $ini
    $s = $s -replace '(?m)^touchpad_center = back\s*$', 'touch_mode = back'
    Set-Content $ini $s -NoNewline
    Select-String -Path $ini -Pattern 'touch_mode|touchpad_center' | ForEach-Object { "ini: $($_.Line)" }
} else {
    'NOT installed (build failed), the old exe stays'
}
