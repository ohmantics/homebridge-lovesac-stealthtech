import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-lovesac-stealthtech';
export const PLATFORM_NAME = 'LovesacStealthTech';

// BLE GATT UUIDs — custom service encodes "excelpoint.com" in ASCII
export const SOFA_SERVICE_UUID = '65786365-6c70-6f69-6e74-2e636f6d0000';

// Noble expects UUIDs without dashes, lowercase
export const SOFA_SERVICE_UUID_SHORT = '657863656c706f696e742e636f6d0000';

export const CharUUID = {
  UpStream:      '657863656c706f696e742e636f6d0001',
  DeviceInfo:    '657863656c706f696e742e636f6d0002',
  EqControl:     '657863656c706f696e742e636f6d0003',
  AudioPath:     '657863656c706f696e742e636f6d0004',
  PlayerControl: '657863656c706f696e742e636f6d0005',
  SystemLayout:  '657863656c706f696e742e636f6d0006',
  Source:        '657863656c706f696e742e636f6d0007',
  Covering:      '657863656c706f696e742e636f6d0008',
  UserSetting:   '657863656c706f696e742e636f6d0009',
  OTA:           '657863656c706f696e742e636f6d000a',
} as const;

export const MAX_VOLUME = 36;
export const BLE_SCAN_TIMEOUT = 15000;

// BLE operation timeouts (milliseconds)
export const BLE_CONNECT_TIMEOUT = 30_000;
export const BLE_WRITE_TIMEOUT = 10_000;
export const BLE_DISCONNECT_TIMEOUT = 10_000;
export const BLE_DISCOVER_TIMEOUT = 15_000;

// Delay between scan retry attempts (milliseconds)
export const BLE_SCAN_RETRY_DELAY = 2000;

// Consecutive poll failures before marking device unreachable
export const UNREACHABLE_THRESHOLD = 6;

/**
 * Race a promise against a timeout. Rejects with a descriptive error if
 * the timeout fires first. The underlying promise is NOT cancelled — the
 * caller must handle cleanup.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LovesacDeviceConfig {
  name: string;
  address: string;
  idleTimeout: number;
  pollInterval: number;
  volumeControl: 'fan' | 'lightbulb' | 'none';
  volumeStep: number;
  presets: {
    movies: boolean;
    music: boolean;
    tv: boolean;
    news: boolean;
  };
}

export interface LovesacPlatformConfig extends PlatformConfig {
  devices?: Partial<LovesacDeviceConfig>[];
}

export function resolveDeviceConfig(raw: Partial<LovesacDeviceConfig>): LovesacDeviceConfig {
  return {
    name: raw.name ?? 'Lovesac StealthTech',
    address: raw.address ?? '',
    idleTimeout: raw.idleTimeout ?? 60,
    pollInterval: raw.pollInterval ?? 90,
    volumeControl: raw.volumeControl ?? 'fan',
    volumeStep: raw.volumeStep ?? 2,
    presets: {
      movies: raw.presets?.movies ?? true,
      music: raw.presets?.music ?? true,
      tv: raw.presets?.tv ?? true,
      news: raw.presets?.news ?? true,
    },
  };
}
