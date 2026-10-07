// SPDX-FileCopyrightText: Copyright 2024-2026 shadPS4 Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <cmath>

#include "common/assert.h"
#include "common/types.h"
#include "input/controller.h"
#include "input/input_handler.h"
#include "input_mouse.h"

#include <common/singleton.h>
#include <emulator.h>
#include "SDL3/SDL.h"

extern Frontend::WindowSDL* g_window;

namespace Input {

extern std::list<std::pair<InputEvent, bool>> pressed_keys;

int mouse_joystick_binding = 0;
float mouse_deadzone_offset = 0.5, mouse_speed = 1, mouse_speed_offset = 0.1250;
bool mouse_gyro_roll_mode = false;
Uint32 mouse_polling_id = 0;
MouseMode mouse_mode = MouseMode::Off;
bool motion_shake = false;
bool motion_shake_was_active = false;
u32 motion_shake_phase = 0;
float mouse_gyro_last_velocity[2] = {0.0f, 0.0f};

// Switches mouse to a set mode or turns mouse emulation off if it was already in that mode.
// Returns whether the mode is turned on.
bool ToggleMouseModeTo(MouseMode m) {
    if (mouse_mode == m) {
        mouse_mode = MouseMode::Off;
    } else {
        mouse_mode = m;
    }
    return mouse_mode == m;
}

void SetMouseToJoystick(int joystick) {
    mouse_joystick_binding = joystick;
}

void SetMouseParams(float mdo, float ms, float mso) {
    mouse_deadzone_offset = mdo;
    mouse_speed = ms;
    mouse_speed_offset = mso;
}

void SetMouseGyroRollMode(bool mode) {
    mouse_gyro_roll_mode = mode;
}

void SetMotionShake(bool active) {
    motion_shake = active;
}

void EmulateJoystick(GameController* controller, u32 interval) {

    Axis axis_x, axis_y;
    switch (mouse_joystick_binding) {
    case 1:
        axis_x = Axis::LeftX;
        axis_y = Axis::LeftY;
        break;
    case 2:
        axis_x = Axis::RightX;
        axis_y = Axis::RightY;
        break;
    default:
        return; // no update needed
    }

    float d_x = 0, d_y = 0;
    SDL_GetRelativeMouseState(&d_x, &d_y);

    float output_speed =
        SDL_clamp(sqrt(d_x * d_x + d_y * d_y) * mouse_speed + mouse_speed_offset * 128,
                  mouse_deadzone_offset * 128, 128.0);

    float angle = atan2(d_y, d_x);
    float a_x = cos(angle) * output_speed, a_y = sin(angle) * output_speed;

    if (d_x != 0 || d_y != 0) {
        controller->Axis(axis_x, GetAxis(-0x80, 0x7f, a_x), false);
        controller->Axis(axis_y, GetAxis(-0x80, 0x7f, a_y), false);
    } else {
        controller->Axis(axis_x, GetAxis(-0x80, 0x7f, 0), false);
        controller->Axis(axis_y, GetAxis(-0x80, 0x7f, 0), false);
    }
}

constexpr float constant_down_accel[3] = {0.0f, 9.81f, 0.0f};
constexpr float max_accel = 4.0f * 9.81f;
void EmulateGyro(GameController* controller, u32 interval) {
    float d_x = 0, d_y = 0;
    SDL_GetRelativeMouseState(&d_x, &d_y);
    // Moving the mouse back and forth quickly also moves the controller: the change of mouse
    // velocity becomes linear acceleration, so games detecting a shake see one.
    const float seconds = std::max(interval, 1u) / 1000.0f;
    const float velocity[2] = {d_x / seconds, d_y / seconds};
    constexpr float px_to_accel = 4.5e-4f; // a brisk mouse shake gives about 3 g
    float accel[3] = {
        std::clamp((velocity[0] - mouse_gyro_last_velocity[0]) / seconds * px_to_accel, -max_accel,
                   max_accel),
        constant_down_accel[1] +
            std::clamp((velocity[1] - mouse_gyro_last_velocity[1]) / seconds * px_to_accel,
                       -max_accel, max_accel),
        0.0f};
    mouse_gyro_last_velocity[0] = velocity[0];
    mouse_gyro_last_velocity[1] = velocity[1];
    controller->UpdateAcceleration(accel);
    float gyro_from_mouse[3] = {-d_y / 100, -d_x / 100, 0.0f};
    if (mouse_gyro_roll_mode) {
        gyro_from_mouse[1] = 0.0f;
        gyro_from_mouse[2] = -d_x / 100;
    }
    controller->UpdateGyro(gyro_from_mouse);
}

void EmulateTouchpad(GameController* controller, u32 interval) {
    float x, y;
    SDL_MouseButtonFlags mouse_buttons = SDL_GetMouseState(&x, &y);
    controller->SetTouchpadState(0, (mouse_buttons & SDL_BUTTON_LMASK) != 0,
                                 std::clamp(x / g_window->GetWidth(), 0.0f, 1.0f),
                                 std::clamp(y / g_window->GetHeight(), 0.0f, 1.0f));
    controller->Button(Libraries::Pad::OrbisPadButtonDataOffset::TouchPad,
                       (mouse_buttons & SDL_BUTTON_RMASK) != 0);
}

void ApplyMouseInputBlockers() {
    switch (mouse_mode) {
    case MouseMode::Touchpad:
        for (auto& k : pressed_keys) {
            if (k.first.input.sdl_id == SDL_BUTTON_LEFT ||
                k.first.input.sdl_id == SDL_BUTTON_RIGHT) {
                k.second = true;
            }
        }
        break;
    default:
        break;
    }
}

// Held motion_shake binding: the controller is shaken up and down about 7 times a second
// (acceleration and rotation alternate every two polls of 33 ms), like a spray can.
static bool EmulateShake(GameController* controller) {
    if (!motion_shake) {
        if (motion_shake_was_active) {
            motion_shake_was_active = false;
            const float still[3] = {0.0f, 0.0f, 0.0f};
            controller->UpdateAcceleration(constant_down_accel);
            controller->UpdateGyro(still);
        }
        return false;
    }
    motion_shake_was_active = true;
    const float sign = (motion_shake_phase++ / 2) % 2 == 0 ? 1.0f : -1.0f;
    const float accel[3] = {0.0f, constant_down_accel[1] + sign * 2.5f * 9.81f, 0.0f};
    const float gyro[3] = {sign * 6.0f, 0.0f, 0.0f};
    controller->UpdateAcceleration(accel);
    controller->UpdateGyro(gyro);
    return true;
}

Uint32 MousePolling(void* param, Uint32 id, Uint32 interval) {
    auto* controller = (GameController*)param;
    if (EmulateShake(controller)) {
        return interval;
    }
    switch (mouse_mode) {
    case MouseMode::Joystick:
        EmulateJoystick(controller, interval);
        break;
    case MouseMode::Gyro:
        EmulateGyro(controller, interval);
        break;
    case MouseMode::Touchpad:
        EmulateTouchpad(controller, interval);
        break;

    default:
        break;
    }
    return interval;
}

} // namespace Input
