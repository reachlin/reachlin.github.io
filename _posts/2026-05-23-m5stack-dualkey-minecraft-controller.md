---
title: turning an M5Stack Chain DualKey into a wireless Minecraft controller
---

The M5Stack Chain DualKey is a small ESP32-S3 device with two mechanical keys and two HY2.0-4P expansion ports, designed for daisy-chaining peripheral modules over a serial bus. With two Chain Joystick modules plugged in — one on each end — it looked like an obvious candidate for a wireless Minecraft controller: left joystick for WASD movement, right joystick for mouse look, the two keys for jump and left click. Getting it to actually work over BLE took longer than expected.

## The BLE stack problem

The first attempt used NimBLE (`h2zero/NimBLE-Arduino`), which seemed reasonable since NimBLE is the more modern ESP32 BLE stack. It connected and bonded, but macOS never subscribed to the HID input notifications — keyboard and mouse input never arrived.

The root cause was that NimBLE's `BLEHIDDevice::inputReport()` adds a `READ_ENC` security flag to input report characteristics. macOS requires HID input reports to be subscribable without encryption for standard keyboard/mouse use. The flag blocks the subscription.

Patching the NimBLE library to remove `READ_ENC` helped partway, but bonding behaviour was still unreliable. The fix that actually worked: switch to Bluedroid — the ESP32's built-in BLE stack exposed via `BLEDevice.h` and `BLEHIDDevice.h`. This is what M5Stack uses in their own official examples, and it just works with macOS out of the box.

```cpp
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEHIDDevice.h>
#include <HIDTypes.h>

BLEDevice::init("DualKey MC");
BLEServer* srv = BLEDevice::createServer();
hid = new BLEHIDDevice(srv);
hid->reportMap((uint8_t*)kHidDesc, sizeof(kHidDesc));
inputKb    = hid->inputReport(1);
inputMouse = hid->inputReport(2);
hid->startServices();

BLESecurity* sec = new BLESecurity();
sec->setAuthenticationMode(ESP_LE_AUTH_BOND);
```

The HID descriptor combines a keyboard (report ID 1) and mouse (report ID 2) in a single device. macOS sees it as a combined keyboard/mouse and binds both report handlers immediately after pairing.

## Chain Bus device IDs are dynamic

The Chain Joystick modules connect to the DualKey via the Chain Bus — a UART-based daisy-chain protocol at 115200bps. The first attempt hardcoded device ID 0:

```cpp
leftChain.getJoystickMappedInt8Value(0, &lx, &ly);
```

This consistently returned status 0 (CHAIN_OK) but produced zero values. The actual issue: Chain Bus assigns device IDs dynamically at enumeration time, starting from 1. ID 0 doesn't correspond to any real device.

The fix, taken from the official M5DualKey-UserDemo firmware, is to discover devices at startup:

```cpp
static uint8_t discoverJoystick(Chain& chain, const char* label) {
    if (!chain.isDeviceConnected()) return 1;
    uint16_t count = 0;
    if (chain.getDeviceNum(&count) != CHAIN_OK || count == 0) return 1;
    device_list_t list;
    list.count   = count;
    list.devices = (device_info_t*)malloc(sizeof(device_info_t) * count);
    uint8_t found = 1;
    if (chain.getDeviceList(&list)) {
        for (int i = 0; i < (int)count; i++) {
            if (list.devices[i].device_type == CHAIN_JOYSTICK_TYPE_CODE)
                found = list.devices[i].id;
        }
    }
    free(list.devices);
    return found;
}
```

Both joysticks enumerate at ID 1 (one per chain port), and reading with the discovered ID gives proper -127 to +127 values.

## Axis corrections

The raw joystick values needed two corrections:

**A/D reversed** — pushing left triggered D, pushing right triggered A. The joystick X axis was inverted relative to the WASD convention. Fix: swap the comparison direction.

```cpp
// before
setKey(KEY_A, rx < -DEADZONE);
setKey(KEY_D, rx >  DEADZONE);

// after
setKey(KEY_A, rx >  DEADZONE);
setKey(KEY_D, rx < -DEADZONE);
```

**Mouse look X reversed** — moving the camera-look joystick left moved the view right. The joystick X axis on the left chain port is physically mirrored. The official firmware handles this with a per-bus `xy_move_reverse` flag; we just negate inline:

```cpp
mouseReport[1] = (uint8_t)toMouseDelta(lx);   // was -lx, then lx depending on which chain
mouseReport[2] = (uint8_t)toMouseDelta(ly);
```

The Y axis (forward/back for WASD, up/down for mouse look) needed no correction on either joystick.

## Final mapping

```
G5/G6 port  (Key1 side) → mouse look  (X corrected)
G47/G48 port (Key2 side) → WASD       (A/D corrected)
G0  KEY_1 (farther from lanyard) → space (jump)
G17 KEY_2 (closer to lanyard)   → left click (mine/attack)
```

The jump key is on the far side from the WASD joystick so your thumb can reach it without repositioning.

## Lessons

- **Use Bluedroid for BLE HID on ESP32, not NimBLE** — NimBLE's `READ_ENC` flag on input reports breaks macOS HID subscription. Bluedroid (`BLEDevice.h`) is what M5Stack uses and it pairs cleanly.
- **Chain Bus device IDs start at 1, not 0** — ID 0 silently returns zeros. Always discover with `getDeviceNum()` + `getDeviceList()` rather than hardcoding.
- **Read the vendor's own firmware before debugging** — the official `M5DualKey-UserDemo` repo had both the correct BLE stack choice and the correct device discovery pattern. Finding it early would have saved several debugging cycles.
