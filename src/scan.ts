#!/usr/bin/env node
/**
 * Standalone BLE scanner to find Lovesac StealthTech devices.
 * Usage: npx homebridge-lovesac-stealthtech scan
 *    or: node dist/scan.js
 */

import noble from '@stoprocent/noble';
import { SOFA_SERVICE_UUID_SHORT, BLE_SCAN_TIMEOUT } from './settings';

console.log('Scanning for Lovesac StealthTech devices (%ds)...', BLE_SCAN_TIMEOUT / 1000);
console.log('Make sure the soundbar is powered on and no other app is connected.\n');

const found: { id: string; name: string; rssi: number }[] = [];

noble.on('discover', (peripheral: noble.Peripheral) => {
  const name = peripheral.advertisement?.localName ?? '(unnamed)';
  const rssi = peripheral.rssi ?? 0;
  const id = peripheral.address !== '' && peripheral.address !== 'unknown'
    ? peripheral.address
    : peripheral.id ?? peripheral.uuid ?? '(unknown)';

  console.log('  Found: %s [%s] RSSI=%d', name, id, rssi);
  found.push({ id, name, rssi });
});

const startScan = () => {
  noble.startScanning([SOFA_SERVICE_UUID_SHORT], false, (err?: Error) => {
    if (err) {
      console.error('Scan error:', err.message);
      process.exit(1);
    }
  });
};

if (noble.state === 'poweredOn') {
  startScan();
} else {
  noble.once('stateChange', (state: string) => {
    if (state === 'poweredOn') {
      startScan();
    } else {
      console.error('Bluetooth adapter state:', state);
      process.exit(1);
    }
  });
}

setTimeout(() => {
  noble.stopScanning();
  console.log('\nScan complete.');
  if (found.length === 0) {
    console.log('No Lovesac devices found.');
  } else {
    console.log('\nAdd this to your Homebridge config:');
    console.log(JSON.stringify({
      platform: 'LovesacStealthTech',
      devices: [{ name: found[0].name, address: found[0].id }],
    }, null, 2));
  }
  process.exit(0);
}, BLE_SCAN_TIMEOUT);
