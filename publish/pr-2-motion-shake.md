## Input: motion_shake binding and shake from mouse-to-gyro

Branch: `feature/motion-shake`

### Problem
inFAMOUS Second Son asks the player to shake the controller (the spray can, from the first
minutes of the game). With a controller SDL reads no motion sensors from (XInput pads, many third
party controllers: `Failed to initialize gyro controls` / `accel controls` in the log) there is
no way to do it. Mouse-to-gyro (F6) does not help either: it only reports rotation, the
accelerometer stays at gravity.

### Change
- New bindable output `motion_shake`: while held, the controller is shaken up and down about
  7 times a second (acceleration ±2.5 g around gravity and rotation, alternating every two mouse
  polls of 33 ms). Example: `motion_shake = g` in `global.ini`, or bound to a controller button.
- Mouse-to-gyro also reports linear acceleration, from the change of mouse velocity (clamped to
  4 g), so moving the mouse back and forth quickly shakes the controller too.
- Nothing changes while the binding is not held and mouse-to-gyro is off: real motion sensors
  keep reporting as before.

### Testing
- Builds with clang-cl (Windows), clang-format 19 clean.
- The binding parses and the emulator starts with an XInput controller connected.
- In-game: <!-- to fill in after trying the spray can sequence -->
