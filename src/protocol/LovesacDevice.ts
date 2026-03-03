import type { Logger } from 'homebridge';
import { BleConnectionManager } from '../ble/BleConnectionManager';
import { DeviceState, createDefaultState, parseNotification, applyResponse, OUT_OF_RANGE, resetState } from './responses';
import { ResponseCode, PresetWriteValue, PresetReadValue, SourceValue, presetWriteToRead, PRESET_NAMES, SOURCE_NAMES } from './constants';
import * as commands from './commands';
import { MAX_VOLUME, errorMessage, UNREACHABLE_THRESHOLD } from '../settings';

const CODE_NAMES: Record<number, string> = {
  [ResponseCode.Volume]: 'Volume',
  [ResponseCode.CenterVolume]: 'Center',
  [ResponseCode.Treble]: 'Treble',
  [ResponseCode.Bass]: 'Bass',
  [ResponseCode.Mute]: 'Mute',
  [ResponseCode.QuietMode]: 'Quiet Mode',
  [ResponseCode.Balance]: 'Balance',
  [ResponseCode.Layout]: 'Layout',
  [ResponseCode.Source]: 'Source',
  [ResponseCode.Power]: 'Power',
  [ResponseCode.Preset]: 'Preset',
  [ResponseCode.Covering]: 'Covering',
  [ResponseCode.ArmType]: 'Arm Type',
  [ResponseCode.Subwoofer]: 'Subwoofer',
  [ResponseCode.RearVolume]: 'Rear',
};

function formatStateValue(code: ResponseCode, value: number): string {
  switch (code) {
    case ResponseCode.Power:
      return value === 0 ? 'On' : 'Off';
    case ResponseCode.Mute:
    case ResponseCode.QuietMode:
    case ResponseCode.Subwoofer:
      return value === 1 ? 'Yes' : 'No';
    case ResponseCode.Source:
      return SOURCE_NAMES[value as SourceValue] ?? String(value);
    case ResponseCode.Preset:
      return PRESET_NAMES[value as PresetReadValue] ?? String(value);
    default:
      return String(value);
  }
}

export type StateChangeListener = (code: ResponseCode, value: number) => void;
export type UnreachableListener = () => void;

export class LovesacDevice {
  readonly state: DeviceState;
  private stateListeners: StateChangeListener[] = [];
  private unreachableListeners: UnreachableListener[] = [];
  private stateInitialized = false;
  private consecutiveFailures = 0;
  private reachable = true;
  mcuVersion = '';
  private versionListeners: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly connectionManager: BleConnectionManager,
    private readonly log: Logger,
  ) {
    this.state = createDefaultState();

    this.connectionManager.setNotificationHandler((data) => {
      this.handleNotification(data);
    });
  }

  onStateChange(listener: StateChangeListener): void {
    this.stateListeners.push(listener);
  }

  onUnreachable(listener: UnreachableListener): void {
    this.unreachableListeners.push(listener);
  }

  isStateInitialized(): boolean {
    return this.stateInitialized;
  }

  onVersionResolved(callback: () => void): void {
    this.versionListeners.push(callback);
  }

  async requestStateRefresh(): Promise<void> {
    await this.connectionManager.enqueue(commands.requestDeviceInfo());
    await this.connectionManager.enqueue(commands.requestVersionInfo());
  }

  startPolling(intervalSeconds: number): void {
    if (intervalSeconds <= 0) {
      this.log.info('Background polling disabled');
      return;
    }
    this.log.info('Starting background poll every %ds', intervalSeconds);

    const poll = () => {
      this.requestStateRefresh()
        .then(() => this.onPollSuccess())
        .catch(err => this.onPollFailure(errorMessage(err)));
    };

    // Immediate initial fetch — onReconnect will also fire on first connect
    poll();
    this.pollTimer = setInterval(poll, intervalSeconds * 1000);
  }

  private onPollSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.log.info('Poll succeeded after %d consecutive failure(s)', this.consecutiveFailures);
    }
    this.consecutiveFailures = 0;
    this.reachable = true;
  }

  private onPollFailure(message: string): void {
    this.consecutiveFailures++;
    this.log.warn('Background poll failed (%d/%d): %s',
      this.consecutiveFailures, UNREACHABLE_THRESHOLD, message);

    if (this.consecutiveFailures >= UNREACHABLE_THRESHOLD && this.reachable) {
      this.markUnreachable();
    }
  }

  private markUnreachable(): void {
    this.reachable = false;
    this.log.warn('Device unreachable after %d consecutive poll failures — resetting cached state',
      this.consecutiveFailures);

    // Reset state to sentinels so next successful connection triggers full re-sync
    resetState(this.state);
    this.stateInitialized = false;

    for (const listener of this.unreachableListeners) {
      try {
        listener();
      } catch (err) {
        this.log.error('Unreachable listener error: %s', errorMessage(err));
      }
    }
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getResolvedAddress(): string {
    return this.connectionManager.getResolvedAddress();
  }

  // --- Power ---

  async setPower(on: boolean): Promise<void> {
    this.log.info('Setting power %s', on ? 'ON' : 'OFF');
    await this.connectionManager.enqueue(commands.setPower(on));
  }

  // --- Volume ---

  async setVolume(volume: number): Promise<void> {
    this.log.info('Setting volume to %d', volume);
    await this.connectionManager.enqueue(commands.setVolume(volume));
  }

  volumeToPercent(volume: number): number {
    return Math.round((volume / MAX_VOLUME) * 100);
  }

  percentToVolume(percent: number): number {
    return Math.round((percent / 100) * MAX_VOLUME);
  }

  async volumeUp(step: number): Promise<void> {
    const newVol = Math.min(MAX_VOLUME, this.state.volume + step);
    await this.setVolume(newVol);
  }

  async volumeDown(step: number): Promise<void> {
    const newVol = Math.max(0, this.state.volume - step);
    await this.setVolume(newVol);
  }

  // --- Mute ---

  async setMute(muted: boolean): Promise<void> {
    this.log.info('Setting mute %s', muted ? 'ON' : 'OFF');
    await this.connectionManager.enqueue(commands.setMute(muted));
  }

  // --- Quiet Mode ---

  async setQuietMode(on: boolean): Promise<void> {
    this.log.info('Setting quiet mode %s', on ? 'ON' : 'OFF');
    await this.connectionManager.enqueue(commands.setQuietMode(on));
  }

  // --- Source ---

  async setSource(source: SourceValue): Promise<void> {
    this.log.info('Setting source to %d', source);
    await this.connectionManager.enqueue(commands.setSource(source));
  }

  // --- Preset ---

  async setPreset(preset: PresetWriteValue): Promise<void> {
    this.log.info('Setting preset to %d', preset);
    // Optimistically update cached state so switches respond immediately
    const readVal = presetWriteToRead(preset);
    if (readVal !== undefined) {
      this.state.preset = readVal;
    }
    await this.connectionManager.enqueue(commands.setPreset(preset));
  }

  isPresetActive(readValue: PresetReadValue): boolean {
    return this.state.preset === readValue;
  }

  // --- Internal ---

  private handleNotification(data: Buffer): void {
    // Check for version response: CC 05/06 AA 01 03 <type> <major> <minor>
    if (data.length >= 8 && data[2] === 0xAA && data[3] === 0x01 && data[4] === 0x03) {
      const type = data[5]; // 01=MCU, 02=DSP, 03=EQ
      const major = data[6];
      const minor = data[7];
      const ver = `${major}.${minor}`;
      if (type === 0x01 && !this.mcuVersion) {
        this.mcuVersion = ver;
        this.log.info('Firmware version: %s', ver);
        for (const listener of this.versionListeners) {
          listener();
        }
      }
      return;
    }

    const parsed = parseNotification(data);
    if (!parsed) {
      this.log.debug('Ignoring non-status notification: %s', data.toString('hex'));
      return;
    }

    const changed = applyResponse(this.state, parsed);
    if (changed === OUT_OF_RANGE) {
      this.log.warn('Out-of-range value for %s: %d (ignored)',
        CODE_NAMES[parsed.code] ?? `0x${parsed.code.toString(16)}`, parsed.value);
      return;
    }

    this.stateInitialized = true;

    // Any valid notification means the device is reachable
    if (this.consecutiveFailures > 0 || !this.reachable) {
      this.log.info('Device reachable again after %d poll failure(s)', this.consecutiveFailures);
      this.consecutiveFailures = 0;
      this.reachable = true;
    }

    if (changed) {
      this.log.debug('State: %s = %s', CODE_NAMES[parsed.code] ?? `0x${parsed.code.toString(16)}`, formatStateValue(parsed.code, parsed.value));
      for (const listener of this.stateListeners) {
        try {
          listener(parsed.code, parsed.value);
        } catch (err) {
          this.log.error('State listener error: %s', errorMessage(err));
        }
      }
    }
  }
}
