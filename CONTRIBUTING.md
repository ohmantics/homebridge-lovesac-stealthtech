# Contributing

## Development Setup

```sh
git clone https://github.com/ohmantics/homebridge-lovesac-stealthtech.git
cd homebridge-lovesac-stealthtech
npm install
npm run build
npm link
```

## Running Locally

Use a test config directory so you don't disturb your main Homebridge setup:

```sh
homebridge -D -U ./test-homebridge-config/
```

The `-D` flag enables debug logging, which will show all BLE communication.

## Building

```sh
npm run build       # one-time compile
npm run watch       # recompile on changes
```
