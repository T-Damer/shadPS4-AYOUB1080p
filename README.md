# ps4kit

Helpers for playing PS4 dumps with [shadPS4-AYOUB1080p](https://github.com/weshayoub92/shadPS4-AYOUB1080p)
(built around inFAMOUS Second Son, CUSA00004). Node.js, no dependencies. Paths live in `ps4kit.json`.

```
ps4kit info <pkg>...                 what a PKG is and where it extracts to
ps4kit extract <pkg>... [--to dir]   extract game / update / DLC PKGs
ps4kit verify <pkg> [dir] [--deep]   compare an extracted folder with its PKG
ps4kit preset [name]                 resolution preset: 1080p 1440p 2160p pro1080 pro1440 pro1800 pro2160
ps4kit launch [--perf] [--build b]   start the game (b: own, release, fresh)
ps4kit perf [log]                    summarise the performance logging of the last session
ps4kit bench <name> [--build b] [key=value]...   unattended 3 min run from boot + summary (A/B tests)
ps4kit tune [key=value]...           show or change perf_tuning.ini (live while the game runs)
ps4kit status                        paths, versions, preset, pipeline cache size
```

## Why `extract` exists

PkgTool's own `pkg_extract` (LibOrbisPkg 0.2) silently corrupts large PKGs: files of the inner
PFS are stored contiguously (first block pointer + `0xFFFFFFFF` markers) and PkgTool reads them
as if every pointer were real. Result for inFAMOUS: ~300 files missing, zero-filled blocks inside
others, and the game crashing at boot with a null pointer read at `+0x98`. `ps4kit extract`
only uses PkgTool to decrypt the image (`pkg_extractouterpfs`) and reads the filesystem itself
(`lib/pfs.js`). It also writes the PKG metadata the emulator wants in `sce_sys`
(npbind, playgo, trophies...). Updates go to `<TITLE>-patch`, DLC to `addcont/<TITLE>/<label>`.

## Performance workflow

1. `ps4kit launch --perf`, play a few minutes where it lags, quit.
2. `ps4kit perf` - FPS (avg, 5% low), slow frames and their causes, busiest threads, what the
   game's main thread waits on, GPU readbacks by game code, and a verdict. Each report is kept in
   `perf-logs/` with its log, to compare settings.
3. `ps4kit tune key=value` changes a setting while the game runs (keys: `src/core/perf_sampler.h`
   of the emulator).

Findings on this laptop (Ryzen 7 7735H, RTX 4060 Laptop) are in `NOTES.md`.

## Controller motion (spray can)

The emulator reads motion through SDL3. Flydigi Vader 3 Pro / 4 Pro / 5 Pro and Apex 5 report gyro
and accelerometer in their D-input mode; XInput (Xbox 360) mode reports none. Without sensors, the
own build adds `motion_shake` (hold `G` to shake), stick-to-gyro (`T`: aim with the right stick) and accelerometer
output for mouse-to-gyro (F6). See `NOTES.md`.

## Building the emulator

`build-emulator.bat` (Release + ThinLTO, `-mtune=znver3`), installs to `E:\Entertaiment\shadPS4-own`.
Needs VS 2022 Build Tools (C++ and Clang) and Python 3.12.
