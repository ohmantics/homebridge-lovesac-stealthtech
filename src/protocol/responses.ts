import { ResponseCode, PresetReadValue, SourceValue } from './constants';

export interface DeviceState {
  power: boolean;         // true=on, false=off
  volume: number;         // 0-36
  mute: boolean;          // true=muted
  source: SourceValue;    // 0-3
  preset: PresetReadValue; // 0-3
  quietMode: boolean;
  bass: number;           // 0-20
  treble: number;         // 0-20
  centerVolume: number;   // 0-30
  rearVolume: number;     // 0-30
  balance: number;        // 0-100
  subwooferConnected: boolean;
}

// Sentinel defaults ensure applyResponse always returns changed=true on the
// first state dump, so every field gets pushed to HomeKit via updateCharacteristic.
export function createDefaultState(): DeviceState {
  return {
    power: false,
    volume: -1,
    mute: false,
    source: -1 as SourceValue,
    preset: -1 as PresetReadValue,
    quietMode: false,
    bass: -1,
    treble: -1,
    centerVolume: -1,
    rearVolume: -1,
    balance: -1,
    subwooferConnected: false,
  };
}

export interface ParsedResponse {
  code: ResponseCode;
  value: number;
}

/**
 * Parse a BLE notification from the UpStream characteristic.
 * Returns the response code and value, or undefined if not a standard status response.
 *
 * Notifications have the format: CC 05/06 AA ... <code> <value>
 * The last 2 bytes are always code + value for standard status responses.
 * Version and OTA responses are ignored (handled separately if needed).
 */
export function parseNotification(data: Buffer): ParsedResponse | undefined {
  if (data.length < 4) {
    return undefined;
  }

  // Version responses (AA 01 03 ...) have trailing bytes that look like valid
  // status codes — e.g. MCU v1.71 ends with 01 47 which would be Volume=71.
  // Filter them here as defense-in-depth (also filtered in LovesacDevice).
  if (data.length >= 5 && data[2] === 0xAA && data[3] === 0x01 && data[4] === 0x03) {
    return undefined;
  }

  const code = data[data.length - 2];
  const value = data[data.length - 1];

  // Validate code is in our known range
  if (code < ResponseCode.Volume || code > ResponseCode.RearVolume) {
    return undefined;
  }

  return { code, value };
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Apply a parsed response to the device state. Returns true if state changed.
 * Out-of-range values are logged and ignored to guard against firmware bugs.
 */
export function applyResponse(state: DeviceState, response: ParsedResponse): boolean {
  const { code, value } = response;

  switch (code) {
    case ResponseCode.Volume:
      if (!inRange(value, 0, 36)) { return OUT_OF_RANGE; }
      if (state.volume === value) {return false;}
      state.volume = value;
      return true;

    case ResponseCode.CenterVolume:
      if (!inRange(value, 0, 30)) { return OUT_OF_RANGE; }
      if (state.centerVolume === value) {return false;}
      state.centerVolume = value;
      return true;

    case ResponseCode.Treble:
      if (!inRange(value, 0, 20)) { return OUT_OF_RANGE; }
      if (state.treble === value) {return false;}
      state.treble = value;
      return true;

    case ResponseCode.Bass:
      if (!inRange(value, 0, 20)) { return OUT_OF_RANGE; }
      if (state.bass === value) {return false;}
      state.bass = value;
      return true;

    case ResponseCode.Mute: {
      if (!inRange(value, 0, 1)) { return OUT_OF_RANGE; }
      const muted = value === 1;
      if (state.mute === muted) {return false;}
      state.mute = muted;
      return true;
    }

    case ResponseCode.QuietMode: {
      if (!inRange(value, 0, 1)) { return OUT_OF_RANGE; }
      const on = value === 1;
      if (state.quietMode === on) {return false;}
      state.quietMode = on;
      return true;
    }

    case ResponseCode.Balance:
      if (!inRange(value, 0, 100)) { return OUT_OF_RANGE; }
      if (state.balance === value) {return false;}
      state.balance = value;
      return true;

    case ResponseCode.Source:
      if (!inRange(value, 0, 3)) { return OUT_OF_RANGE; }
      if (state.source === value) {return false;}
      state.source = value as SourceValue;
      return true;

    case ResponseCode.Power: {
      if (!inRange(value, 0, 1)) { return OUT_OF_RANGE; }
      // INVERTED: 0x00 = ON, 0x01 = OFF
      const on = value === 0;
      if (state.power === on) {return false;}
      state.power = on;
      return true;
    }

    case ResponseCode.Preset:
      if (!inRange(value, 0, 3)) { return OUT_OF_RANGE; }
      if (state.preset === value) {return false;}
      state.preset = value as PresetReadValue;
      return true;

    case ResponseCode.Subwoofer: {
      if (!inRange(value, 0, 1)) { return OUT_OF_RANGE; }
      const connected = value === 1;
      if (state.subwooferConnected === connected) {return false;}
      state.subwooferConnected = connected;
      return true;
    }

    case ResponseCode.RearVolume:
      if (!inRange(value, 0, 30)) { return OUT_OF_RANGE; }
      if (state.rearVolume === value) {return false;}
      state.rearVolume = value;
      return true;

    default:
      return false;
  }
}

/** Sentinel: applyResponse returns this for out-of-range values so the caller can log a warning. */
export const OUT_OF_RANGE = 'out_of_range' as unknown as boolean;
