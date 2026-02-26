import type {
  PlatformAccessory,
  Service,
  Characteristic,
  CharacteristicValue,
} from 'homebridge';
import { HapStatusError, HAPStatus } from 'hap-nodejs';
import type { LovesacPlatform } from './platform';
import type { LovesacDeviceConfig } from './settings';
import { errorMessage } from './settings';
import { LovesacDevice } from './protocol/LovesacDevice';
import {
  ResponseCode,
  PresetWriteValue,
  PresetReadValue,
  SourceValue,
  presetReadToWrite,
} from './protocol/constants';

interface PresetSwitch {
  service: Service;
  presetRead: PresetReadValue;
  presetWrite: PresetWriteValue;
}

export class LovesacAccessory {
  private readonly tvService: Service;
  private readonly speakerService: Service;
  private volumeService: Service | null = null;
  private readonly inputSources: Service[] = [];
  private readonly presetSwitches: PresetSwitch[] = [];
  private quietModeService: Service | null = null;

  private volumeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly Characteristic: typeof Characteristic;

  constructor(
    private readonly platform: LovesacPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: LovesacDeviceConfig,
    private readonly device: LovesacDevice,
  ) {
    this.Characteristic = this.platform.api.hap.Characteristic;
    const Service = this.platform.api.hap.Service;

    // --- Accessory Information ---
    const infoService = this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(this.Characteristic.Manufacturer, 'Lovesac')
      .setCharacteristic(this.Characteristic.Model, 'StealthTech Sound + Charge')
      .setCharacteristic(this.Characteristic.SerialNumber, this.config.address || 'Auto')
      .setCharacteristic(this.Characteristic.FirmwareRevision, '0.0');

    // Update serial number and firmware after BLE connects
    this.device.onVersionResolved(() => {
      const addr = this.device.getResolvedAddress();
      if (addr && addr !== this.config.address) {
        infoService.updateCharacteristic(this.Characteristic.SerialNumber, addr);
      }
      if (this.device.mcuVersion) {
        infoService.updateCharacteristic(this.Characteristic.FirmwareRevision, this.device.mcuVersion);
      }
    });

    // --- Television (primary) ---
    // tvOS 18 workaround: pass name as displayName, use setValue() for ConfiguredName,
    // and add onGet/onSet to reject bogus "TV" renames from Apple TV Home Hub.
    // See: https://github.com/homebridge/homebridge/issues/3703
    this.tvService = this.accessory.addService(Service.Television, this.config.name, 'television');
    this.tvService.setPrimaryService(true);
    this.tvService.setCharacteristic(this.Characteristic.SleepDiscoveryMode,
      this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // Use setValue() for ConfiguredName and Name to ensure proper HAP notification
    this.tvService.getCharacteristic(this.Characteristic.ConfiguredName).setValue(this.config.name);
    this.tvService.getCharacteristic(this.Characteristic.Name).setValue(this.config.name);
    this.platform.log.info('TV ConfiguredName set to "%s", Name set to "%s"',
      this.tvService.getCharacteristic(this.Characteristic.ConfiguredName).value,
      this.tvService.getCharacteristic(this.Characteristic.Name).value);

    this.setupConfiguredNameHandler(this.tvService, this.config.name);

    // Active (power)
    this.tvService.getCharacteristic(this.Characteristic.Active)
      .onSet(this.setPower.bind(this));

    // ActiveIdentifier (input source)
    this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier)
      .onSet(this.setActiveIdentifier.bind(this));

    // Remote key
    this.tvService.getCharacteristic(this.Characteristic.RemoteKey)
      .onSet(this.setRemoteKey.bind(this));

    // --- Input Sources ---
    const InputSourceType = this.Characteristic.InputSourceType;
    const inputConfigs: { name: string; source: SourceValue; identifier: number; type: number }[] = [
      { name: 'HDMI-ARC', source: SourceValue.HDMI, identifier: 1, type: InputSourceType.HDMI },
      { name: 'Bluetooth', source: SourceValue.Bluetooth, identifier: 2, type: InputSourceType.OTHER },
      { name: 'AUX', source: SourceValue.AUX, identifier: 3, type: InputSourceType.OTHER },
      { name: 'Optical', source: SourceValue.Optical, identifier: 4, type: InputSourceType.OTHER },
    ];

    for (const input of inputConfigs) {
      // Pass name as displayName for tvOS 18 compatibility
      const inputService = this.accessory.addService(
        Service.InputSource,
        input.name,
        `input-${input.identifier}`,
      );

      // Set Identifier first — critical for HomeKit
      inputService.setCharacteristic(this.Characteristic.Identifier, input.identifier);

      // Use setValue() for ConfiguredName and Name to ensure proper HAP notification
      inputService.getCharacteristic(this.Characteristic.ConfiguredName).setValue(input.name);
      inputService.getCharacteristic(this.Characteristic.Name).setValue(input.name);
      this.platform.log.info('Input[%d] ConfiguredName="%s", Name="%s"', input.identifier,
        inputService.getCharacteristic(this.Characteristic.ConfiguredName).value,
        inputService.getCharacteristic(this.Characteristic.Name).value);

      inputService
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, input.type)
        .setCharacteristic(this.Characteristic.CurrentVisibilityState,
          this.Characteristic.CurrentVisibilityState.SHOWN)
        .setCharacteristic(this.Characteristic.TargetVisibilityState,
          this.Characteristic.TargetVisibilityState.SHOWN);

      this.setupConfiguredNameHandler(inputService, input.name);

      this.tvService.addLinkedService(inputService);
      this.inputSources.push(inputService);
    }

    // --- Television Speaker ---
    this.speakerService = this.accessory.addService(Service.TelevisionSpeaker, 'Speaker', 'speaker');
    this.speakerService
      .setCharacteristic(this.Characteristic.VolumeControlType,
        this.Characteristic.VolumeControlType.RELATIVE_WITH_CURRENT);

    this.speakerService.getCharacteristic(this.Characteristic.Mute)
      .onSet(this.setMute.bind(this));

    this.speakerService.getCharacteristic(this.Characteristic.VolumeSelector)
      .onSet(this.setVolumeSelector.bind(this));

    this.tvService.addLinkedService(this.speakerService);

    // --- Volume Proxy (Fan or Lightbulb) ---
    if (this.config.volumeControl === 'fan' || this.config.volumeControl === 'lightbulb') {
      const isFan = this.config.volumeControl === 'fan';
      const svcType = isFan ? Service.Fan : Service.Lightbulb;
      const subtype = isFan ? 'volume-fan' : 'volume-lightbulb';
      this.volumeService = this.accessory.addService(svcType, 'Volume', subtype);
      this.volumeService.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      this.volumeService.getCharacteristic(this.Characteristic.ConfiguredName).setValue('Volume');
      this.setupConfiguredNameHandler(this.volumeService, 'Volume');
      this.volumeService.getCharacteristic(this.Characteristic.On)
        .onSet(this.setVolumeOn.bind(this));
      const levelChar = isFan ? this.Characteristic.RotationSpeed : this.Characteristic.Brightness;
      this.volumeService.getCharacteristic(levelChar)
        .onSet(this.setVolumePercent.bind(this));
    }

    // --- Preset Switches ---
    const presetConfigs: { key: keyof typeof config.presets; name: string; readVal: PresetReadValue; writeVal: PresetWriteValue }[] = [
      { key: 'movies', name: 'Movies Mode', readVal: PresetReadValue.Movies, writeVal: PresetWriteValue.Movies },
      { key: 'music', name: 'Music Mode', readVal: PresetReadValue.Music, writeVal: PresetWriteValue.Music },
      { key: 'tv', name: 'TV Mode', readVal: PresetReadValue.TV, writeVal: PresetWriteValue.TV },
      { key: 'news', name: 'News Mode', readVal: PresetReadValue.News, writeVal: PresetWriteValue.News },
    ];

    for (const preset of presetConfigs) {
      if (!this.config.presets[preset.key]) {
        continue;
      }

      const switchService = this.accessory.addService(
        Service.Switch,
        preset.name,
        `preset-${preset.key}`,
      );
      switchService.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      switchService.getCharacteristic(this.Characteristic.ConfiguredName).setValue(preset.name);
      this.setupConfiguredNameHandler(switchService, preset.name);

      switchService.getCharacteristic(this.Characteristic.On)
        .onSet(async (value: CharacteristicValue) => {
          if (!value) {
            return; // Turning off is a no-op — can't unselect a preset
          }
          try {
            await this.device.setPreset(preset.writeVal);
            this.updatePresetSwitches(preset.readVal);
          } catch (err) {
            this.platform.log.error('setPreset failed: %s', errorMessage(err));
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
        });

      this.presetSwitches.push({
        service: switchService,
        presetRead: preset.readVal,
        presetWrite: preset.writeVal,
      });
    }

    // --- Quiet Mode ---
    this.quietModeService = this.accessory.addService(Service.Switch, 'Quiet Mode', 'quiet-mode');
    this.quietModeService.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    this.quietModeService.getCharacteristic(this.Characteristic.ConfiguredName).setValue('Quiet Mode');
    this.setupConfiguredNameHandler(this.quietModeService, 'Quiet Mode');
    this.quietModeService.getCharacteristic(this.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        try {
          await this.device.setQuietMode(value as boolean);
        } catch (err) {
          this.platform.log.error('setQuietMode failed: %s', errorMessage(err));
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    // --- Listen for device state changes ---
    this.device.onStateChange(this.handleStateChange.bind(this));

    // Start background polling (also triggers initial state fetch via onReconnect)
    this.device.startPolling(this.config.pollInterval);
  }

  // --- Power ---

  private async setPower(value: CharacteristicValue): Promise<void> {
    try {
      const on = value === this.Characteristic.Active.ACTIVE;
      await this.device.setPower(on);
    } catch (err) {
      this.platform.log.error('setPower failed: %s', errorMessage(err));
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- Input Source ---
  // HomeKit Identifier 1-4 maps to SourceValue 0-3

  private async setActiveIdentifier(value: CharacteristicValue): Promise<void> {
    try {
      const source = (value as number) - 1;
      await this.device.setSource(source as SourceValue);
    } catch (err) {
      this.platform.log.error('setActiveIdentifier failed: %s', errorMessage(err));
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- Remote Key ---

  private async setRemoteKey(value: CharacteristicValue): Promise<void> {
    try {
      const RemoteKey = this.Characteristic.RemoteKey;
      switch (value) {
        case RemoteKey.ARROW_UP:
          await this.device.volumeUp(this.config.volumeStep);
          break;
        case RemoteKey.ARROW_DOWN:
          await this.device.volumeDown(this.config.volumeStep);
          break;
        case RemoteKey.SELECT:
        case RemoteKey.PLAY_PAUSE:
          await this.device.setMute(!this.device.state.mute);
          break;
        case RemoteKey.INFORMATION:
          await this.cyclePreset();
          break;
      }
    } catch (err) {
      this.platform.log.error('setRemoteKey failed: %s', errorMessage(err));
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- Mute ---

  private async setMute(value: CharacteristicValue): Promise<void> {
    try {
      await this.device.setMute(value as boolean);
    } catch (err) {
      this.platform.log.error('setMute failed: %s', errorMessage(err));
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- Volume Selector (up/down buttons in Control Center remote) ---

  private async setVolumeSelector(value: CharacteristicValue): Promise<void> {
    try {
      if (value === this.Characteristic.VolumeSelector.INCREMENT) {
        await this.device.volumeUp(this.config.volumeStep);
      } else {
        await this.device.volumeDown(this.config.volumeStep);
      }
    } catch (err) {
      this.platform.log.error('setVolumeSelector failed: %s', errorMessage(err));
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- Volume Proxy (Fan/Lightbulb) ---

  private async setVolumeOn(value: CharacteristicValue): Promise<void> {
    if (!value) {
      await this.device.setMute(true);
    } else if (this.device.state.mute) {
      await this.device.setMute(false);
    }
  }

  private setVolumePercent(value: CharacteristicValue): void {
    const percent = value as number;

    // Debounce: HomeKit slider sends many rapid updates
    if (this.volumeDebounceTimer) {
      clearTimeout(this.volumeDebounceTimer);
    }
    this.volumeDebounceTimer = setTimeout(() => {
      const volume = this.device.percentToVolume(percent);
      this.device.setVolume(volume).catch((err) => {
        this.platform.log.error('Failed to set volume: %s', errorMessage(err));
      });
    }, 100);
  }

  // --- Helpers ---

  /**
   * Workaround for tvOS 18+ Home Hub bug (homebridge/homebridge#3703).
   * The Home Hub forcibly renames services to localized generic defaults
   * during setup. We reject all renames and always push back the name
   * from the Homebridge config — language-independent.
   */
  private setupConfiguredNameHandler(service: Service, originalName: string): void {
    const subtype = service.subtype ?? '(primary)';

    service.getCharacteristic(this.Characteristic.ConfiguredName)
      .onGet(() => {
        this.platform.log.debug('[%s] ConfiguredName GET → "%s"', subtype, originalName);
        return originalName;
      })
      .onSet((value: CharacteristicValue) => {
        const newName = value as string;
        if (newName === originalName) {
          this.platform.log.debug('[%s] ConfiguredName SET "%s" (unchanged)', subtype, newName);
          return;
        }
        this.platform.log.info('[%s] Rejecting rename "%s" → pushing back "%s"', subtype, newName, originalName);
        setTimeout(() => {
          service.getCharacteristic(this.Characteristic.ConfiguredName).updateValue(originalName);
        }, 500);
      });
  }

  private async cyclePreset(): Promise<void> {
    const enabledPresets = this.presetSwitches.map((s) => s.presetRead);
    if (enabledPresets.length === 0) {
      return;
    }
    const currentIndex = enabledPresets.indexOf(this.device.state.preset);
    const nextIndex = (currentIndex + 1) % enabledPresets.length;
    const nextWrite = presetReadToWrite(enabledPresets[nextIndex]);
    await this.device.setPreset(nextWrite);
    this.updatePresetSwitches(enabledPresets[nextIndex]);
  }

  private updatePresetSwitches(activePreset: PresetReadValue): void {
    for (const ps of this.presetSwitches) {
      ps.service.getCharacteristic(this.Characteristic.On)
        .updateValue(ps.presetRead === activePreset);
    }
  }

  // --- State Change Handler ---

  private handleStateChange(code: ResponseCode, _value: number): void {
    switch (code) {
      case ResponseCode.Power:
        this.tvService.getCharacteristic(this.Characteristic.Active)
          .updateValue(this.device.state.power
            ? this.Characteristic.Active.ACTIVE
            : this.Characteristic.Active.INACTIVE);
        break;

      case ResponseCode.Volume:
        if (this.volumeService) {
          const percent = this.device.volumeToPercent(this.device.state.volume);
          const levelChar = this.config.volumeControl === 'fan'
            ? this.Characteristic.RotationSpeed : this.Characteristic.Brightness;
          this.volumeService.getCharacteristic(levelChar).updateValue(percent);
          this.volumeService.getCharacteristic(this.Characteristic.On)
            .updateValue(!this.device.state.mute && this.device.state.volume > 0);
        }
        break;

      case ResponseCode.Mute:
        this.speakerService.getCharacteristic(this.Characteristic.Mute)
          .updateValue(this.device.state.mute);
        if (this.volumeService) {
          this.volumeService.getCharacteristic(this.Characteristic.On)
            .updateValue(!this.device.state.mute && this.device.state.volume > 0);
        }
        break;

      case ResponseCode.Source:
        this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier)
          .updateValue(this.device.state.source + 1);
        break;

      case ResponseCode.Preset:
        this.updatePresetSwitches(this.device.state.preset);
        break;

      case ResponseCode.QuietMode:
        if (this.quietModeService) {
          this.quietModeService.getCharacteristic(this.Characteristic.On)
            .updateValue(this.device.state.quietMode);
        }
        break;
    }
  }
}
