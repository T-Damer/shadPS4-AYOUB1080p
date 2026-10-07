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
// Touch mode (touchpad_swipe binding toggles it): the sticks are fingers on the touchpad.
std::atomic<bool> touch_mode{false};
std::atomic<bool> touch_click_held{false}; // Cross while in touch mode: touchpad click
bool touch_click_sent = false;
// Fingers on the emulated touchpad (also drawn by the touch mode overlay).
std::array<std::atomic<bool>, 2> finger_down{false, false};
std::array<std::atomic<float>, 4> finger_position{0.5f, 0.5f, 0.5f, 0.5f}; // x0, y0, x1, y1
// Stick positions before touch mode centres them for the game (LeftX, LeftY, RightX, RightY).
std::array<std::atomic<int>, 4> raw_sticks{0x80, 0x80, 0x80, 0x80};

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

bool IsTouchModeActive() {
    return touch_mode;
}

void SetTouchClick(bool held) {
    touch_click_held = held;
}

TouchView GetTouchView() {
    TouchView view{};
    view.active = touch_mode;
    for (int i = 0; i < 2; ++i) {
        view.down[i] = finger_down[i];
        view.x[i] = finger_position[i * 2];
        view.y[i] = finger_position[i * 2 + 1];
    }
    return view;
}

void NoteStickAxis(Axis axis, int value) {
    const auto index = std::to_underlying(axis);
    if (index < raw_sticks.size()) {
        raw_sticks[index] = value;
    }
}

int RawStickAxis(Axis axis) {
    const auto index = std::to_underlying(axis);
    return index < raw_sticks.size() ? raw_sticks[index].load() : 0x80;
}

void ToggleTouchMode() {
    touch_mode = !touch_mode;
    touch_click_held = false;
    LOG_INFO(Input, "Touch mode {}", touch_mode ? "on" : "off");
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

static float DeflectionOf(int axis_value) {
    const float v = (axis_value - 128) / 127.0f;
    return std::abs(v) < 0.1f ? 0.0f : std::clamp(v, -1.0f, 1.0f);
}

static float StickDeflection(const State& state, Axis axis) {
    return DeflectionOf(state.axes[std::to_underlying(axis)]);
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
    if (touch_mode) {
        // Touch mode: the sticks drive the touchpad, the controller stays still.
        const float still[3] = {0.0f, 0.0f, 0.0f};
        stick_motion_last[0] = stick_motion_last[1] = 0.0f;
        controller->UpdateAcceleration(constant_down_accel);
        controller->UpdateGyro(still);
        return;
    }
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

// Touch mode, for controllers without a touchpad: a finger touches the touchpad while a stick is
// pushed and follows it, so a stick movement is a swipe; with both sticks pushed, two fingers
// touch it, the left stick on the left half and the right stick on the right half. Cross clicks
// the touchpad (a finger at the centre if no stick is pushed).
static void EmulateTouchpad(GameController* controller) {
    using Libraries::Pad::OrbisPadButtonDataOffset;
    bool want[2] = {false, false};
    float position[2][2] = {{0.5f, 0.5f}, {0.5f, 0.5f}};
    const bool click = touch_mode && touch_click_held;
    if (touch_mode) {
        // The real stick positions: the game's sticks are centred in touch mode.
        const float rx = DeflectionOf(RawStickAxis(Axis::RightX)),
                    ry = DeflectionOf(RawStickAxis(Axis::RightY));
        const float lx = DeflectionOf(RawStickAxis(Axis::LeftX)),
                    ly = DeflectionOf(RawStickAxis(Axis::LeftY));
        const bool left_pushed = lx * lx + ly * ly > 0.09f;
        const bool right_pushed = rx * rx + ry * ry > 0.09f;
        if (left_pushed && right_pushed) {
            want[0] = want[1] = true;
            position[0][0] = 0.25f + lx * 0.22f;
            position[0][1] = 0.5f + ly * 0.45f;
            position[1][0] = 0.75f + rx * 0.22f;
            position[1][1] = 0.5f + ry * 0.45f;
        } else if (left_pushed || right_pushed) {
            want[0] = true;
            position[0][0] = 0.5f + (left_pushed ? lx : rx) * 0.45f;
            position[0][1] = 0.5f + (left_pushed ? ly : ry) * 0.45f;
        } else if (click) {
            want[0] = true;
        }
    }
    for (int i = 0; i < 2; ++i) {
        if (want[i]) {
            finger_position[i * 2] = position[i][0];
            finger_position[i * 2 + 1] = position[i][1];
            controller->SetTouchpadState(i, true, position[i][0], position[i][1]);
            finger_down[i] = true;
        } else if (finger_down[i]) {
            controller->SetTouchpadState(i, false, finger_position[i * 2],
                                         finger_position[i * 2 + 1]);
            finger_down[i] = false;
        }
    }
    if (click != touch_click_sent) {
        controller->Button(OrbisPadButtonDataOffset::TouchPad, click);
        touch_click_sent = click;
    }
}

Uint32 MousePolling(void* param, Uint32 id, Uint32 interval) {
    auto* controller = (GameController*)param;
    EmulateTouchpad(controller);
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
