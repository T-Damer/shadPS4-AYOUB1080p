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
void SetMotionShake(bool active);
void ToggleStickToGyro();
void SetTouchpadSwipe(bool held);
/// touchpad_swipe held: the sticks drive the touchpad instead of the game's sticks.
bool IsTouchModeActive();
/// Stick positions as the controller reports them (0-255), also while in touch mode.
void NoteStickAxis(Axis axis, int value);
int RawStickAxis(Axis axis);

void EmulateJoystick(GameController* controller, u32 interval);
void EmulateGyro(GameController* controller, u32 interval);

void ApplyMouseInputBlockers();

// Polls the mouse for changes
Uint32 MousePolling(void* param, Uint32 id, Uint32 interval);

} // namespace Input
