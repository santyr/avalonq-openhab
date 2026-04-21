# avalonq-openhab

Standalone openHAB integration for the Canaan Avalon Q miner using the miner's direct TCP command API on port `4028`.

This repo was extracted from `cl-hive` so the Avalon Q integration can evolve independently.

It does not require MQTT.

## Repository contents

- `examples/openhab/avalonq.items`
- `examples/openhab/avalonq.js`
- `examples/openhab/avalonq-voltage-protection.js`

## What it does

- polls the miner directly over TCP
- reads these commands:
  - `version`
  - `summary`
  - `estats`
  - `pools`
- updates openHAB Items from parsed responses
- sends control commands for:
  - workmode
  - standby / wake
  - reboot
  - fan speed
  - LCD
- supports battery/charger-based load management:
  - standby / wake via miner API
  - optional power on/off via external relay item
  - workmode selection based on battery SoC and charger state

## Why this design

The Avalon Q API is a direct command socket, not REST.

This integration avoids one-command-per-item polling. Instead, the rule script:
- polls a small set of high-value commands on a schedule
- parses once
- updates many Items from the same poll cycle

That keeps the no-MQTT design efficient and avoids hammering the miner.

## openHAB prerequisites

Recommended:
- openHAB JS Scripting add-on
- `openhab-js` helper library

## Files

### `examples/openhab/avalonq.items`
Creates:
- availability/state items
- metrics items
- info items
- control items
- load-management items

### `examples/openhab/avalonq.js`
Contains:
- miner configuration block at top
- TCP socket helper
- parser helpers for Avalon Q command responses
- scheduled polling rules
- manual command rules
- battery/charger load-management rule

### `examples/openhab/avalonq-voltage-protection.js`
Contains:
- a dedicated low-voltage protection rule for the Avalon path
- preferred behavior of entering standby via the Avalon API
- optional AC relay-off fallback if you decide hard power-off is needed later

## Install outline

1. Copy `examples/openhab/avalonq.items` into your openHAB items directory.
2. Copy `examples/openhab/avalonq.js` into your JS automation directory.
3. Edit the configuration block at the top of the JS file:
   - miner host
   - port
   - item prefix
   - polling intervals
   - battery SoC item name
   - charger active item name
   - external power relay item name, if used
   - SoC thresholds for standby / eco / standard / super
4. Reload items and rules.

## Notes for the inspected openHAB environment

From the current openHAB model:
- battery SoC item: `BatterySoC_Calculated`
- charging proxy item: `BatteryChargingStatus`
- charger stage item: `ChargerStatus`
- existing miner relay item: `Miner_Power`
- existing miner voltage protection rule: `Miner Voltage Protection`

Important: `Miner_Power` is already tied to an existing miner power path and should not be reused for the Avalon Q.

Recommended approach for this environment:
- keep the current Bitaxe/legacy miner on `Miner_Power`
- create a separate smart-plug Thing and linked Item for the Avalon, e.g. `AvalonQ_Miner1_PowerRelay`
- keep Avalon telemetry/control items under the `AvalonQ_Miner1_` prefix
- reuse `BatterySoC_Calculated` and `BatteryChargingStatus` as shared upstream power-state inputs
- prefer putting the Avalon into standby via its API instead of hard power-off
- if desired, use a dedicated Avalon voltage-protection rule with optional relay-off fallback instead of sharing the existing miner rule

## Battery / charger automation

The example rule file assumes you want miner behavior to follow:
- battery SoC
- charger status

Policy implemented in the example:
- low SoC => standby / optional relay off
- medium SoC => Eco
- higher SoC => Standard
- highest SoC with charger active => Super
- if charger is inactive and `allowMiningWithoutCharger` is false, the miner is put into standby/off

Tune these values in the JS config block for your system.

## Notes

- `softoff` and `softon` require a timestamp a few seconds in the future.
- `fan-spd=-1` returns control to automatic fan mode.
- `setpool` is intentionally not included in the first-pass control items because it requires credentials and is higher risk.
- This repo is a starting point. Adjust item names, groups, semantic tags, and UI metadata to your setup.
