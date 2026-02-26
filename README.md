# homebridge-lovesac-stealthtech

Homebridge plugin for the [**Lovesac StealthTech Sound + Charge**](https://www.lovesac.com/stealthtech.html) system. Control your StealthTech soundbar from Apple HomeKit using Bluetooth.

## Features

- **Power on/off** from HomeKit and Siri
- **Input switching** — HDMI-ARC, Bluetooth, AUX, Optical
- **Volume control** — slider in the Home app, plus volume buttons in Control Center
- **Mute** toggle
- **Audio presets** — Movies, Music, TV, News as individual switches
- **Quiet mode** toggle
- **Auto-discovery** — finds your StealthTech device automatically
- **Background polling** — keeps HomeKit in sync when settings change elsewhere

## Requirements

- [Homebridge](https://homebridge.io) v1.8.0 or later
- Node.js 18, 20, or 22
- Bluetooth adapter (built-in on Mac; USB dongle on Linux/Raspberry Pi)
- macOS, Linux, or Raspberry Pi (any platform supported by [@stoprocent/noble](https://github.com/nicolo-ribaudo/noble))

## Installation

### Via Homebridge UI

Search for `homebridge-lovesac-stealthtech` in the Homebridge UI plugin tab.

### Via CLI

```sh
npm install -g homebridge-lovesac-stealthtech
```

## Pairing

This plugin uses the Television service, which Apple requires as an **external accessory**. It won't appear automatically — you need to add it by hand:

1. Open the **Home** app on your iPhone or iPad
2. Tap **+** → **Add Accessory**
3. Tap **More Options...**
4. Select **Lovesac StealthTech**
5. Enter the setup code from your Homebridge config (default: `031-45-154`)

> **Note:** Due to a known Apple bug, the input sources and preset switches may all show generic names (like "Input Source 2") when you first add the accessory. Just accept the defaults — the plugin will correct all the names automatically within a few moments.

## Using It

| Accessory | What it does |
|---|---|
| **Lovesac StealthTech** | Power on/off, input source selection |
| **Volume** (Fan or Lightbulb tile) | Volume slider (0–100%); on/off toggles mute |
| **Movies / Music / TV / News Mode** (Switch tiles) | Activate audio presets (one at a time) |
| **Quiet Mode** (Switch tile) | Toggle quiet mode |

### Control Center Remote

The Lovesac StealthTech appears in the Control Center remote (the Apple TV Remote widget). Select it from the device picker at the top, then:

- **Up/Down arrows** — Volume up/down
- **Play/Pause** — Toggle mute
- **Info (i)** — Cycle through presets

### Siri

Siri support for external accessories (which the Television service requires) is limited. Basic commands like "turn on" or "set volume" may conflict with other devices in the same room. Siri via HomePod may work better than from an iPhone. The Control Center remote is the most reliable way to control the StealthTech without opening the Home app.

## Important: Only One Bluetooth Connection at a Time

The StealthTech hardware allows **only one Bluetooth connection at a time**. This means the Homebridge plugin and the Lovesac mobile app can't be connected simultaneously.

The plugin handles this gracefully — it connects briefly to send commands or check the current state, then disconnects so the Bluetooth slot is free. With the default settings, the plugin is connected for roughly 5 seconds every 90 seconds, leaving the connection open for the Lovesac app about 94% of the time.

### Tips for using both HomeKit and the Lovesac app

- **Close the Lovesac app when you're done with it.** The app holds the connection open while it's in the foreground (and sometimes in the background). While the app is connected, HomeKit commands won't go through.
- **Force-quit the app** if HomeKit seems stuck. The app may be holding the connection in the background.
- You can **increase the poll interval** in the config if you use the Lovesac app frequently. A longer interval gives the app more time to connect, though HomeKit will be slower to pick up changes made outside of it.

### If HomeKit shows "Not Responding"

This usually means a Bluetooth command timed out. Common causes:

- The Lovesac mobile app has the connection open (close or force-quit it)
- The StealthTech device is too far from your Home Hub (Apple TV, HomePod, or iPad) — Bluetooth range is between the Hub and the soundbar, not your phone
- Another Bluetooth client is connected to the device

The plugin will automatically retry on the next poll or the next time you send a command.

## Configuration

The minimal config is all most people need — the plugin will find your StealthTech device automatically:

```json
{
  "platform": "LovesacStealthTech",
  "devices": [
    {
      "name": "Lovesac StealthTech"
    }
  ]
}
```

### All Options

```json
{
  "platform": "LovesacStealthTech",
  "devices": [
    {
      "name": "Lovesac StealthTech",
      "address": "",
      "idleTimeout": 60,
      "pollInterval": 90,
      "volumeControl": "fan",
      "volumeStep": 2,
      "presets": {
        "movies": true,
        "music": true,
        "tv": true,
        "news": true
      }
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `name` | `"Lovesac StealthTech"` | Name of the accessory in HomeKit. |
| `address` | *(auto-discover)* | BLE address. Leave blank for auto-discovery. Use `npx homebridge-lovesac-stealthtech scan` to find the address if auto-discovery fails. |
| `idleTimeout` | `60` | Seconds to wait after the last command before disconnecting. Range: 10–600. |
| `pollInterval` | `90` | Seconds between background state checks. Longer intervals make it easier to use the Lovesac app alongside HomeKit; shorter intervals keep HomeKit more up to date. Set to `0` to disable polling entirely. Range: 0–600. |
| `volumeControl` | `"fan"` | How to expose the volume slider: `"fan"`, `"lightbulb"`, or `"none"`. Fan is recommended — Siri can "set Volume to 50%". |
| `volumeStep` | `2` | Volume increment for Control Center remote up/down buttons. Range: 1–5. |
| `presets` | all enabled | Show or hide individual preset switches (movies, music, tv, news). |

> **Note:** Keep `pollInterval` larger than `idleTimeout` so the plugin actually disconnects between polls.

### Scanner

If auto-discovery doesn't find your device (e.g., you have multiple StealthTech systems), you can scan manually:

```sh
npx homebridge-lovesac-stealthtech scan
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and build instructions.

## License

[MIT](LICENSE)
