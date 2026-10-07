// SPDX-FileCopyrightText: Copyright 2024 shadPS4 Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "SDL3/SDL.h"
#include "common/types.h"
#include "input/controller.h"

namespace Input {

enum MouseMode {
    Off = 0,
    Joystick,
    Gyro,
    Touchpad,
};

bool ToggleMouseModeTo(MouseMode m);
void SetMouseToJoystick(int joystick);
void SetMouseParams(float mouse_deadzone_offset, float mouse_speed, float mouse_speed_offset);
void SetMouseGyroRollMode(bool mode);

void EmulateJoystick(GameController* controller, u32 interval);
void EmulateGyro(GameController* controller, u32 interval);

void ApplyMouseInputBlockers();

// Touch mode, for controllers without a touchpad (touch_mode binding, Select by default): each
// stick moves a cursor on the touchpad and the game's sticks and triggers stay still. Holding L2
// or R2 puts the left or right finger down at its cursor (moving the stick then drags it), Cross
// clicks the touchpad, and L3 or R3 flicks that finger from its cursor the way the stick points.
void ToggleTouchMode();
bool IsTouchModeActive();
// The player's stick or trigger value (after deadzones), which touch mode keeps from the game.
void NoteTouchAxis(Axis axis, int value);
int TouchAxisValue(Axis axis);
void SetTouchClick(bool held);
void SetTouchFlick(int finger, bool held);

struct TouchView {
    bool active;
    bool down[2];
    float x[2];
    float y[2];
};
TouchView GetTouchView();

// Polls the mouse for changes
Uint32 MousePolling(void* param, Uint32 id, Uint32 interval);

} // namespace Input
