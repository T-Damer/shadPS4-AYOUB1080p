// SPDX-FileCopyrightText: Copyright 2024-2026 shadPS4 Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <utility>

#include "common/assert.h"
#include "common/logging/log.h"
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

void EmulateGyro(GameController* controller, u32 interval) {
    float d_x = 0, d_y = 0;
    SDL_GetRelativeMouseState(&d_x, &d_y);
    float gyro_from_mouse[3] = {-d_y / 100, -d_x / 100, 0.0f};
    if (mouse_gyro_roll_mode) {
        gyro_from_mouse[1] = 0.0f;
        gyro_from_mouse[2] = -d_x / 100;
    }
    controller->SetEmulatedRotationRate(gyro_from_mouse);
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

namespace {

std::atomic<bool> touch_mode{false};
std::atomic<bool> touch_click{false};
std::array<std::atomic<bool>, 2> touch_flick_held{false, false};
// Sticks (-128..128) and triggers (0..128) as the player holds them, by Axis.
std::array<std::atomic<int>, std::to_underlying(Axis::AxisMax)> touch_axes{};

// Owned by the polling timer, read by the overlay.
std::array<std::atomic<float>, 4> cursor{0.3f, 0.5f, 0.7f, 0.5f}; // x0, y0, x1, y1
std::array<std::atomic<bool>, 2> finger_shown_down{false, false};
std::array<std::atomic<float>, 4> finger_shown{0.3f, 0.5f, 0.7f, 0.5f};

struct Flick {
    bool was_held = false;
    int step = -1; // -1: none
    float from[2]{};
    float dir[2]{};
};
std::array<Flick, 2> flicks;
std::array<int, 2> finger_slot{-1, -1}; // touchpad slot each finger is down in
bool touch_click_sent = false;
bool touch_was_active = false;

constexpr int FlickSteps = 6;          // ~200 ms of movement at 33 ms polls
constexpr float FlickLength = 0.45f;   // of the touchpad width
constexpr float CursorSpeed = 0.9f;    // touchpad widths per second at full deflection
constexpr float PadAspect = 1920.0f / 941.0f;

float StickOf(Axis axis) {
    return std::clamp(touch_axes[std::to_underlying(axis)].load() / 128.0f, -1.0f, 1.0f);
}

void LiftAll(GameController* controller) {
    for (int f = 0; f < 2; ++f) {
        if (finger_slot[f] >= 0) {
            controller->SetTouchpadState(finger_slot[f], false, finger_shown[f * 2],
                                         finger_shown[f * 2 + 1]);
            finger_slot[f] = -1;
        }
        finger_shown_down[f] = false;
        flicks[f].step = -1;
    }
    if (touch_click_sent) {
        controller->Button(Libraries::Pad::OrbisPadButtonDataOffset::TouchPad, false);
        touch_click_sent = false;
    }
}

void EmulateStickTouch(GameController* controller, u32 interval) {
    if (!touch_mode) {
        if (touch_was_active) {
            LiftAll(controller);
            touch_was_active = false;
        }
        return;
    }
    touch_was_active = true;
    const float seconds = std::max(interval, 1u) / 1000.0f;
    const Axis stick_axes[2][2] = {{Axis::LeftX, Axis::LeftY}, {Axis::RightX, Axis::RightY}};
    const Axis triggers[2] = {Axis::TriggerLeft, Axis::TriggerRight};
    const bool click = touch_click;
    for (int f = 0; f < 2; ++f) {
        const float sx = StickOf(stick_axes[f][0]), sy = StickOf(stick_axes[f][1]);
        auto& flick = flicks[f];
        const bool flick_held = touch_flick_held[f];
        if (flick_held && !flick.was_held) {
            // Flick: a quick swipe from the cursor the way the stick points (right if centred).
            const float length = std::sqrt(sx * sx + sy * sy);
            flick.from[0] = cursor[f * 2];
            flick.from[1] = cursor[f * 2 + 1];
            flick.dir[0] = length > 0.3f ? sx / length : 1.0f;
            flick.dir[1] = length > 0.3f ? sy / length : 0.0f;
            flick.step = 0;
        }
        flick.was_held = flick_held;

        float x = cursor[f * 2], y = cursor[f * 2 + 1];
        bool down = touch_axes[std::to_underlying(triggers[f])] > 0x20 || (f == 0 && click);
        if (flick.step >= 0) {
            if (flick.step <= FlickSteps) {
                const float t = static_cast<float>(flick.step) / FlickSteps;
                x = std::clamp(flick.from[0] + flick.dir[0] * FlickLength * t, 0.0f, 1.0f);
                y = std::clamp(flick.from[1] + flick.dir[1] * FlickLength * PadAspect * t, 0.0f,
                               1.0f);
                down = true;
                ++flick.step;
            } else {
                flick.step = -1; // lifted for a poll, the finger leaves the pad
                down = false;
            }
        } else {
            // Finer near the centre of the stick, fast at full deflection.
            x = std::clamp(x + sx * std::abs(sx) * CursorSpeed * seconds, 0.0f, 1.0f);
            y = std::clamp(y + sy * std::abs(sy) * CursorSpeed * PadAspect * seconds, 0.0f, 1.0f);
            cursor[f * 2] = x;
            cursor[f * 2 + 1] = y;
        }

        if (down) {
            if (finger_slot[f] < 0) {
                // A single finger always lands in the first slot, as games read them in order.
                const int other = finger_slot[1 - f];
                finger_slot[f] = other == 0 ? 1 : 0;
            }
            controller->SetTouchpadState(finger_slot[f], true, x, y);
        } else if (finger_slot[f] >= 0) {
            controller->SetTouchpadState(finger_slot[f], false, x, y);
            finger_slot[f] = -1;
        }
        finger_shown[f * 2] = x;
        finger_shown[f * 2 + 1] = y;
        finger_shown_down[f] = down;
    }
    if (click != touch_click_sent) {
        controller->Button(Libraries::Pad::OrbisPadButtonDataOffset::TouchPad, click);
        touch_click_sent = click;
    }
}

} // namespace

void ToggleTouchMode() {
    touch_mode = !touch_mode;
    touch_click = false;
    touch_flick_held[0] = touch_flick_held[1] = false;
    LOG_INFO(Input, "Touch mode {}", touch_mode ? "on" : "off");
}

bool IsTouchModeActive() {
    return touch_mode;
}

void NoteTouchAxis(Axis axis, int value) {
    const auto index = std::to_underlying(axis);
    if (index < touch_axes.size()) {
        touch_axes[index] = value;
    }
}

int TouchAxisValue(Axis axis) {
    const auto index = std::to_underlying(axis);
    return index < touch_axes.size() ? touch_axes[index].load() : 0;
}

void SetTouchClick(bool held) {
    touch_click = held;
}

void SetTouchFlick(int finger, bool held) {
    if (finger == 0 || finger == 1) {
        touch_flick_held[finger] = held;
    }
}

TouchView GetTouchView() {
    TouchView view{};
    view.active = touch_mode;
    for (int f = 0; f < 2; ++f) {
        view.down[f] = finger_shown_down[f];
        view.x[f] = finger_shown[f * 2];
        view.y[f] = finger_shown[f * 2 + 1];
    }
    return view;
}

Uint32 MousePolling(void* param, Uint32 id, Uint32 interval) {
    auto* controller = (GameController*)param;
    EmulateStickTouch(controller, interval);
    static bool was_gyro = false;
    if (was_gyro && mouse_mode != MouseMode::Gyro) {
        // Otherwise the last mouse movement keeps turning the controller after gyro mode is off
        constexpr float no_rotation[3] = {0.0f, 0.0f, 0.0f};
        controller->SetEmulatedRotationRate(no_rotation);
    }
    was_gyro = mouse_mode == MouseMode::Gyro;
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
