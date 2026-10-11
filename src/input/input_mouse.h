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
// Whether a trigger is kept from the game: in touch mode, or holding a finger after it ended.
bool IsTouchTriggerHeld(Axis trigger);
// The player's stick or trigger value (after deadzones), which touch mode keeps from the game.
void NoteTouchAxis(Axis axis, int value);
int TouchAxisValue(Axis axis);
void SetTouchClick(bool held);
void SetTouchFlick(int finger, bool held);

// Motion mode (motion_mode binding, L3 + R3 by default), for spray cans on controllers without
// motion sensors: the right stick turns the controller, D-pad left or right lays it on that side
// (press again to straighten) and L1 shakes it, while everything else reaches the game.
void ToggleMotionMode();
bool IsMotionModeActive();
// D-pad press in motion mode: the side the controller now lies on (-1 left, 0 upright, 1 right).
int ToggleMotionTilt(int side);
void SetMotionShaking(bool shaking);

struct TouchView {
    bool active;
    bool motion_active;
    int motion_tilt;
    bool motion_shaking;
    bool held_after; // a finger held by its trigger after touch mode ended
    bool down[2];
    float x[2];
    float y[2];
};
TouchView GetTouchView();

// Polls the mouse for changes
Uint32 MousePolling(void* param, Uint32 id, Uint32 interval);

} // namespace Input
