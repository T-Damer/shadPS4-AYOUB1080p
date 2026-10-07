# Plain controllers, per-game Tweaks tab and shader compilation note

Branch: `T-Damer:feature/plain-controller-tweaks` -> `weshayoub92:main`
Builds on #2 (motion_shake): its first commit is that PR's; review from the second commit on.

Goal: play inFAMOUS Second Son with any controller (no gyro, no touchpad) or a keyboard, with no
extra buttons.

- **Motion from the sticks:** on a pad without motion sensors (or keyboard), the right stick also
  tilts the virtual controller (spray can aiming) and wiggling it quickly shakes it. Off with
  `stick_motion_enabled` / the hotkey `hotkey_toggle_stick_to_gyro`.
- **Touch mode:** Select (Space on keyboard) toggles an on-screen touchpad. A pushed stick is a
  finger swiping, both sticks are two fingers (the "move car" gesture), Cross clicks the touchpad.
  The game's sticks stay centred while it is on.
- **Per-game Tweaks tab** in Big Picture settings: resolution (from patches named `WxH`), the
  game's patch checkboxes (saved to the patch XML), stick motion, and *Smooth shader compilation*
  (compute pipelines compiled in the background too, `async_pipelines = 2`).
- **Shader note:** with smooth shader compilation on, a small "Compiling shaders in background" note with the number left in
  the corner while pipelines compile in the background.

Testing: Windows, Flydigi Vader 2 in XInput mode and keyboard, inFAMOUS Second Son 1.07.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
