/*
 * Example openHAB JS Scripting rule set for a Canaan Avalon Q miner.
 *
 * Direct TCP API on port 4028, no MQTT required.
 *
 * This script is designed for the Items in:
 *   examples/openhab/avalonq.items
 *
 * It also supports battery/charger-based load management:
 * - power relay on/off
 * - standby / wake
 * - automatic workmode selection based on SoC and charger state
 *
 * Requires the openhab-js helper library.
 */

const { rules, triggers, items, time } = require('openhab');
const JavaSocket = Java.type('java.net.Socket');
const InetSocketAddress = Java.type('java.net.InetSocketAddress');
const BufferedReader = Java.type('java.io.BufferedReader');
const InputStreamReader = Java.type('java.io.InputStreamReader');
const OutputStreamWriter = Java.type('java.io.OutputStreamWriter');
const StringBuilder = Java.type('java.lang.StringBuilder');
const StandardCharsets = Java.type('java.nio.charset.StandardCharsets');
const ZonedDateTime = Java.type('java.time.ZonedDateTime');
const Duration = Java.type('java.time.Duration');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const CFG = {
  // Replace with your miner's LAN IP or hostname.
  host: '192.168.1.50',
  port: 4028,
  prefix: 'AvalonQ_Miner1_',

  // Polling cadence
  fastPollCron: '0/15 * * * * ?',
  slowPollCron: '0 0/5 * * * ?',
  socketTimeoutMs: 4000,
  connectTimeoutMs: 2500,

  // External load-management integration.
  // Defaults below match the inspected openHAB environment.
  // Keep the Avalon relay item separate from any existing Bitaxe/other miner relay.
  batterySocItem: 'BatterySoC_Calculated',
  chargerActiveItem: 'BatteryChargingStatus',
  powerRelayItem: 'AvalonQ_Miner1_PowerRelay_Set',

  // Enable relay control if the miner is physically powered by a smart relay.
  usePowerRelay: true,

  // Preferred stop behavior:
  // - false: keep AC power on and use the Avalon API to enter standby
  // - true: after entering standby, also cut AC power via the relay
  powerOffWhenStopped: false,

  // If false, highest automatic mode is Standard.
  // Keep false for now to stay within a 15A circuit; revisit in winter if needed.
  allowSuperMode: false,

  // SoC policy
  socStopThreshold: 35,
  socEcoThreshold: 55,
  socStandardThreshold: 75,
  socSuperThreshold: 90,

  // If true, charger must be active before we wake/start mining.
  requireChargerForWake: true,

  // If charger is inactive, miner will be put in standby/power-off.
  allowMiningWithoutCharger: false,

  // Timestamped soft on/off commands need a few seconds in the future.
  softPowerLeadSeconds: 5,
};

// -----------------------------------------------------------------------------
// ITEM HELPERS
// -----------------------------------------------------------------------------

function itemName(suffix) {
  return `${CFG.prefix}${suffix}`;
}

function safePostUpdate(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`AvalonQ: postUpdate failed for ${name}: ${e}`);
  }
}

function safeSendCommand(name, value) {
  try {
    items.getItem(name).sendCommand(String(value));
  } catch (e) {
    console.warn(`AvalonQ: sendCommand failed for ${name}: ${e}`);
  }
}

function getItemString(name, fallback = '') {
  try {
    const state = items.getItem(name).state;
    return state == null ? fallback : String(state);
  } catch (e) {
    return fallback;
  }
}

function getItemNumber(name, fallback = 0) {
  const raw = getItemString(name, '');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function getItemBool(name, fallback = false) {
  const raw = getItemString(name, '').toUpperCase();
  if (raw === 'ON' || raw === 'TRUE') return true;
  if (raw === 'OFF' || raw === 'FALSE') return false;
  return fallback;
}

// -----------------------------------------------------------------------------
// TCP API HELPERS
// -----------------------------------------------------------------------------

function sendAvalonCommand(command) {
  let socket = null;
  let reader = null;
  let writer = null;
  try {
    socket = new JavaSocket();
    socket.connect(new InetSocketAddress(CFG.host, CFG.port), CFG.connectTimeoutMs);
    socket.setSoTimeout(CFG.socketTimeoutMs);

    writer = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
    writer.write(command);
    writer.flush();
    socket.shutdownOutput();

    reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
    const sb = new StringBuilder();
    let line = null;
    while ((line = reader.readLine()) !== null) {
      sb.append(line);
    }
    return String(sb.toString());
  } finally {
    try { if (reader) reader.close(); } catch (e) {}
    try { if (writer) writer.close(); } catch (e) {}
    try { if (socket) socket.close(); } catch (e) {}
  }
}

function extractField(raw, key) {
  const re = new RegExp(`${key}=([^|,]+)`);
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function extractBracketValue(raw, key) {
  const re = new RegExp(`${key}\\[([^\\]]+)\\]`);
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

function normalizeWorkmode(modeValue, summaryRaw) {
  if (summaryRaw && summaryRaw.includes('Work: In Idle')) return 'Standby';
  if (modeValue === '0') return 'Eco';
  if (modeValue === '1') return 'Standard';
  if (modeValue === '2') return 'Super';
  return 'Unknown';
}

function parseVersion(raw) {
  return {
    cgminer: extractField(raw, 'CGMiner'),
    api: extractField(raw, 'API'),
    prod: extractField(raw, 'PROD'),
    model: extractField(raw, 'MODEL'),
    firmware: extractField(raw, 'LVERSION'),
    mac: extractField(raw, 'MAC'),
    dna: extractField(raw, 'DNA'),
    raw,
  };
}

function parseSummary(raw) {
  return {
    elapsed: extractField(raw, 'Elapsed'),
    mhsAv: extractField(raw, 'MHS av'),
    accepted: extractField(raw, 'Accepted'),
    rejected: extractField(raw, 'Rejected'),
    hardwareErrors: extractField(raw, 'Hardware Errors'),
    poolRejectedPct: extractField(raw, 'Pool Rejected%'),
    raw,
  };
}

function parsePools(raw) {
  return {
    status: extractField(raw, 'Status'),
    url: extractField(raw, 'URL'),
    stratumUrl: extractField(raw, 'Stratum URL'),
    accepted: extractField(raw, 'Accepted'),
    rejected: extractField(raw, 'Rejected'),
    lastShareTime: extractField(raw, 'Last Share Time'),
    stratumDifficulty: extractField(raw, 'Stratum Difficulty'),
    raw,
  };
}

function parseEstats(raw) {
  const workmodeNum = extractBracketValue(raw, 'WORKMODE');
  const systemSummary = extractBracketValue(raw, 'SYSTEMSTATU');
  return {
    systemStatus: systemSummary,
    state: extractBracketValue(raw, 'STATE'),
    elapsed: extractBracketValue(raw, 'Elapsed'),
    internalTemp: extractBracketValue(raw, 'ITemp'),
    inletTemp: extractBracketValue(raw, 'HBITemp'),
    outletTemp: extractBracketValue(raw, 'HBOTemp'),
    tempMax: extractBracketValue(raw, 'TMax'),
    tempAvg: extractBracketValue(raw, 'TAvg'),
    fan1: extractBracketValue(raw, 'Fan1'),
    fan2: extractBracketValue(raw, 'Fan2'),
    fan3: extractBracketValue(raw, 'Fan3'),
    fan4: extractBracketValue(raw, 'Fan4'),
    fanErr: extractBracketValue(raw, 'FanErr'),
    ping: extractBracketValue(raw, 'PING'),
    power: (() => {
      const ps = extractBracketValue(raw, 'PS');
      if (!ps) return null;
      const vals = ps.split(/\s+/).map(v => parseFloat(v)).filter(Number.isFinite);
      return vals.length >= 2 ? vals[1] : null;
    })(),
    ghsSpd: extractBracketValue(raw, 'GHSspd'),
    lcdOn: extractBracketValue(raw, 'LcdOnoff') === '1',
    workmodeNum,
    workmode: normalizeWorkmode(workmodeNum, systemSummary),
    standby: systemSummary ? systemSummary.includes('Work: In Idle') : false,
    raw,
  };
}

function toJsonString(obj) {
  return JSON.stringify(obj);
}

// -----------------------------------------------------------------------------
// POLLING
// -----------------------------------------------------------------------------

function updateAvailability(isOnline) {
  safePostUpdate(itemName('Availability'), isOnline ? 'online' : 'offline');
}

function updateFromVersion(v) {
  safePostUpdate(itemName('CGMinerVersion'), v.cgminer || 'n/a');
  safePostUpdate(itemName('APIVersion'), v.api || 'n/a');
  safePostUpdate(itemName('Model'), v.model || v.prod || 'n/a');
  safePostUpdate(itemName('Firmware'), v.firmware || 'n/a');
  safePostUpdate(itemName('MAC'), v.mac || 'n/a');
  safePostUpdate(itemName('DNA'), v.dna || 'n/a');
  safePostUpdate(itemName('RawVersion'), toJsonString(v));
}

function updateFromSummary(s) {
  safePostUpdate(itemName('AcceptedShares'), s.accepted || 0);
  safePostUpdate(itemName('RejectedShares'), s.rejected || 0);
  safePostUpdate(itemName('HardwareErrors'), s.hardwareErrors || 0);
  safePostUpdate(itemName('RejectionRate'), s.poolRejectedPct || 0);
  safePostUpdate(itemName('UptimeSeconds'), s.elapsed || 0);
  safePostUpdate(itemName('RawSummary'), toJsonString(s));
}

function updateFromPools(p) {
  safePostUpdate(itemName('PoolOnline'), (p.status || '').toLowerCase() === 'alive' ? 'ON' : 'OFF');
  safePostUpdate(itemName('PoolURL'), p.stratumUrl || p.url || 'n/a');
  safePostUpdate(itemName('RawPools'), toJsonString(p));
}

function updateFromEstats(e) {
  const hashrateThs = e.ghsSpd ? (parseFloat(e.ghsSpd) / 1000.0) : 0;
  safePostUpdate(itemName('SystemStatus'), e.systemStatus || 'n/a');
  safePostUpdate(itemName('Workmode'), e.workmode || 'Unknown');
  safePostUpdate(itemName('StandbyState'), e.standby ? 'ON' : 'OFF');
  safePostUpdate(itemName('LCD'), e.lcdOn ? 'ON' : 'OFF');
  safePostUpdate(itemName('PowerW'), e.power || 0);
  safePostUpdate(itemName('HashrateTHS'), hashrateThs || 0);
  safePostUpdate(itemName('InternalTemp'), e.internalTemp || 0);
  safePostUpdate(itemName('InletTemp'), e.inletTemp || 0);
  safePostUpdate(itemName('OutletTemp'), e.outletTemp || 0);
  safePostUpdate(itemName('AvgChipTemp'), e.tempAvg || 0);
  safePostUpdate(itemName('MaxChipTemp'), e.tempMax || 0);
  safePostUpdate(itemName('Fan1RPM'), e.fan1 || 0);
  safePostUpdate(itemName('Fan2RPM'), e.fan2 || 0);
  safePostUpdate(itemName('Fan3RPM'), e.fan3 || 0);
  safePostUpdate(itemName('Fan4RPM'), e.fan4 || 0);
  safePostUpdate(itemName('PingMS'), e.ping || 0);
  const power = parseFloat(e.power || 0);
  const eff = hashrateThs > 0 ? (power / hashrateThs) : 0;
  safePostUpdate(itemName('EfficiencyJTH'), eff.toFixed(2));
  safePostUpdate(itemName('RawEstats'), toJsonString(e));
}

function pollFast() {
  try {
    const summary = parseSummary(sendAvalonCommand('summary'));
    const estats = parseEstats(sendAvalonCommand('estats'));
    const pools = parsePools(sendAvalonCommand('pools'));
    updateAvailability(true);
    updateFromSummary(summary);
    updateFromEstats(estats);
    updateFromPools(pools);
  } catch (e) {
    console.warn(`AvalonQ fast poll failed: ${e}`);
    updateAvailability(false);
  }
}

function pollSlow() {
  try {
    const version = parseVersion(sendAvalonCommand('version'));
    updateAvailability(true);
    updateFromVersion(version);
  } catch (e) {
    console.warn(`AvalonQ slow poll failed: ${e}`);
    updateAvailability(false);
  }
}

// -----------------------------------------------------------------------------
// COMMANDS
// -----------------------------------------------------------------------------

function epochPlus(seconds) {
  return Math.floor(Date.now() / 1000) + seconds;
}

function setWorkmode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  const modeMap = {
    eco: 0,
    standard: 1,
    super: 2,
  };
  if (!(normalized in modeMap)) throw new Error(`Unsupported workmode: ${mode}`);
  return sendAvalonCommand(`ascset|0,workmode,set,${modeMap[normalized]}`);
}

function setStandby(enableStandby) {
  const ts = epochPlus(CFG.softPowerLeadSeconds);
  if (enableStandby) {
    return sendAvalonCommand(`ascset|0,softoff,1:${ts}`);
  }
  return sendAvalonCommand(`ascset|0,softon,1:${ts}`);
}

function setLcd(on) {
  return sendAvalonCommand(`ascset|0,lcd,0:${on ? 1 : 0}`);
}

function rebootMiner() {
  return sendAvalonCommand('ascset|0,reboot,0');
}

function setFanSpeed(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) throw new Error(`Invalid fan speed: ${percent}`);
  if (value !== -1 && (value < 15 || value > 100)) {
    throw new Error(`Fan speed must be -1 or 15..100, got ${percent}`);
  }
  return sendAvalonCommand(`ascset|0,fan-spd,${Math.trunc(value)}`);
}

// -----------------------------------------------------------------------------
// LOAD MANAGEMENT
// -----------------------------------------------------------------------------

function desiredWorkmodeFromSoc(soc, chargerActive) {
  if (!chargerActive && !CFG.allowMiningWithoutCharger) return 'Standby';
  if (CFG.allowSuperMode && soc >= CFG.socSuperThreshold && chargerActive) return 'Super';
  if (soc >= CFG.socStandardThreshold) return 'Standard';
  if (soc >= CFG.socEcoThreshold) return 'Eco';
  return 'Standby';
}

function evaluateLoadManagement() {
  if (!getItemBool(itemName('LoadManagement_Enable'), false)) {
    safePostUpdate(itemName('LoadDecision'), 'disabled');
    return;
  }

  const soc = getItemNumber(CFG.batterySocItem, 0);
  const chargerActive = getItemBool(CFG.chargerActiveItem, false);
  const desiredMode = desiredWorkmodeFromSoc(soc, chargerActive);
  const shouldRun = desiredMode !== 'Standby' && soc >= CFG.socStopThreshold && (!CFG.requireChargerForWake || chargerActive);

  safePostUpdate(itemName('LoadDecision'), `soc=${soc},charger=${chargerActive},mode=${desiredMode},run=${shouldRun}`);

  try {
    if (shouldRun) {
      if (CFG.usePowerRelay) safeSendCommand(CFG.powerRelayItem, 'ON');
      setStandby(false);
      if (desiredMode !== 'Standby') setWorkmode(desiredMode);
    } else {
      setStandby(true);
      if (CFG.usePowerRelay && CFG.powerOffWhenStopped) safeSendCommand(CFG.powerRelayItem, 'OFF');
    }
  } catch (e) {
    console.warn(`AvalonQ load management action failed: ${e}`);
  }
}

// -----------------------------------------------------------------------------
// RULES
// -----------------------------------------------------------------------------

rules.JSRule({
  name: 'AvalonQ Fast Poll',
  description: 'Poll summary/estats/pools from Avalon Q',
  triggers: [triggers.GenericCronTrigger(CFG.fastPollCron)],
  execute: () => pollFast(),
});

rules.JSRule({
  name: 'AvalonQ Slow Poll',
  description: 'Poll version info from Avalon Q',
  triggers: [triggers.GenericCronTrigger(CFG.slowPollCron)],
  execute: () => pollSlow(),
});

rules.JSRule({
  name: 'AvalonQ Manual Workmode Command',
  triggers: [triggers.ItemCommandTrigger(itemName('Workmode_Set'))],
  execute: (event) => {
    try {
      setWorkmode(String(event.receivedCommand));
      pollFast();
    } catch (e) {
      console.warn(`AvalonQ workmode command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ Standby Command',
  triggers: [triggers.ItemCommandTrigger(itemName('Standby_Set'))],
  execute: (event) => {
    try {
      const enable = String(event.receivedCommand).toUpperCase() === 'ON';
      setStandby(enable);
      pollFast();
    } catch (e) {
      console.warn(`AvalonQ standby command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ LCD Command',
  triggers: [triggers.ItemCommandTrigger(itemName('LCD_Set'))],
  execute: (event) => {
    try {
      const on = String(event.receivedCommand).toUpperCase() === 'ON';
      setLcd(on);
      pollFast();
    } catch (e) {
      console.warn(`AvalonQ LCD command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ Reboot Command',
  triggers: [triggers.ItemCommandTrigger(itemName('Reboot'))],
  execute: (event) => {
    try {
      if (String(event.receivedCommand).toUpperCase() === 'ON') {
        rebootMiner();
        safeSendCommand(itemName('Reboot'), 'OFF');
      }
    } catch (e) {
      console.warn(`AvalonQ reboot command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ Fan Speed Command',
  triggers: [triggers.ItemCommandTrigger(itemName('FanSpeed_Set'))],
  execute: (event) => {
    try {
      setFanSpeed(Number(String(event.receivedCommand)));
      pollFast();
    } catch (e) {
      console.warn(`AvalonQ fan speed command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ Fan Auto Command',
  triggers: [triggers.ItemCommandTrigger(itemName('FanAuto_Set'))],
  execute: (event) => {
    try {
      if (String(event.receivedCommand).toUpperCase() === 'ON') {
        setFanSpeed(-1);
      }
      pollFast();
    } catch (e) {
      console.warn(`AvalonQ fan auto command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'AvalonQ Battery Load Management',
  description: 'Drive power/standby/workmode from battery SoC and charger state',
  triggers: [
    triggers.ItemStateChangeTrigger(CFG.batterySocItem),
    triggers.ItemStateChangeTrigger(CFG.chargerActiveItem),
    triggers.ItemStateChangeTrigger(itemName('LoadManagement_Enable')),
  ],
  execute: () => evaluateLoadManagement(),
});

// Prime the cache shortly after script load.
setTimeout(() => {
  try {
    pollSlow();
    pollFast();
    evaluateLoadManagement();
  } catch (e) {
    console.warn(`AvalonQ initial poll failed: ${e}`);
  }
}, 3000);
