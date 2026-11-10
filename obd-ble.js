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

  function createEngine(send, wanted = () => Object.keys(PIDS)) {
    let supported = null;
    let liveBusy = null;
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

    return async function handle(path, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const route = path.split('?')[0];
      if (route === '/live/parameters') return live(wanted());
      if (route === '/diagnostics/dtc' && method === 'DELETE') { await send('04'); return { status: 'cleared' }; }
      if (route === '/diagnostics/dtc') {
        const stored = parseDtcs(await send('03'), 0x43), pending = parseDtcs(await send('07'), 0x47), perm = parseDtcs(await send('0A'), 0x4A);
        const codes = [
          ...perm.map(code => ({ code, severity: 'active' })),
          ...pending.filter(c => !perm.includes(c)).map(code => ({ code, severity: 'pending' })),
          ...stored.filter(c => !perm.includes(c) && !pending.includes(c)).map(code => ({ code, severity: 'stored' })),
        ].map(c => ({ ...c, description: '', ecu_name: '' }));
        return { codes, total_active: perm.length, total_pending: pending.length, total_stored: stored.length };
      }
      if (route === '/vehicle/vin') {
        let vin = parseVin(await send('0902', 6000)), source = 'OBD mode 09';
        if (!vin) { vin = parseVin(await targeted('7E0', '22F190')); source = 'UDS 22 F190'; }
        if (!vin) throw httpError(404, 'VIN non lisible sur ce véhicule');
        return { vin, source };
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
        throw httpError(501, "Pas encore disponible en Bluetooth direct : les commandes constructeur de ce véhicule ne sont pas vérifiées. Lecture seule pour l'instant.");
      }
      if (route === '/connection/status') return { connected: true };
      throw httpError(404, 'Fonction non disponible en Bluetooth direct');
    };
  }

  // ── Web Bluetooth transport ─────────────────────────────────────────
  const SERVICES = [0xfff0, 0xffe0, 0x18f0, 0xae30, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
  const link = { device: null, rx: null, tx: null, buf: '', pending: null, chain: Promise.resolve(), onLost: null, log: [] };

  function onData(e) {
    link.buf += new TextDecoder().decode(e.target.value);
    const k = link.buf.indexOf('>');
    if (k >= 0 && link.pending) {
      const text = link.buf.slice(0, k);
      link.buf = link.buf.slice(k + 1);
      const p = link.pending; link.pending = null; p.resolve(text);
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
    const run = async () => {
      if (!link.tx) throw httpError(409, 'Boîtier non connecté');
      link.buf = '';
      const answer = new Promise((resolve, reject) => {
        const t = setTimeout(() => { link.pending = null; reject(httpError(504, `Pas de réponse du boîtier à ${cmd}`)); }, timeout);
        link.pending = { resolve: v => { clearTimeout(t); resolve(v); } };
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
  async function connect(onStep = () => {}) {
    if (!navigator.bluetooth) throw new Error("Bluetooth indisponible dans ce navigateur. Sur iPhone, ouvrez AUTORYX dans l'app Bluefy ; sur Android, dans Chrome.");
    onStep('Choisissez votre boîtier dans la liste');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    onStep('Connexion au boîtier ' + (device.name || ''));
    const gatt = await device.gatt.connect();
    let rx = null, tx = null;
    for (const s of await gatt.getPrimaryServices()) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch { continue; }
      const n = chars.find(c => c.properties.notify || c.properties.indicate);
      const w = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
      if (n && w) { rx = n; tx = w; break; }
    }
    if (!rx || !tx) { gatt.disconnect(); throw new Error("Ce boîtier n'expose pas de canal série Bluetooth reconnu."); }
    await rx.startNotifications();
    rx.addEventListener('characteristicvaluechanged', onData);
    device.addEventListener('gattserverdisconnected', () => { link.tx = null; link.rx = null; if (link.onLost) link.onLost(); });
    Object.assign(link, { device, rx, tx, buf: '', pending: null, chain: Promise.resolve() });
    onStep("Initialisation de l'ELM327");
    const version = await send('ATZ', 5000).catch(() => '');
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATAT1', 'ATSP0']) await send(c).catch(() => {});
    onStep('Détection du protocole du véhicule');
    await send('0100', 10000);
    const proto = await send('ATDP').catch(() => '');
    return { name: device.name || 'ELM327', version: version.replace(/\s+/g, ' ').trim(), protocol: proto };
  }
  function disconnect() { try { link.device && link.device.gatt.connected && link.device.gatt.disconnect(); } catch {} link.tx = null; link.rx = null; }

  return { connect, disconnect, send, link, createEngine, hexBytes, pidData, byHeader, parseVin, parseDtcs, PIDS };
})();
if (typeof module !== 'undefined') module.exports = ObdBle;
