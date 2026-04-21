/*
 * Example openHAB JavaScript rule for Avalon Q low-voltage protection.
 *
 * Preferred behavior is to put the miner into standby via the Avalon API,
 * not to hard-cut AC power. A relay-off fallback is optional.
 *
 * Requires:
 * - avalonq.js loaded and reachable in the same automation environment
 * - a DC battery voltage item in openHAB
 * - a dedicated Avalon relay item if AC relay control is desired
 */

const { rules, triggers, items } = require('openhab');

const PROTECT = {
  voltageItem: 'DCData_Voltage',
  standbyItem: 'AvalonQ_Miner1_Standby_Set',
  powerRelayItem: 'AvalonQ_Miner1_PowerRelay_Set',
  loadDecisionItem: 'AvalonQ_Miner1_LoadDecision',

  lowLimit: 50.0,
  recoveryLimit: 51.0,
  delaySeconds: 60,

  // Preferred default for Avalon Q: standby only.
  powerOffAfterStandby: false,
};

function getNumber(name, fallback = NaN) {
  try {
    const n = parseFloat(String(items.getItem(name).state));
    return Number.isFinite(n) ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

function getString(name, fallback = '') {
  try {
    return String(items.getItem(name).state);
  } catch (e) {
    return fallback;
  }
}

function send(name, value) {
  try {
    items.getItem(name).sendCommand(String(value));
  } catch (e) {
    console.warn(`AvalonQ voltage protection sendCommand failed for ${name}: ${e}`);
  }
}

function post(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`AvalonQ voltage protection postUpdate failed for ${name}: ${e}`);
  }
}

rules.JSRule({
  name: 'AvalonQ Voltage Protection',
  description: 'Puts Avalon Q into standby on sustained low battery voltage; optional relay-off fallback',
  triggers: [triggers.ItemStateChangeTrigger(PROTECT.voltageItem)],
  execute: () => {
    const voltage = getNumber(PROTECT.voltageItem);
    if (!Number.isFinite(voltage)) return;

    const timer = cache.private.get('avalonqVoltageTimer');
    const standbyState = getString('AvalonQ_Miner1_StandbyState', 'OFF');

    if (voltage <= PROTECT.lowLimit && standbyState !== 'ON') {
      if (!timer) {
        post(PROTECT.loadDecisionItem, `low_voltage_pending:${voltage}`);
        cache.private.put('avalonqVoltageTimer', setTimeout(() => {
          const currentV = getNumber(PROTECT.voltageItem);
          if (Number.isFinite(currentV) && currentV <= PROTECT.lowLimit) {
            send(PROTECT.standbyItem, 'ON');
            if (PROTECT.powerOffAfterStandby) {
              send(PROTECT.powerRelayItem, 'OFF');
            }
            post(PROTECT.loadDecisionItem, `low_voltage_standby:${currentV}`);
          }
          cache.private.remove('avalonqVoltageTimer');
        }, PROTECT.delaySeconds * 1000));
      }
    } else if (voltage > PROTECT.lowLimit) {
      if (timer) {
        clearTimeout(timer);
        cache.private.remove('avalonqVoltageTimer');
      }

      if (voltage >= PROTECT.recoveryLimit && standbyState === 'ON') {
        if (PROTECT.powerOffAfterStandby) {
          send(PROTECT.powerRelayItem, 'ON');
        }
        send(PROTECT.standbyItem, 'OFF');
        post(PROTECT.loadDecisionItem, `recovered:${voltage}`);
      }
    }
  },
});
