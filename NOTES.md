# Findings - inFAMOUS Second Son on this laptop

Ryzen 7 7735H (8C/16T, 16 MB L3), RTX 4060 Laptop, 32 GB DDR5-4800. Game 1.07 (EU, CUSA00004),
preset pro1440 (PS4 Pro mode, native 2560x1440), fork's inFAMOUS profile on.

## Benchmarks (2026-10-07)

Unattended `ps4kit bench` runs: 180 s from boot, the same opening scene each time, warm shader
cache. First 20 s skipped.

| Run | Build | Setting | FPS avg | 5% low | Frames > 33 ms | Draws/frame | GPU busy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-baseline2 | release 1.0 | profile defaults | 51.5 | 50.1 | 854 | 1301 | 72% |
| Z-baseline | own (ThinLTO, -mtune=znver3) | profile defaults | 51.6 | 50.2 | 862 | 1294 | 72% |
| Z-relaxed | own | `readback_relaxed_sites = 3f3e00` | **60.0** | **60.0** | **0** | 924 | 53% |

- **The lag source:** game threads stall ~0.7 s per second waiting on precise GPU readbacks
  (`readbacks_mode 2` from the fork's game config). 95% of them come from one block of game code,
  `eboot.bin+0x3f3e00`. Letting that code read the previous download (`readback_relaxed_sites`)
  locks 60 fps. The game then issues ~28% fewer draws: that code reads GPU results the game uses
  to decide what to draw (most likely occlusion). Watch for objects popping in; if it looks
  wrong, `ps4kit tune readback_relaxed_sites=none` (live).
- **CPU-tuned build:** no measurable gain over the official release (51.6 vs 51.5). The project
  already targets x86-64-v3 (AVX2) and the release uses LTO; there is nothing Zen 3 specific left
  to gain from compiler flags. The own build is used for its fixes, not speed.
- **Not the bottleneck:** host GPU (53-72% busy at 1440p Pro), shader compilation (0 ms/s once
  the cache is warm - first visits to new areas still stutter while it fills).
- **Crash:** 1 of 6 boots of the release build crashed while loading (JobWorker5 jumped to an
  invalid address, `access=execute`). Not seen with the own build so far; if it happens, relaunch.
- **Gameplay (city, live capture 2026-10-07):** ~3,400 draws/frame (the intro bench has ~1,300).
  The emulator's GPU thread is 97-99% busy at 60 fps, so it is the ceiling: raising
  `vblank_frequency` above 60 can only help indoors/cutscenes, not in the city. 240 fps is out of
  reach on this CPU.
- **"Lag on new scenes":** hitches of 0.6-1.2 s, all from pipeline compilation (up to 14 new
  pipelines in one second), the first time an area / effect is seen. Graphics pipelines compile in
  the background, compute pipelines block (the inFAMOUS profile sets `async_pipelines = 1`; the
  emulator default 2 was turned off by the fork author for this game). They are cached: the same
  place does not hitch again. Experiment: `ps4kit tune async_pipelines=2` (compute in background
  too; risk: effects missing / flickering for a moment while they compile).
- **Ultrawide:** presets `ultrawide` / `pro-ultrawide` render and output 3456x1440 (21:9; 3456 =
  3440 aligned to 128 px). The game has no hard-coded 16:9 constant, so the camera is expected to
  widen (hor+); HUD may stretch. Unverified visually. Patch file backup:
  `inFAMOUS Second Son.xml.before-ultrawide`.
- **Display:** the external monitor is on the RTX 4060, the laptop panel on the AMD iGPU. Play on
  the external monitor; on the laptop panel every frame is copied between GPUs.

- **Audio crash:** once, after ~15 min of play, SDL's own playback thread (`SDLAudioP103`) crashed
  in a memcpy to address 0x20 (inside SDL, Default Device, 8ch -> stereo downmix). No Windows device
  event at that time. If it happens again: note what the audio device was doing (headset sleep?),
  and try `audio_backend` 1 (OpenAL) in config.json.

## Controller: Flydigi Vader 2 (Space Station model code f1), 2.4G dongle

- The Vader 2 has a gyro, but SDL3's Flydigi driver does not expose it as motion (only as "gyro
  mouse"), and the dongle runs in XInput (Xbox 360) mode: `USB\VID_045E&PID_028E\FLYDIGI_2.4G_X360`.
  XInput has no motion data, so the emulator logs `Failed to initialize gyro controls` / `accel controls`.
- Real tilt aiming is still possible: Space Station -> motion sensing -> map to mouse, then F6 in
  the game turns mouse movement back into gyro (and fast movement into shake).
- Own build (2026-10-07, "connect and play"): with a pad without motion sensors (or keyboard), the
  right stick also tilts the controller (spray aim) and wiggling it quickly shakes; **hold Select +
  stick** = touchpad swipe, tap Select = touchpad click (keyboard: Space + I/J/K/L). Automatic, no
  extra buttons; T turns the stick motion off/on, G still shakes.
- SDL3 (inside the emulator) reads gyro + accelerometer natively from the Flydigi Vader 3 Pro,
  Vader 4 Pro, Vader 5 Pro and Apex 5 in their D-input mode (USB VID 04B4 or 37D7). Apex 4 and
  Vader 2 only report motion in gyro-mouse mode; older models none. If the pad supports it, switch
  it to D-input in Flydigi Space Station (D:\Programs\Utils\FlydigiPcSpace) and the log will show
  `Gyro initialized`.
- Otherwise, with the own build:
  - **Hold G** = shake (spray can). In Space Station, map a spare button (back paddle, C/Z, M1-M4)
    to the keyboard key G to shake from the pad.
  - **F6** = mouse-to-gyro, for aiming the spray can with the mouse; moving the mouse quickly back
    and forth also shakes. If Space Station can map the pad's gyro to mouse movement, F6 turns that
    back into real tilt aiming.
  - Bindings: E:\Entertaiment\shadPS4-user\input_config\global.ini (`motion_shake = g`).
