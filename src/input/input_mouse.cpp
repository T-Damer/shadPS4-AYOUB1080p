// SPDX-FileCopyrightText: Copyright 2024-2026 shadPS4 Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <atomic>
#include <cmath>

#include "common/assert.h"
#include "common/logging/log.h"
#include "common/types.h"
#include "core/emulator_settings.h"
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
// Motion from the right stick, on by default for controllers without motion sensors.
std::atomic<bool> stick_motion_enabled{true};
bool stick_motion_was_active = false;
float stick_motion_last[2] = {0.0f, 0.0f};
// touchpad_swipe binding: held, the sticks drag one or two fingers on the touchpad; a short tap
// clicks it.
std::atomic<bool> swipe_held{false};
std::atomic<bool> swipe_release_pending{false};
std::atomic<u64> swipe_start_ms{0};
bool swipe_moved = false;
int touchpad_click_pulse = 0;
float swipe_position[2] = {0.5f, 0.5f};
float second_finger[2] = {0.75f, 0.5f};
bool two_fingers = false;

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

void ToggleStickToGyro() {
    stick_motion_enabled = !stick_motion_enabled;
    LOG_INFO(Input, "Motion from the right stick (controllers without motion sensors) {}",
             stick_motion_enabled ? "on" : "off");
}

void SetTouchpadSwipe(bool held) {
    if (held) {
        swipe_start_ms = SDL_GetTicks();
        swipe_held = true;
    } else if (swipe_held) {
        swipe_held = false;
        swipe_release_pending = true;
    }
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

static float StickDeflection(const State& state, Axis axis) {
    const float v = (state.axes[std::to_underlying(axis)] - 128) / 127.0f;
    return std::abs(v) < 0.1f ? 0.0f : std::clamp(v, -1.0f, 1.0f);
}

// Controllers without motion sensors (XInput pads, keyboard): the right stick also moves the
// controller, so games aimed or shaken by motion need no extra button. Its deflection turns the
// controller (pitch and yaw, up to 3 rad/s), and moving it quickly (wiggling it back and forth)
// gives linear acceleration, which games read as a shake. Games ignore motion outside the
// moments they ask for it. hotkey_toggle_stick_to_gyro turns this off and on.
static void EmulateMotionFromStick(GameController* controller, u32 interval) {
    const bool active = EmulatorSettings.IsStickMotionEnabled() && stick_motion_enabled &&
                        !controller->has_motion_sensors;
    if (!active) {
        if (stick_motion_was_active) {
            stick_motion_was_active = false;
            const float still[3] = {0.0f, 0.0f, 0.0f};
            controller->UpdateAcceleration(constant_down_accel);
            controller->UpdateGyro(still);
        }
        return;
    }
    stick_motion_was_active = true;
    const auto state = controller->ReadState();
    const float dx = StickDeflection(state, Axis::RightX);
    const float dy = StickDeflection(state, Axis::RightY);
    constexpr float max_rate = 3.0f;
    const float gyro[3] = {-dy * max_rate, -dx * max_rate, 0.0f};
    // A full flick of the stick within one 33 ms poll gives about 3 g.
    const float seconds = std::max(interval, 1u) / 1000.0f;
    constexpr float deflection_to_accel = 1.0f;
    const float accel[3] = {std::clamp((dx - stick_motion_last[0]) / seconds * deflection_to_accel,
                                       -max_accel, max_accel),
                            constant_down_accel[1] + std::clamp((dy - stick_motion_last[1]) /
                                                                    seconds * deflection_to_accel,
                                                                -max_accel, max_accel),
                            0.0f};
    stick_motion_last[0] = dx;
    stick_motion_last[1] = dy;
    controller->UpdateAcceleration(accel);
    controller->UpdateGyro(gyro);
}

// touchpad_swipe: for controllers without a touchpad. While held, a finger touches the touchpad
// and follows the stick pushed (centre at rest), so a stick movement is a swipe; with both sticks
// pushed, two fingers touch it, one per stick. A short tap without moving a stick clicks the
// touchpad instead.
static void EmulateTouchpadSwipe(GameController* controller) {
    using Libraries::Pad::OrbisPadButtonDataOffset;
    if (swipe_held) {
        const auto state = controller->ReadState();
        const float rx = StickDeflection(state, Axis::RightX),
                    ry = StickDeflection(state, Axis::RightY);
        const float lx = StickDeflection(state, Axis::LeftX),
                    ly = StickDeflection(state, Axis::LeftY);
        const bool left_pushed = lx * lx + ly * ly > 0.09f;
        const bool right_pushed = rx * rx + ry * ry > 0.09f;
        if (left_pushed || right_pushed) {
            swipe_moved = true;
        }
        if (left_pushed && right_pushed) {
            // Both sticks: two fingers, the left stick on the left half of the touchpad and the
            // right stick on the right half.
            swipe_position[0] = 0.25f + lx * 0.22f;
            swipe_position[1] = 0.5f + ly * 0.45f;
            second_finger[0] = 0.75f + rx * 0.22f;
            second_finger[1] = 0.5f + ry * 0.45f;
            controller->SetTouchpadState(0, true, swipe_position[0], swipe_position[1]);
            controller->SetTouchpadState(1, true, second_finger[0], second_finger[1]);
            two_fingers = true;
        } else {
            const float x = left_pushed ? lx : rx, y = left_pushed ? ly : ry;
            swipe_position[0] = 0.5f + x * 0.45f;
            swipe_position[1] = 0.5f + y * 0.45f;
            controller->SetTouchpadState(0, true, swipe_position[0], swipe_position[1]);
            if (two_fingers) {
                controller->SetTouchpadState(1, false, second_finger[0], second_finger[1]);
                two_fingers = false;
            }
        }
    } else if (swipe_release_pending.exchange(false)) {
        controller->SetTouchpadState(0, false, swipe_position[0], swipe_position[1]);
        if (two_fingers) {
            controller->SetTouchpadState(1, false, second_finger[0], second_finger[1]);
            two_fingers = false;
        }
        if (!swipe_moved && SDL_GetTicks() - swipe_start_ms < 300) {
            touchpad_click_pulse = 2;
        }
        swipe_moved = false;
    }
    if (touchpad_click_pulse > 0) {
        controller->Button(OrbisPadButtonDataOffset::TouchPad, touchpad_click_pulse == 2);
        --touchpad_click_pulse;
    }
}

Uint32 MousePolling(void* param, Uint32 id, Uint32 interval) {
    auto* controller = (GameController*)param;
    EmulateTouchpadSwipe(controller);
    if (EmulateShake(controller)) {
        return interval;
    }
    if (mouse_mode != MouseMode::Gyro) {
        EmulateMotionFromStick(controller, interval);
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
