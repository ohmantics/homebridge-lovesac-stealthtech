import { CharUUID } from '../settings';
import { PresetWriteValue, SourceValue } from './constants';

export interface BleCommand {
  characteristicUuid: string;
  data: Buffer;
}

// Format A: AA <cmdId> <subCmdId> 01 <value>
function formatA(cmdId: number, subCmdId: number, value: number): Buffer {
  return Buffer.from([0xAA, cmdId, subCmdId, 0x01, value]);
}

// Format B: AA <cmdId> <value> 00
function formatB(cmdId: number, value: number): Buffer {
  return Buffer.from([0xAA, cmdId, value, 0x00]);
}

function eqCommand(subCmdId: number, value: number): BleCommand {
  return { characteristicUuid: CharUUID.EqControl, data: formatA(0x03, subCmdId, value) };
}

// Volume: 0-36
export function setVolume(volume: number): BleCommand {
  return eqCommand(0x02, Math.max(0, Math.min(36, volume)));
}

// Bass: 0-20
export function setBass(bass: number): BleCommand {
  return eqCommand(0x01, Math.max(0, Math.min(20, bass)));
}

// Treble: 0-20
export function setTreble(treble: number): BleCommand {
  return eqCommand(0x00, Math.max(0, Math.min(20, treble)));
}

// Center volume: 0-30
export function setCenterVolume(center: number): BleCommand {
  return eqCommand(0x03, Math.max(0, Math.min(30, center)));
}

// Rear volume: 0-30
export function setRearVolume(rear: number): BleCommand {
  return eqCommand(0x0A, Math.max(0, Math.min(30, rear)));
}

// Mute: true=muted, false=unmuted
export function setMute(muted: boolean): BleCommand {
  return eqCommand(0x09, muted ? 1 : 0);
}

// Quiet mode (night mode): true=on, false=off
export function setQuietMode(on: boolean): BleCommand {
  return eqCommand(0x04, on ? 1 : 0);
}

// Balance: 0-100 (50=center)
export function setBalance(balance: number): BleCommand {
  return {
    characteristicUuid: CharUUID.AudioPath,
    data: formatA(0x04, 0x00, Math.max(0, Math.min(100, balance))),
  };
}

// Power: true=on, false=off (standby)
export function setPower(on: boolean): BleCommand {
  return {
    characteristicUuid: CharUUID.AudioPath,
    data: formatA(0x04, 0x01, on ? 1 : 0),
  };
}

// Preset (sound mode)
export function setPreset(preset: PresetWriteValue): BleCommand {
  return {
    characteristicUuid: CharUUID.EqControl,
    data: formatB(0x03, preset),
  };
}

// Input source
export function setSource(source: SourceValue): BleCommand {
  return {
    characteristicUuid: CharUUID.Source,
    data: formatB(0x07, source),
  };
}

// Request full device state dump
export function requestDeviceInfo(): BleCommand {
  return {
    characteristicUuid: CharUUID.DeviceInfo,
    data: formatB(0x01, 0x01),
  };
}

// Request version info (AA 01 01 01 — last byte 01 distinguishes from state request)
export function requestVersionInfo(): BleCommand {
  return {
    characteristicUuid: CharUUID.DeviceInfo,
    data: Buffer.from([0xAA, 0x01, 0x01, 0x01]),
  };
}

// Play/Pause (Bluetooth source)
export function setPlayPause(value: number): BleCommand {
  return {
    characteristicUuid: CharUUID.PlayerControl,
    data: formatA(0x05, 0x00, value),
  };
}

// Skip forward/backward (Bluetooth source)
export function setSkip(value: number): BleCommand {
  return {
    characteristicUuid: CharUUID.PlayerControl,
    data: formatA(0x05, 0x01, value),
  };
}
