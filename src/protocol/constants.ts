// Response codes — last 2 bytes of UpStream notifications: <code> <value>
export enum ResponseCode {
  Volume       = 0x01,
  CenterVolume = 0x02,
  Treble       = 0x03,
  Bass         = 0x04,
  Mute         = 0x05,
  QuietMode    = 0x06,
  Balance      = 0x07,
  Layout       = 0x08,
  Source       = 0x09,
  Power        = 0x0a,
  Preset       = 0x0b,
  Covering     = 0x0c,
  ArmType      = 0x0d,
  Subwoofer    = 0x0e,
  RearVolume   = 0x0f,
}

// Preset WRITE values (sent to device)
export enum PresetWriteValue {
  TV     = 5,
  News   = 6,
  Movies = 7,
  Music  = 8,
  Manual = 9,
}

// Preset READ values (received in notifications)
export enum PresetReadValue {
  Movies = 0,
  Music  = 1,
  TV     = 2,
  News   = 3,
}

// Source values (same for read and write)
export enum SourceValue {
  HDMI      = 0,
  Bluetooth = 1,
  AUX       = 2,
  Optical   = 3,
}

// Maps a preset read value to the corresponding write value
export function presetReadToWrite(readVal: PresetReadValue): PresetWriteValue {
  switch (readVal) {
    case PresetReadValue.Movies: return PresetWriteValue.Movies;
    case PresetReadValue.Music:  return PresetWriteValue.Music;
    case PresetReadValue.TV:     return PresetWriteValue.TV;
    case PresetReadValue.News:   return PresetWriteValue.News;
    default: throw new Error(`Unknown preset read value: ${readVal}`);
  }
}

// Maps a preset write value to the corresponding read value
export function presetWriteToRead(writeVal: PresetWriteValue): PresetReadValue | undefined {
  switch (writeVal) {
    case PresetWriteValue.Movies: return PresetReadValue.Movies;
    case PresetWriteValue.Music:  return PresetReadValue.Music;
    case PresetWriteValue.TV:     return PresetReadValue.TV;
    case PresetWriteValue.News:   return PresetReadValue.News;
    default: return undefined;
  }
}

export const PRESET_NAMES: Record<PresetReadValue, string> = {
  [PresetReadValue.Movies]: 'Movies',
  [PresetReadValue.Music]:  'Music',
  [PresetReadValue.TV]:     'TV',
  [PresetReadValue.News]:   'News',
};

export const SOURCE_NAMES: Record<SourceValue, string> = {
  [SourceValue.HDMI]:      'HDMI-ARC',
  [SourceValue.Bluetooth]: 'Bluetooth',
  [SourceValue.AUX]:       'AUX',
  [SourceValue.Optical]:   'Optical',
};
