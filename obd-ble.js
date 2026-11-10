// AUTORYX direct link: ELM327 over Bluetooth Low Energy (Web Bluetooth), no server needed.
// The engine answers the same routes as the FastAPI backend so the app code stays identical.
const ObdBle = (() => {
  const HEX2 = /^[0-9A-Fa-f]{2}$/;
  const NOISE = ['SEARCHING', 'NO DATA', 'STOPPED', 'ERROR', 'UNABLE', 'BUS INIT', 'CAN ERROR', '?'];

  function cleanLines(raw) {
    return String(raw || '').replace(/>/g, '').split(/[\r\n]+/).map(l => l.trim())
      .filter(l => l && !NOISE.some(n => l.toUpperCase().includes(n)))
      .map(l => l.replace(/^[0-9A-Fa-f]:\s*/, ''));
  }
  function hexBytes(raw) {
    const out = [];
    for (const line of cleanLines(raw)) {
      if (line.length === 3 && !line.includes(' ')) continue;
      const tokens = line.includes(' ') ? line.split(/\s+/) : line.match(/.{1,2}/g) || [];
      for (const t of tokens) if (HEX2.test(t)) out.push(parseInt(t, 16));
    }
    return out;
  }
  function pidData(raw, pid) {
    const b = hexBytes(raw);
    for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x41 && b[i + 1] === pid) return b.slice(i + 2);
    return null;
  }
  function byHeader(raw) {
    const out = {};
    for (const line of cleanLines(raw)) {
      const parts = line.split(/\s+/);
      if (parts.length < 2 || !/^[0-9A-Fa-f]{3}$/.test(parts[0])) continue;
      const key = parts[0].toUpperCase();
      (out[key] = out[key] || []).push(...parts.slice(1).filter(t => HEX2.test(t)).map(t => parseInt(t, 16)));
    }
    return out;
  }
  function vinFrom(data) {
    const text = data.filter(c => c >= 0x30 && c <= 0x5A).map(c => String.fromCharCode(c)).filter(ch => /[A-Z0-9]/.test(ch)).join('');
    return text.length >= 17 ? text.slice(-17) : null;
  }
  function parseVin(raw) {
    const b = hexBytes(raw);
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i] === 0x49 && b[i + 1] === 0x02) return vinFrom(b.slice(i + 3));
      if (b[i] === 0x62 && b[i + 1] === 0xF1 && b[i + 2] === 0x90) return vinFrom(b.slice(i + 3));
    }
    return null;
  }
  const DTC_LETTER = ['P', 'C', 'B', 'U'];
  function parseDtcs(raw, respSid) {
    const b = hexBytes(raw), codes = [];
    let i = b.indexOf(respSid);
    while (i >= 0 && i < b.length) {
      let j = i + 1;
      const pairsLeft = b.length - j;
      const count = b[j];
      const hasCount = count !== undefined && count * 2 <= pairsLeft - 1 && (pairsLeft - 1) % 2 === 0;
      if (hasCount) j++;
      const end = hasCount ? j + count * 2 : b.length;
      for (; j + 1 < end && j + 1 < b.length; j += 2) {
        const a = b[j], c = b[j + 1];
        if (a === 0 && c === 0) continue;
        codes.push(DTC_LETTER[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + c.toString(16).toUpperCase().padStart(2, '0'));
      }
      const next = b.indexOf(respSid, end);
      i = next > i ? next : -1;
    }
    return [...new Set(codes)];
  }

  // name, unit, decoder(bytes), min, max
  const PIDS = {
    '04': ['Charge moteur', '%', d => d[0] * 100 / 255, 0, 100],
    '05': ['Temp. liquide', '°C', d => d[0] - 40, -40, 150],
    '06': ['Corr. CT bank1', '%', d => (d[0] - 128) * 100 / 128, -100, 100],
    '0B': ['Pression admission', 'kPa', d => d[0], 0, 255],
    '0C': ['Régime moteur', 'tr/min', d => (d[0] * 256 + d[1]) / 4, 0, 8000],
    '0D': ['Vitesse', 'km/h', d => d[0], 0, 250],
    '0E': ['Avance allumage', '° AV', d => d[0] / 2 - 64, -64, 64],
    '0F': ['Temp. admission', '°C', d => d[0] - 40, -40, 100],
    '10': ["Débit d'air (MAF)", 'g/s', d => (d[0] * 256 + d[1]) / 100, 0, 655],
    '11': ['Papillon', '%', d => d[0] * 100 / 255, 0, 100],
    '2F': ['Niveau carburant', '%', d => d[0] * 100 / 255, 0, 100],
    '33': ['Pression atm.', 'kPa', d => d[0], 80, 110],
    '42': ['Tension batterie', 'V', d => (d[0] * 256 + d[1]) / 1000, 9, 16],
    '5C': ['Temp. huile', '°C', d => d[0] - 40, -40, 180],
  };
  const OBD_NAMES = { '7E8': 'ECU Moteur', '7E9': 'BVA / Boîte auto' };

  function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

  function udsPos(raw, sid) {
    const b = hexBytes(raw);
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 0x7F && b[i + 1] === sid) return null;
      if (b[i] === ((sid + 0x40) & 0xFF)) return b.slice(i + 1);
    }
    return null;
  }
  function asciiRuns(bytes) {
    const runs = []; let cur = '';
    for (const c of bytes) {
      if (c >= 0x20 && c < 0x7F) cur += String.fromCharCode(c);
      else { if (cur.trim().length >= 3) runs.push(cur.trim()); cur = ''; }
    }
    if (cur.trim().length >= 3) runs.push(cur.trim());
    return runs;
  }
  const dtc2 = (hi, lo) => DTC_LETTER[hi >> 6] + ((hi >> 4) & 3) + (hi & 15).toString(16).toUpperCase() + lo.toString(16).toUpperCase().padStart(2, '0');
  const ECUS = typeof RENAULT_ECUS !== 'undefined' ? RENAULT_ECUS : (typeof require === 'function' ? (() => { try { return require('./renault-ecus.js'); } catch { return []; } })() : []);
  const QUICK_TX = ['7E0', '7E1', '740', '752', '745', '743', '744', '742', '74D', '74E', '758', '755', '74C', '712', '751', '750', '75C'];

  function createEngine(send, wanted = () => Object.keys(PIDS)) {
    let supported = null;
    let liveBusy = null;
    let lastScan = null;
    let scanning = false;

    async function monitors() {
      const d = pidData(await send('0101'), 0x01);
      if (!d || d.length < 4) throw httpError(404, 'Ce véhicule ne renvoie pas l\'état des moniteurs (PID 01 01).');
      const [A, B, C, D] = d;
      const compression = !!(B & 0x08);
      const list = [['Ratés d\'allumage', B, 0, B, 4], ['Système carburant', B, 1, B, 5], ['Composants (CCM)', B, 2, B, 6]];
      const names = compression
        ? ['Catalyseur NMHC', 'Réduction NOx / SCR', null, 'Pression de suralimentation', null, 'Sonde gaz d\'échappement', 'Filtre à particules', 'EGR / VVT']
        : ['Catalyseur', 'Catalyseur chauffé', 'Système EVAP', 'Air secondaire', null, 'Sonde O2', 'Chauffage sonde O2', 'Système EGR'];
      names.forEach((n, k) => { if (n) list.push([n, C, k, D, k]); });
      return {
        mil: !!(A & 0x80), dtc_count: A & 0x7F, ignition: compression ? 'diesel' : 'essence',
        monitors: list.filter(([, sv, sb]) => sv & (1 << sb)).map(([name, , , iv, ib]) => ({ name, ready: !(iv & (1 << ib)) })),
      };
    }
    async function freeze() {
      const b = hexBytes(await send('0202'));
      let i = 0; while (i < b.length - 1 && !(b[i] === 0x42 && b[i + 1] === 0x02)) i++;
      const raw = b.slice(i + 2);
      const hasFrame = raw.length >= 3;
      const dtcBytes = hasFrame ? raw.slice(1, 3) : raw.slice(0, 2);
      if (i >= b.length - 1 || dtcBytes.length < 2 || (!dtcBytes[0] && !dtcBytes[1])) return { dtc: null, values: [] };
      const values = [];
      for (const pid of ['0C', '0D', '05', '04', '06', '07', '0F', '0B', '11', '42']) {
        if (!PIDS[pid] && pid !== '07') continue;
        const r = hexBytes(await send('02' + pid + '00'));
        for (let j = 0; j < r.length - 2; j++) {
          if (r[j] === 0x42 && r[j + 1] === parseInt(pid, 16)) {
            const data = r.slice(j + 3);
            const def = pid === '07' ? ['Corr. LT bank1', '%', x => (x[0] - 128) * 100 / 128] : PIDS[pid];
            try { const v = def[2](data); if (Number.isFinite(v)) values.push({ pid, name: def[0], value: Math.round(v * 10) / 10, unit: def[1] }); } catch {}
            break;
          }
        }
      }
      return { dtc: dtc2(dtcBytes[0], dtcBytes[1]), values };
    }

    async function scanEcu([code, name, desc, tx, rx]) {
      await send('ATSH ' + tx); await send('ATFCSH ' + tx); await send('ATCRA ' + rx);
      const probe = await send('3E00', 1200).catch(() => '');
      if (!hexBytes(probe).length) return null;
      const ecu = { address: tx, rx, code, name, desc, reachable: true, part: null, sw: null, protocol: null, dtcs: [] };
      const p = udsPos(await send('22F187', 2000).catch(() => ''), 0x22);
      if (p) {
        ecu.protocol = 'UDS';
        ecu.part = asciiRuns(p.slice(2))[0] || null;
        const s = udsPos(await send('22F195', 2000).catch(() => ''), 0x22);
        ecu.sw = s ? asciiRuns(s.slice(2))[0] || null : null;
      } else {
        const k = udsPos(await send('2180', 2500).catch(() => ''), 0x21);
        if (k) { ecu.protocol = 'KWP'; const runs = asciiRuns(k.slice(1)); ecu.part = runs[0] || null; ecu.sw = runs[1] || null; }
      }
      const u = udsPos(await send('1902AF', 3000).catch(() => ''), 0x19);
      if (u) {
        ecu.protocol = ecu.protocol || 'UDS';
        for (let i = 2; i + 3 < u.length; i += 4) {
          const [h, m, l, st] = u.slice(i, i + 4);
          if (!h && !m && !l) continue;
          ecu.dtcs.push({ code: dtc2(h, m), type: l.toString(16).toUpperCase().padStart(2, '0'), active: !!(st & 1) });
        }
      } else {
        let k = udsPos(await send('17FF00', 3000).catch(() => ''), 0x17);
        if (!k) { await send('10C0').catch(() => ''); k = udsPos(await send('17FF00', 3000).catch(() => ''), 0x17); }
        if (k) {
          ecu.protocol = ecu.protocol || 'KWP';
          for (let i = 1; i + 2 < k.length && ecu.dtcs.length < k[0]; i += 3) {
            const [h, l, st] = k.slice(i, i + 3);
            if (!h && !l) continue;
            ecu.dtcs.push({ code: dtc2(h, l), type: null, active: !!(st & 0x40) });
          }
        }
      }
      ecu.dtc_count = ecu.dtcs.length;
      return ecu;
    }
    async function resetBus() {
      for (const c of ['ATCRA', 'ATFCSM 0', 'ATSH 7DF']) await send(c).catch(() => '');
    }
    async function renaultScan(all, onProgress = () => {}) {
      const list = all ? ECUS : ECUS.filter(e => QUICK_TX.includes(e[3]));
      const found = [];
      scanning = true;
      if (liveBusy) await liveBusy.catch(() => {});
      await send('ATFCSD 300000').catch(() => ''); await send('ATFCSM 1').catch(() => '');
      try {
        for (let i = 0; i < list.length; i++) {
          onProgress({ index: i, total: list.length, current: list[i], found });
          const e = await scanEcu(list[i]).catch(() => null);
          if (e) { found.push(e); onProgress({ index: i, total: list.length, current: list[i], found, hit: e }); }
        }
      } finally { await resetBus(); scanning = false; }
      lastScan = { t: Date.now(), all, ecus: found };
      return lastScan;
    }
    async function clearEcu(tx) {
      const e = ECUS.find(r => r[3] === tx);
      if (!e) throw httpError(404, 'Calculateur inconnu');
      await send('ATSH ' + e[3]); await send('ATFCSH ' + e[3]); await send('ATCRA ' + e[4]);
      await send('ATFCSD 300000').catch(() => ''); await send('ATFCSM 1').catch(() => '');
      try {
        if (udsPos(await send('14FFFFFF', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'UDS' };
        if (udsPos(await send('14FF00', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'KWP' };
        await send('10C0').catch(() => '');
        if (udsPos(await send('14FF00', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'KWP' };
        throw httpError(502, 'Le calculateur a refusé l\'effacement (conditions non remplies ou défaut toujours présent).');
      } finally { await resetBus(); }
    }
    async function supportedPids() {
      if (supported) return supported;
      supported = new Set();
      for (const base of [0x00, 0x20, 0x40]) {
        const d = pidData(await send('01' + base.toString(16).toUpperCase().padStart(2, '0')), base);
        if (!d || d.length < 4) break;
        const mask = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
        for (let k = 0; k < 32; k++) if (mask & (1 << (31 - k))) supported.add((base + k + 1).toString(16).toUpperCase().padStart(2, '0'));
        if (!(mask & 1)) break;
      }
      return supported;
    }
    async function readPid(pid) {
      const def = PIDS[pid]; if (!def) return null;
      const d = pidData(await send('01' + pid), parseInt(pid, 16));
      if (!d || !d.length) return null;
      try { const v = def[2](d); return Number.isFinite(v) ? { pid, name: def[0], value: Math.round(v * 100) / 100, unit: def[1], min: def[3], max: def[4] } : null; }
      catch { return null; }
    }
    async function live(pids) {
      if (scanning) return [];
      if (liveBusy) return liveBusy;
      liveBusy = (async () => {
        const sup = await supportedPids();
        const out = [];
        for (const pid of pids) {
          const p = (!sup.size || sup.has(pid)) ? await readPid(pid) : null;
          if (p) { out.push(p); continue; }
          if (pid === '42') {
            const v = parseFloat(String(await send('ATRV')).replace(/[^0-9.]/g, ''));
            if (v) out.push({ pid: '42', name: PIDS['42'][0], value: v, unit: 'V', min: 9, max: 16 });
          }
        }
        return out;
      })();
      try { return await liveBusy; } finally { liveBusy = null; }
    }
    async function targeted(addr, cmd) {
      await send('ATSH ' + addr);
      try { return await send(cmd); } finally { await send('ATSH 7DF'); }
    }
    async function withHeaders(cmd) {
      await send('ATH1');
      try { return await send(cmd); } finally { await send('ATH0'); }
    }

    async function handle(path, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const route = path.split('?')[0];
      if (route === '/live/parameters') return live(wanted());
      if (route === '/live/supported') return [...(await supportedPids())].filter(p => PIDS[p]);
      if (route === '/diagnostics/monitors') return monitors();
      if (route === '/diagnostics/freeze') return freeze();
      if (route === '/diagnostics/dtc' && method === 'DELETE') { await send('04'); return { status: 'cleared' }; }
      if (route === '/diagnostics/dtc') {
        const stored = parseDtcs(await send('03'), 0x43), pending = parseDtcs(await send('07'), 0x47), perm = parseDtcs(await send('0A'), 0x4A);
        const codes = [
          ...perm.map(code => ({ code, severity: 'active' })),
          ...pending.filter(c => !perm.includes(c)).map(code => ({ code, severity: 'pending' })),
          ...stored.filter(c => !perm.includes(c) && !pending.includes(c)).map(code => ({ code, severity: 'stored' })),
        ].map(c => ({ ...c, description: '', ecu_name: 'Injection moteur (OBD)', ecu: '7E0' }));
        for (const e of (lastScan ? lastScan.ecus : [])) {
          for (const d of e.dtcs) {
            if (codes.some(c => c.code === d.code && c.ecu === e.address)) continue;
            codes.push({ code: d.code, severity: d.active ? 'active' : 'stored', ecu_name: e.name, ecu: e.address, description: d.type ? `Type de défaut ${d.type}` : '' });
          }
        }
        return { codes, total_active: codes.filter(c => c.severity === 'active').length, total_pending: pending.length, total_stored: stored.length };
      }
      if (route === '/vehicle/vin') {
        let vin = parseVin(await send('0902', 6000)), source = 'OBD mode 09';
        if (!vin) { vin = parseVin(await targeted('7E0', '22F190')); source = 'UDS 22 F190'; }
        if (!vin) throw httpError(404, 'VIN non lisible sur ce véhicule');
        return { vin, source };
      }
      if (route === '/ecu/list' && lastScan) {
        return lastScan.ecus.map(e => ({ address: e.address, name: e.name, reachable: true, dtc_count: e.dtc_count, part: e.part, sw: e.sw, protocol: e.protocol, rx: e.rx }));
      }
      if (route === '/ecu/list') {
        const responders = Object.keys(byHeader(await withHeaders('0100'))).sort();
        const dtcRaw = byHeader(await withHeaders('03'));
        return responders.map(h => {
          const addr = (parseInt(h, 16) - 8).toString(16).toUpperCase();
          const codes = parseDtcs((dtcRaw[h] || []).map(x => x.toString(16).padStart(2, '0')).join(' '), 0x43);
          return { address: addr, name: OBD_NAMES[h] || 'Calculateur ' + addr, reachable: true, dtc_count: codes.length };
        });
      }
      if (route === '/vehicle/odometer-check') {
        const u16 = d => d && d.length >= 2 ? d[0] * 256 + d[1] : null;
        const distClear = u16(pidData(await send('0131'), 0x31));
        const warm = (pidData(await send('0130'), 0x30) || [null])[0];
        const distMil = u16(pidData(await send('0121'), 0x21));
        const ecus = [];
        for (const [h, d] of Object.entries(byHeader(await withHeaders('01A6'))).sort()) {
          for (let i = 0; i + 5 < d.length; i++) {
            if (d[i] === 0x41 && d[i + 1] === 0xA6) {
              const addr = (parseInt(h, 16) - 8).toString(16).toUpperCase();
              ecus.push({ address: addr, name: OBD_NAMES[h] || 'Calculateur ' + addr, km: Math.round(((d[i + 2] * 2 ** 24) + (d[i + 3] << 16) + (d[i + 4] << 8) + d[i + 5]) / 10), odometer: false });
              break;
            }
          }
        }
        return { dist_since_clear: distClear, warmups: warm, dist_mil: distMil, ecus,
          notes: ecus.length ? [] : ["Aucun calculateur ne fournit le kilométrage OBD standard (PID A6, surtout sur véhicules récents). Saisissez le kilométrage du compteur pour comparer."] };
      }
      if (route.startsWith('/actuators') || route.startsWith('/coding') || route === '/services/run') {
        throw httpError(501, "Bloqué par sécurité : les tests actifs, procédures et codages Renault demandent la base de commandes constructeur (DDT, fichier ecu.zip), absente d'AUTORYX. Sans elle, une commande approximative pourrait dérégler un calculateur. Lecture, scan et effacement des codes restent disponibles.");
      }
      if (route === '/ecu/scan') return renaultScan(!!(opts.all), opts.onProgress);
      if (route === '/ecu/clear') {
        const r = await clearEcu(opts.address);
        if (lastScan) { const e = lastScan.ecus.find(x => x.address === opts.address); if (e) { e.dtcs = []; e.dtc_count = 0; } }
        return r;
      }
      if (route === '/connection/status') return { connected: true };
      throw httpError(404, 'Fonction non disponible en Bluetooth direct');
    }
    handle.reset = () => { supported = null; lastScan = null; liveBusy = null; scanning = false; };
    handle.lastScan = () => lastScan;
    handle.ecuCount = () => ECUS.length;
    handle.quickCount = () => ECUS.filter(e => QUICK_TX.includes(e[3])).length;
    return handle;
  }

  // ── Web Bluetooth transport ─────────────────────────────────────────
  const full = short => `0000${short}-0000-1000-8000-00805f9b34fb`;
  const SERVICES = [full('fff0'), full('ffe0'), full('18f0'), full('ae30'), 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
  const NAME_PREFIXES = ['OBD', 'obd', 'V-LINK', 'Vlink', 'IOS', 'iOS', 'ELM', 'Vgate', 'VEEPEAK', 'Android', 'KONNWEI', 'BLE'];
  const link = { device: null, rx: null, tx: null, buf: '', pending: null, chain: Promise.resolve(), onLost: null, log: [], gen: 0 };

  function onData(e) {
    link.buf += new TextDecoder().decode(e.target.value);
    const k = link.buf.indexOf('>');
    if (k >= 0 && link.pending) {
      const text = link.buf.slice(0, k);
      link.buf = link.buf.slice(k + 1);
      const p = link.pending; link.pending = null; p.resolve(text);
    } else if (k >= 0) {
      link.buf = link.buf.slice(k + 1);
    }
  }
  async function writeRaw(text) {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (link.tx.properties.writeWithoutResponse && link.tx.writeValueWithoutResponse) await link.tx.writeValueWithoutResponse(chunk);
      else await link.tx.writeValue(chunk);
    }
  }
  function send(cmd, timeout = 4000) {
    const gen = link.gen;
    const run = async () => {
      if (gen !== link.gen || !link.tx) throw httpError(409, 'Boîtier non connecté');
      link.buf = '';
      const answer = new Promise((resolve, reject) => {
        const t = setTimeout(() => { link.pending = null; reject(httpError(504, `Pas de réponse du boîtier à ${cmd}`)); }, timeout);
        link.pending = { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
      });
      await writeRaw(cmd + '\r');
      const raw = (await answer).replace(new RegExp('^\\s*' + cmd.replace(/\s/g, '\\s*') + '\\s*', 'i'), '').trim();
      link.log.push(`${cmd} → ${raw}`); if (link.log.length > 200) link.log.shift();
      return raw;
    };
    const p = link.chain.then(run, run);
    link.chain = p.catch(() => {});
    return p;
  }
  function note(text) { link.log.push(`[${new Date().toLocaleTimeString('fr-FR')}] ${text}`); if (link.log.length > 200) link.log.shift(); }
  async function connect(onStep = () => {}) {
    const step = t => { note(t); onStep(t); };
    if (!navigator.bluetooth) throw new Error("Bluetooth indisponible dans ce navigateur. Sur iPhone, ouvrez AUTORYX dans l'app Bluefy ; sur Android, dans Chrome.");
    try { note('Bluetooth disponible : ' + (navigator.bluetooth.getAvailability ? await navigator.bluetooth.getAvailability() : 'inconnu')); } catch (e) { note('getAvailability : ' + e.message); }
    step('Ouverture de la liste des appareils Bluetooth…');
    // Browsers differ on what they accept (Bluefy rejected short numeric UUIDs): try the widest request first, then narrower ones.
    const attempts = [
      { acceptAllDevices: true, optionalServices: SERVICES },
      { filters: [...SERVICES.map(s => ({ services: [s] })), ...NAME_PREFIXES.map(p => ({ namePrefix: p }))], optionalServices: SERVICES },
      { acceptAllDevices: true },
    ];
    let device = null;
    for (let i = 0; i < attempts.length && !device; i++) {
      try { device = await navigator.bluetooth.requestDevice(attempts[i]); }
      catch (e) {
        note(`Demande ${i + 1}/${attempts.length} refusée : ${e.name} ${e.message}`);
        if (e.name === 'NotFoundError' && !/parse|invalid|type/i.test(e.message)) throw e;
        if (i === attempts.length - 1) throw e;
      }
    }
    step('Appareil choisi : ' + (device.name || 'sans nom') + '. Connexion…');
    const gatt = await device.gatt.connect();
    step('Connecté au boîtier, recherche du canal série…');
    let rx = null, tx = null;
    const services = await gatt.getPrimaryServices();
    note('Services trouvés : ' + (services.map(s => s.uuid).join(', ') || 'aucun'));
    for (const s of services) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch (e) { note(`Service ${s.uuid} illisible : ${e.message}`); continue; }
      note(`Service ${s.uuid} : ` + chars.map(c => `${c.uuid}[${['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(p => c.properties[p]).join('+')}]`).join(' '));
      const n = chars.find(c => c.properties.notify || c.properties.indicate);
      const w = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
      if (n && w) { rx = n; tx = w; break; }
    }
    if (!rx || !tx) { gatt.disconnect(); throw new Error("Ce boîtier n'expose pas de canal série Bluetooth reconnu (voir le journal)."); }
    note(`Canal série : réception ${rx.uuid}, envoi ${tx.uuid}`);
    await rx.startNotifications();
    try { rx.removeEventListener('characteristicvaluechanged', onData); } catch {}
    rx.addEventListener('characteristicvaluechanged', onData);
    const myGen = ++link.gen;
    device.addEventListener('gattserverdisconnected', () => { if (myGen !== link.gen) return; drop(); if (link.onLost) link.onLost(); });
    Object.assign(link, { device, rx, tx, buf: '', pending: null });
    onStep("Initialisation de l'ELM327");
    const version = await send('ATZ', 5000).catch(() => '');
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATAT1', 'ATSP0']) await send(c).catch(() => {});
    onStep('Détection du protocole du véhicule');
    await send('0100', 10000);
    const proto = await send('ATDP').catch(() => '');
    return { name: device.name || 'ELM327', version: version.replace(/\s+/g, ' ').trim(), protocol: proto };
  }
  // Ends the session: queued commands of the old session fail at once instead of reaching the next one.
  function drop() {
    link.gen++;
    if (link.pending) { const p = link.pending; link.pending = null; p.reject && p.reject(httpError(409, 'Connexion fermée')); }
    try { link.rx && link.rx.removeEventListener('characteristicvaluechanged', onData); } catch {}
    link.tx = null; link.rx = null; link.buf = '';
  }
  function disconnect() {
    const dev = link.device;
    drop();
    try { dev && dev.gatt.connected && dev.gatt.disconnect(); } catch {}
  }

  return { connect, disconnect, send, link, note, createEngine, hexBytes, pidData, byHeader, parseVin, parseDtcs, PIDS };
})();
if (typeof module !== 'undefined') module.exports = ObdBle;
