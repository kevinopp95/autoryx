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

  const NRC = { 0x11: 'service non supporté', 0x12: 'fonction non supportée', 0x13: 'longueur incorrecte', 0x22: 'conditions non remplies', 0x31: 'valeur hors plage', 0x33: 'accès sécurisé requis', 0x78: 'en cours' };
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
  const hx = a => a.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  const dtc2 = (hi, lo) => DTC_LETTER[hi >> 6] + ((hi >> 4) & 3) + (hi & 15).toString(16).toUpperCase() + lo.toString(16).toUpperCase().padStart(2, '0');
  const ECUS = typeof RENAULT_ECUS !== 'undefined' ? RENAULT_ECUS : (typeof require === 'function' ? (() => { try { return require('./renault-ecus.js'); } catch { return []; } })() : []);
  const UCH = { tx: '745', rx: '765', kind: 'kwp' }, TDB = { tx: '743', rx: '763', kind: 'uds', post: '1103' };
  const UPC = { tx: '74D', rx: '76D', kind: 'uds' }, EPB = { tx: '755', rx: '775', kind: 'uds' }, CLIM = { tx: '744', rx: '764', kind: 'kwp' };
  const byte = (on, off, test) => ({ len: 1, on: () => [on], off: off == null ? null : () => [off], isOn: c => (test ? test(c[0]) : c[0] === on) });
  const SETTINGS = [
    { id: 'tpms', group: 'Sécurité', title: 'Surveillance pression des pneus', desc: 'Alerte de sous-gonflage au tableau de bord. À désactiver seulement si la voiture n\'a pas de capteurs dans les roues.',
      parts: [{ ...UCH, ident: '24', ...byte(0x80, 0x00, v => !!(v & 0x80)) }, { ...TDB, ident: '010E', ...byte(0x10, 0x00, v => !!(v & 0x10)) }] },
    { id: 'washer', group: 'Éclairage', title: 'Lave-phares', desc: 'Les lave-phares fonctionnent avec le lave-glace, feux allumés.',
      parts: [{ ...UCH, ident: '52', ...byte(0x01, 0x00) }] },
    { id: 'epb_auto', group: 'Conduite', title: 'Serrage auto du frein de parking', desc: 'Le frein de parking se serre seul à l\'arrêt du moteur. Le type de boîte enregistré n\'est pas modifié.',
      parts: [{ ...EPB, ident: '0217', len: 2, on: c => [0x00, c[1]], off: c => [0x01, c[1]], isOn: c => c[0] === 0x00 }] },
    { id: 'ss_off', group: 'Conduite', title: 'Start & Stop coupé par défaut', desc: 'Le moteur ne se coupe plus aux arrêts.',
      parts: [{ ...UPC, ident: '0752', ...byte(0x01, 0x00) }] },
    { id: 'ss_hide', group: 'Conduite', title: 'Masquer l\'alerte Start & Stop', desc: 'Cache le message « Start & Stop indisponible ».',
      parts: [{ ...UPC, ident: '0763', ...byte(0x00, 0x01) }] },
    { id: 'clock', group: 'Tableau de bord', title: 'Horloge 24 h au tableau de bord', desc: 'Affiche l\'heure au format 24 h. Le tableau de bord redémarre une seconde après l\'écriture.',
      parts: [{ ...TDB, ident: '0121', ...byte(0x20, 0x00) }] },
    { id: 'ext_temp', group: 'Tableau de bord', title: 'Température extérieure', desc: 'Affiche la température extérieure. Le tableau de bord redémarre une seconde après l\'écriture.',
      parts: [{ ...TDB, ident: '0122', ...byte(0x10, null) }] },
    { id: 'air_quality', group: 'Climatisation', title: 'Gestion qualité de l\'air désactivée', desc: 'Pour une clim sans capteur de pollution : supprime les recyclages automatiques.',
      parts: [{ ...CLIM, ident: '0B', ...byte(0x01, null) }, { ...CLIM, ident: '12', ...byte(0x01, null) }] },
    { id: 'ptc', group: 'Climatisation', title: 'Chauffage électrique additionnel', desc: 'Lecture seule : configuration enregistrée dans la climatisation.', readOnly: true,
      parts: [{ ...CLIM, ident: '04' }],
      decode: ([d]) => ({ 0x00: 'Non configuré', 0x01: 'Sans chauffage additionnel', 0x10: 'Chauffage 1 kW', 0x16: 'Chauffage 1,6 kW', 0x18: 'Chauffage 1,8 kW' })[d[0]] || `Valeur ${hx2(d[0])} non répertoriée` },
  ];
  const hx2 = b => (b ?? 0).toString(16).toUpperCase().padStart(2, '0');
  // Brand family from the VIN (world manufacturer identifier).
  function brandOf(vin) {
    if (!vin) return 'unknown';
    const w = String(vin || '').toUpperCase().slice(0, 3);
    if (['VF1', 'UU1', 'VF6', 'VF8', 'X7L', 'UU3'].includes(w) || w === 'VFA') return 'renault';
    if (['VF3', 'VF7', 'VR3', 'VR7', 'VR1', 'VXK', 'VXE', 'VXF'].includes(w)) return 'psa';
    if (['WVW', 'WV1', 'WV2', 'WV3', 'WAU', 'WUA', 'TRU', 'TMB', 'VSS', 'VS6', 'WP0', 'WP1'].includes(w)) return 'vag';
    return 'generic';
  }
  const hex3 = n => n.toString(16).toUpperCase().padStart(3, '0');
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const OBD_PAIRS = range(0x7E0, 0x7E7).map(t => [t, t + 8]);
  const GENERIC_NAMES = { 0x7E0: 'Moteur', 0x7E1: 'Boîte de vitesses', 0x7E2: 'Calculateur hybride / auxiliaire' };
  const VAG_NAMES = { 0x7E0: 'Moteur', 0x7E1: 'Boîte de vitesses', 0x713: 'ABS / ESP', 0x715: 'Airbag', 0x710: 'Passerelle', 0x714: 'Combiné d\'instruments', 0x70E: 'Électronique centrale', 0x712: 'Direction assistée', 0x746: 'Climatisation' };
  const PSA_NAMES = { 0x6A8: 'Moteur', 0x752: 'BSI (habitacle)' };
  const QUICK_GENERIC = [0x7B0, 0x7C0, 0x7A0, 0x7D0, 0x7D1, 0x7D2, 0x726, 0x760, 0x720, 0x737, 0x770, 0x750, 0x7C6, 0x740, 0x744, 0x765, 0x7B1, 0x7C4, 0x784, 0x7A6];
  const QUICK_VAG = [0x713, 0x715, 0x710, 0x714, 0x70E, 0x712, 0x746, 0x74F, 0x711, 0x70C, 0x70A, 0x716, 0x717, 0x75C, 0x76C, 0x74C];
  // [code, name, description, tx, rx] like the Renault table; code is null outside Renault.
  function candidates(brand, all) {
    if (brand === 'renault') return all ? ECUS : ECUS.filter(e => QUICK_TX.includes(e[3]));
    if (brand === 'unknown') {   // VIN not read: every family, without duplicates
      const seen = new Set(), out = [];
      for (const b of ['renault', 'vag', 'psa', 'generic']) for (const r of candidates(b, all)) { const k = r[3]; if (!seen.has(k)) { seen.add(k); out.push(r); } }
      return out;
    }
    const row = (t, r, names) => [null, names[t] || 'Calculateur ' + hex3(t), '', hex3(t), hex3(r)];
    const pairs = [...OBD_PAIRS];
    let names = GENERIC_NAMES;
    if (brand === 'vag') {
      names = { ...GENERIC_NAMES, ...VAG_NAMES };
      const vag = all ? range(0x700, 0x795) : QUICK_VAG;
      vag.filter(t => !(t >= 0x7E0 && t <= 0x7E7)).forEach(t => pairs.push([t, t + 0x6A]));
    } else if (brand === 'psa') {
      names = { ...GENERIC_NAMES, ...PSA_NAMES };
      range(0x6A0, 0x6BF).forEach(t => pairs.push([t, t - 0x20]));
      (all ? range(0x740, 0x77F) : [0x752, 0x75F, 0x76D, 0x772, 0x75D, 0x764, 0x74C]).forEach(t => pairs.push([t, t - 0x100]));
    } else {
      (all ? range(0x700, 0x7DF) : QUICK_GENERIC).filter(t => !(t >= 0x7E0 && t <= 0x7E7)).forEach(t => pairs.push([t, t + 8]));
    }
    return pairs.map(([t, r]) => row(t, r, names));
  }
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

    // Mode 06 (CAN): on-board test results. Each record: test id, unit/scaling id, value, min, max.
    const MID_NAMES = { 0x01: 'Sonde O2 amont B1', 0x02: 'Sonde O2 aval B1', 0x05: 'Sonde O2 amont B2', 0x06: 'Sonde O2 aval B2', 0x21: 'Catalyseur B1', 0x22: 'Catalyseur B2',
      0x31: 'EGR / VVT B1', 0x32: 'EGR / VVT B2', 0x35: 'Pression de suralimentation', 0x39: 'EVAP fuite 0,150"', 0x3A: 'EVAP fuite 0,090"', 0x3B: 'EVAP fuite 0,040"', 0x3C: 'EVAP fuite 0,020"', 0x3D: 'Électrovanne de purge',
      0x41: 'Chauffage sonde O2 amont B1', 0x42: 'Chauffage sonde O2 aval B1', 0x45: 'Chauffage sonde O2 amont B2', 0x46: 'Chauffage sonde O2 aval B2', 0x61: 'Filtre à particules B1', 0x62: 'Filtre à particules B2',
      0x71: 'Air secondaire 1', 0x81: 'Système carburant B1', 0x82: 'Système carburant B2', 0x85: 'Pression de suralimentation B1', 0x90: 'NOx B1', 0x98: 'Capteur gaz d\'échappement B1',
      0xA1: 'Ratés : général', 0xA2: 'Ratés : cylindre 1', 0xA3: 'Ratés : cylindre 2', 0xA4: 'Ratés : cylindre 3', 0xA5: 'Ratés : cylindre 4', 0xA6: 'Ratés : cylindre 5', 0xA7: 'Ratés : cylindre 6', 0xB0: 'Particules (PM) B1' };
    const UAS = { 0x01: [1, ''], 0x02: [0.1, ''], 0x03: [0.01, ''], 0x04: [0.001, ''], 0x07: [0.25, 'tr/min'], 0x09: [1, 'km/h'], 0x0A: [0.122, 'mV'], 0x0B: [0.001, 'V'], 0x0C: [0.01, 'V'],
      0x0E: [0.001, 'A'], 0x10: [1, 'ms'], 0x11: [100, 'ms'], 0x12: [1, 's'], 0x14: [1, 'Ω'], 0x16: [0.1, '°C', -40], 0x17: [0.01, 'kPa'], 0x1A: [1, 'kPa'], 0x1C: [0.01, '°'], 0x1E: [0.0000305, ''],
      0x20: [0.0039062, ''], 0x22: [1, 'Hz'], 0x24: [1, ''], 0x25: [1, 'km'], 0x27: [0.01, 'g/s'], 0x2F: [0.01, '%'], 0x34: [1, 'min'], 0x35: [10, 'ms'],
      0x81: [1, '', 0, true], 0x82: [0.1, '', 0, true], 0x83: [0.01, '', 0, true], 0x84: [0.001, '', 0, true], 0x8A: [0.122, 'mV', 0, true], 0x8B: [0.001, 'V', 0, true], 0x8C: [0.01, 'V', 0, true],
      0x8E: [0.001, 'A', 0, true], 0x90: [1, 'ms', 0, true], 0x96: [0.1, '°C', 0, true], 0x9C: [0.01, '°', 0, true], 0xAF: [0.01, '%', 0, true], 0xFC: [0.01, 'kPa', 0, true], 0xFD: [0.001, 'kPa', 0, true] };
    async function mode06() {
      const mids = [];
      for (let base = 0; base <= 0xE0; base += 0x20) {
        const b = hexBytes(await send('06' + hx([base]), 3000).catch(() => ''));
        const i = b.findIndex((x, k) => x === 0x46 && b[k + 1] === base);
        if (i < 0 || b.length < i + 6) { if (!base) throw httpError(404, 'Ce véhicule ne fournit pas les tests embarqués (mode 06).'); break; }
        const mask = ((b[i + 2] << 24) | (b[i + 3] << 16) | (b[i + 4] << 8) | b[i + 5]) >>> 0;
        for (let k = 0; k < 31; k++) if (mask & (1 << (31 - k))) mids.push(base + k + 1);
        if (!(mask & 1)) break;
      }
      const tests = [];
      for (const mid of mids) {
        const b = hexBytes(await send('06' + hx([mid]), 3000).catch(() => ''));
        for (let i = 0; i + 1 < b.length; i++) {
          if (b[i] !== 0x46 || b[i + 1] !== mid) continue;
          let j = i + 2;
          while (j + 8 <= b.length) {
            const [tid, uas, v1, v2, n1, n2, x1, x2] = b.slice(j, j + 8);
            if (tid === 0x46 && uas === mid) { j += 2; continue; }   // next frame header of a multi-line answer
            const u = UAS[uas] || [1, ''], signed = u[3];
            const num = (h, l) => { let r = h * 256 + l; if (signed && r >= 0x8000) r -= 0x10000; return r; };
            const val = num(v1, v2), min = num(n1, n2), max = num(x1, x2);
            const sc = r => Math.round((r * u[0] + (u[2] || 0)) * 1000) / 1000;
            tests.push({ mid, tid, name: (MID_NAMES[mid] || 'Moniteur ' + hx([mid])) + (tid ? ' · test ' + hx([tid]) : ''), value: sc(val), min: sc(min), max: sc(max), unit: u[1], pass: val >= min && val <= max });
            j += 8;
          }
          break;
        }
      }
      return { tests };
    }

    async function scanEcu([code, name, desc, tx, rx], brand = 'renault') {
      const renault = brand === 'renault';
      await send('ATSH ' + tx); await send('ATFCSH ' + tx); await send('ATCRA ' + rx);
      await send('ATST 19').catch(() => '');               // short wait while probing absent addresses (~100 ms)
      const probe = await send('3E00', 1200).catch(() => '');
      await send('ATST 32').catch(() => '');
      const pb = hexBytes(probe);
      if (!pb.length || !(pb[0] === 0x7E || pb[0] === 0x7F)) return null;
      const ecu = { address: tx, rx, code, name, desc, brand, reachable: true, part: null, sw: null, protocol: null, dtcs: [] };
      const p = udsPos(await send('22F187', 2000).catch(() => ''), 0x22);
      if (p) {
        ecu.protocol = 'UDS';
        ecu.part = asciiRuns(p.slice(2))[0] || null;
        const s = udsPos(await send('22F195', 2000).catch(() => ''), 0x22);
        const did = async c => { const r = udsPos(await send(c, 2000).catch(() => ''), 0x22); return r ? hx(r.slice(2)) : ''; };
        ecu.identRaw = { f1a0: await did('22F1A0'), f18a: await did('22F18A'), f194: await did('22F194'), f195: s ? hx(s.slice(2)) : '' };
        ecu.sw = s ? asciiRuns(s.slice(2))[0] || null : null;
        if (!renault) {
          const sysName = udsPos(await send('22F197', 2000).catch(() => ''), 0x22);
          const label = sysName ? asciiRuns(sysName.slice(2))[0] : null;
          if (label && /^Calculateur /.test(ecu.name)) ecu.name = label.replace(/\s+/g, ' ').trim();
          const hw = udsPos(await send('22F191', 2000).catch(() => ''), 0x22);
          ecu.hw = hw ? asciiRuns(hw.slice(2))[0] || null : null;
        }
      } else if (renault) {
        const k = udsPos(await send('2180', 2500).catch(() => ''), 0x21);
        if (k) { ecu.protocol = 'KWP'; ecu.identRaw = { kwp: '61' + hx(k) }; const runs = asciiRuns(k.slice(1)); ecu.part = runs[0] || null; ecu.sw = runs[1] || null; }
      }
      let u = udsPos(await send(renault ? '1902AF' : '1902FF', 3000).catch(() => ''), 0x19);
      if (!u && !renault) { await send('1003', 2000).catch(() => ''); u = udsPos(await send('1902FF', 3000).catch(() => ''), 0x19); }
      if (u) {
        ecu.protocol = ecu.protocol || 'UDS';
        for (let i = 2; i + 3 < u.length; i += 4) {
          const [h, m, l, st] = u.slice(i, i + 4);
          if (!h && !m && !l) continue;
          ecu.dtcs.push({ code: dtc2(h, m), type: l.toString(16).toUpperCase().padStart(2, '0'), raw: (h << 16) | (m << 8) | l, st, active: !!(st & 1) });
        }
      } else if (renault) {
        let k = udsPos(await send('17FF00', 3000).catch(() => ''), 0x17);
        if (!k) { await send('10C0').catch(() => ''); k = udsPos(await send('17FF00', 3000).catch(() => ''), 0x17); }
        if (k) {
          ecu.protocol = ecu.protocol || 'KWP';
          for (let i = 1; i + 2 < k.length && ecu.dtcs.length < k[0]; i += 3) {
            const [h, l, st] = k.slice(i, i + 3);
            if (!h && !l) continue;
            ecu.dtcs.push({ code: dtc2(h, l), type: null, raw: (h << 8) | l, st, active: !!(st & 0x20) });
          }
        }
      }
      ecu.dtc_count = ecu.dtcs.length;
      return ecu;
    }
    async function resetBus() {
      for (const c of ['ATCRA', 'ATFCSM 0', 'ATSH 7DF']) await send(c).catch(() => '');
    }
    async function renaultScan(all, onProgress = () => {}, brand = 'renault') {
      const list = candidates(brand, all);
      const found = [];
      scanning = true;
      if (liveBusy) await liveBusy.catch(() => {});
      await send('ATFCSD 300000').catch(() => ''); await send('ATFCSM 1').catch(() => '');
      try {
        for (let i = 0; i < list.length; i++) {
          onProgress({ index: i, total: list.length, current: list[i], found });
          const e = await scanEcu(list[i], brand === 'unknown' ? (list[i][0] ? 'renault' : 'generic') : brand).catch(() => null);
          if (e) { found.push(e); onProgress({ index: i, total: list.length, current: list[i], found, hit: e }); }
        }
      } finally { await resetBus(); scanning = false; }
      lastScan = { t: Date.now(), all, brand, ecus: found };
      return lastScan;
    }
    async function clearEcu(tx) {
      const found = lastScan && lastScan.ecus.find(x => x.address === tx);
      const e = found ? [found.code, found.name, '', found.address, found.rx] : ECUS.find(r => r[3] === tx);
      if (!e) throw httpError(404, 'Calculateur inconnu');
      const renault = !found || found.brand === 'renault' || !found.brand;
      await send('ATSH ' + e[3]); await send('ATFCSH ' + e[3]); await send('ATCRA ' + e[4]);
      await send('ATFCSD 300000').catch(() => ''); await send('ATFCSM 1').catch(() => '');
      try {
        if (udsPos(await send('14FFFFFF', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'UDS' };
        if (!renault) {
          await send('1003', 2000).catch(() => '');
          if (udsPos(await send('14FFFFFF', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'UDS' };
          throw httpError(502, 'Le calculateur a refusé l\'effacement (conditions non remplies ou défaut toujours présent).');
        }
        if (udsPos(await send('14FF00', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'KWP' };
        await send('10C0').catch(() => '');
        if (udsPos(await send('14FF00', 4000).catch(() => ''), 0x14)) return { cleared: true, protocol: 'KWP' };
        throw httpError(502, 'Le calculateur a refusé l\'effacement (conditions non remplies ou défaut toujours présent).');
      } finally { await resetBus(); }
    }
    // ── Mégane III / Scénic III settings (X95, from the DDT4all community macros) ──
    // Every write: vehicle stopped, fresh read, value must match the backup the app saved, exact record length,
    // write, read back. Anything unexpected stops before writing.
    async function talk(tx, rx) {
      await send('ATSH ' + tx); await send('ATFCSH ' + tx); await send('ATCRA ' + rx);
      await send('ATFCSD 300000').catch(() => ''); await send('ATFCSM 1').catch(() => '');
    }
    async function openSession() {
      if (!udsPos(await send('10C0', 3000).catch(() => ''), 0x10)) throw httpError(502, 'Le calculateur refuse la session de diagnostic (contact mis ?).');
    }
    async function readPart(part) {
      const kwp = part.kind === 'kwp';
      const raw = await send((kwp ? '21' : '22') + part.ident, 3000).catch(() => '');
      const r = udsPos(raw, kwp ? 0x21 : 0x22);
      const idLen = part.ident.length / 2;
      if (!r || hx(r.slice(0, idLen)) !== part.ident) throw httpError(502, `Lecture impossible (${kwp ? '21' : '22'}${part.ident}) : ce réglage n'existe pas sur ce calculateur.`);
      const data = r.slice(idLen);
      if (part.len && data.length !== part.len) throw httpError(409, `Format inattendu pour ${part.ident} (${data.length} octet(s) au lieu de ${part.len}) : écriture bloquée.`);
      return data;
    }
    async function writePart(part, data) {
      const kwp = part.kind === 'kwp';
      const r = udsPos(await send((kwp ? '3B' : '2E') + part.ident + hx(data), 4000).catch(() => ''), kwp ? 0x3B : 0x2E);
      if (!r) throw httpError(502, 'Le calculateur a refusé l\'écriture. Rien n\'a été modifié.');
    }
    async function vehicleStopped() {
      const d = pidData(await send('010D').catch(() => ''), 0x0D);
      if (d && d[0] > 0) throw httpError(409, 'Véhicule en mouvement : arrêtez-vous, moteur coupé, contact mis.');
    }
    function findSetting(id) {
      const s = SETTINGS.find(x => x.id === id);
      if (!s) throw httpError(404, 'Réglage inconnu');
      return s;
    }
    async function settingRead(id) {
      const s = findSetting(id);
      scanning = true; if (liveBusy) await liveBusy.catch(() => {});
      try {
        const parts = [];
        for (const p of s.parts) {
          await talk(p.tx, p.rx); await openSession();
          parts.push(hx(await readPart(p)));
          await resetBus();
        }
        const bytes = parts.map(h => hexBytes(h));
        return { id, parts, on: s.readOnly ? null : s.parts.every((p, k) => p.isOn(bytes[k])), info: s.decode ? s.decode(bytes) : null };
      } finally { await resetBus(); scanning = false; }
    }
    async function settingWrite(id, target, expect, restoreTo = null) {
      const s = findSetting(id);
      if (s.readOnly) throw httpError(400, 'Réglage en lecture seule');
      if (!Array.isArray(expect) || expect.length !== s.parts.length) throw httpError(400, 'Sauvegarde manquante : relisez le réglage avant de le modifier.');
      scanning = true; if (liveBusy) await liveBusy.catch(() => {});
      const done = [];
      try {
        await vehicleStopped();
        for (let k = 0; k < s.parts.length; k++) {
          const p = s.parts[k];
          await talk(p.tx, p.rx); await openSession();
          const cur = await readPart(p);
          if (target !== 'restore' && hx(cur) !== expect[k]) throw httpError(409, 'La valeur a changé depuis la lecture : relisez le réglage.');
          const want = target === 'restore' ? hexBytes(restoreTo[k] || '') : target === 'on' ? p.on(cur) : p.off ? p.off(cur) : null;
          if (!want || want.length !== cur.length) throw httpError(400, target === 'off' && !p.off ? 'Pas de valeur « désactivé » connue : utilisez « Restaurer l\'origine ».' : 'Valeur cible invalide.');
          if (hx(want) !== hx(cur)) {
            await writePart(p, want);
            const back = await readPart(p);
            if (hx(back) !== hx(want)) throw httpError(502, `Écrit mais la relecture diffère (${hx(back)} au lieu de ${hx(want)}).`);
            if (p.post) await send(p.post, 3000).catch(() => '');
          }
          done.push({ ident: p.ident, before: hx(cur), after: hx(want) });
          await resetBus();
        }
        return { id, verified: true, done };
      } finally { await resetBus(); scanning = false; }
    }
    async function settingRestore(id, backup) {
      const s = findSetting(id);
      if (!Array.isArray(backup) || backup.length !== s.parts.length) throw httpError(400, 'Aucune sauvegarde pour ce réglage.');
      return settingWrite(id, 'restore', backup, backup);
    }

    // ── Requests from the vehicle pack (DDT). The engine keeps its own guard list, whatever the screen asks. ──
    const NO_WRITE = ['7E0', '740', '752', '7E1', '742', '7E2'];   // engine, ABS, airbag, gearboxes, power steering
    const NO_TEST = ['752', '740'];                                  // airbag (pyrotechnics), ABS
    const ALLOWED = { read: ['21', '22'], write: ['3B', '2E'], test: ['30', '2F'] };
    async function engineOff() {
      await vehicleStopped();
      const r = pidData(await send('010C').catch(() => ''), 0x0C);
      if (r && r.length >= 2 && (r[0] * 256 + r[1]) / 4 > 200) throw httpError(409, 'Moteur tournant : coupez le moteur et laissez le contact mis.');
    }
    async function ddtSend({ tx, rx, bytes, kind, kwp }) {
      const e = ECUS.find(r => r[3] === tx && r[4] === rx);
      if (!e) throw httpError(404, 'Calculateur inconnu');
      const sid = String(bytes || '').slice(0, 2).toUpperCase();
      if (!/^[0-9A-F]+$/i.test(bytes || '') || bytes.length % 2 || !(ALLOWED[kind] || []).includes(sid)) throw httpError(400, `Commande ${sid} refusée par AUTORYX`);
      if (kind === 'write' && NO_WRITE.includes(tx)) throw httpError(403, `Écriture bloquée sur « ${e[1]} » : calculateur de sécurité ou moteur.`);
      if (kind === 'test' && NO_TEST.includes(tx)) throw httpError(403, `Tests bloqués sur « ${e[1]} ».`);
      scanning = true; if (liveBusy) await liveBusy.catch(() => {});
      try {
        if (kind !== 'read') await engineOff();
        await talk(tx, rx);
        const isKwp = kwp != null ? kwp : ['21', '3B', '30'].includes(sid);
        let ok = udsPos(await send(isKwp ? '10C0' : '1003', 3000).catch(() => ''), 0x10);
        if (!ok && !isKwp) ok = udsPos(await send('10C0', 3000).catch(() => ''), 0x10);
        if (!ok && kind !== 'read') throw httpError(502, 'Le calculateur refuse la session de diagnostic.');
        const raw = await send(bytes.toUpperCase(), 5000).catch(() => '');
        let b = hexBytes(raw);
        while (b[0] === 0x7F && b[2] === 0x78) b = b.slice(3);   // "response pending" frames
        if (b[0] === 0x7F) throw httpError(502, `Refusé par le calculateur (code ${hx([b[2] || 0])}${NRC[b[2]] ? ' : ' + NRC[b[2]] : ''}).`);
        if (!b.length) throw httpError(504, 'Pas de réponse du calculateur.');
        if (kind === 'test') testOn = true;
        return { bytes: hx(b) };
      } finally {
        // a running test keeps its header and session (and the live loop stays paused) until /ddt/stop
        if (!testOn) { await resetBus(); scanning = false; }
      }
    }
    let testOn = false;
    async function ddtKeepAlive() { if (testOn) await send('3E00', 2000).catch(() => ''); return { running: testOn }; }
    async function ddtStop({ tx, rx, bytes }) {
      scanning = true; if (liveBusy) await liveBusy.catch(() => {});
      try {
        await talk(tx, rx);
        if (bytes && /^(30|2F)/i.test(bytes)) await send(bytes.toUpperCase(), 3000).catch(() => '');
        await send('1081', 3000).catch(() => '');   // back to the default session: the ECU takes its outputs back
        return { stopped: true };
      } finally { testOn = false; await resetBus(); scanning = false; }
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
      if (route === '/diagnostics/mode06') return mode06();
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
            codes.push({ code: d.code, severity: d.active ? 'active' : 'stored', ecu_name: e.name, ecu: e.address, description: d.label || (d.type ? `Type de défaut ${d.type}` : '') });
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
        return lastScan.ecus.map(e => ({ address: e.address, name: e.name, reachable: true, dtc_count: e.dtc_count, part: e.part, sw: e.sw, hw: e.hw || null, protocol: e.protocol, rx: e.rx, code: e.code, brand: e.brand, identRaw: e.identRaw || null }));
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
        throw httpError(501, "En Bluetooth direct, les tests, procédures et configurations passent par la base constructeur : Scan complet, puis « Ouvrir » sur un calculateur.");
      }
      if (route === '/ecu/scan') return renaultScan(!!(opts.all), opts.onProgress, opts.brand || brandOf(opts.vin));
      if (route === '/ecu/clear') {
        const r = await clearEcu(opts.address);
        if (lastScan) { const e = lastScan.ecus.find(x => x.address === opts.address); if (e) { e.dtcs = []; e.dtc_count = 0; } }
        return r;
      }
      if (route === '/renault/settings') return SETTINGS.map(x => ({ id: x.id, group: x.group, title: x.title, desc: x.desc, readOnly: !!x.readOnly, canOff: x.parts.every(p => p.off), ecus: [...new Set(x.parts.map(p => p.tx))] }));
      if (route === '/renault/settings/read') return settingRead(opts.id);
      if (route === '/renault/settings/write') return settingWrite(opts.id, opts.target, opts.expect);
      if (route === '/renault/settings/restore') return settingRestore(opts.id, opts.backup);
      if (route === '/ddt/send') return ddtSend(opts);
      if (route === '/ddt/stop') return ddtStop(opts);
      if (route === '/ddt/keepalive') return ddtKeepAlive();
      if (route === '/connection/status') return { connected: true };
      throw httpError(404, 'Fonction non disponible en Bluetooth direct');
    }
    handle.reset = () => { testOn = false; supported = null; lastScan = null; liveBusy = null; scanning = false; };
    handle.lastScan = () => lastScan;
    handle.ecuCount = () => ECUS.length;
    handle.quickCount = () => ECUS.filter(e => QUICK_TX.includes(e[3])).length;
    handle.candidates = (brand, all) => candidates(brand, all);
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

  return { brandOf, connect, disconnect, send, link, note, createEngine, hexBytes, pidData, byHeader, parseVin, parseDtcs, PIDS };
})();
if (typeof module !== 'undefined') module.exports = ObdBle;
