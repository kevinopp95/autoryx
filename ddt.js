// AUTORYX · reading a DDT4all ECU description (from a vehicle pack imported by the user).
// Bit layout follows DDT4all (core/ecu/ecu_data.py): firstbyte is 1-based over the whole response,
// bitoffset counts from the most significant bit in big endian, from the least significant one in little endian.
const Ddt = (() => {
  const hx = a => a.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  const fromHex = h => (String(h).match(/../g) || []).map(x => parseInt(x, 16));
  const bin = bytes => bytes.map(b => b.toString(2).padStart(8, '0')).join('');

  function layout(item, data, ecuEndian) {
    const bits = data.bitscount || 8, start = item.bitoffset || 0;
    const little = item.endian ? item.endian === 'Little' : ecuEndian === 'Little';
    return { sb: (item.firstbyte || 1) - 1, start, bits, little, reqLen: Math.ceil((bits + start) / 8), single: bits + start <= 8 };
  }
  // Raw integer value (BigInt) of a data item in a response, or null when the response is too short.
  function getRaw(resp, item, data, ecuEndian) {
    const L = layout(item, data, ecuEndian);
    if (L.sb + Math.ceil(L.bits / 8) > resp.length) return null;
    const chunk = resp.slice(L.sb, L.sb + L.reqLen);
    if (!chunk.length) return null;
    const b = bin(chunk);
    let s;
    if (!L.little) s = b.slice(L.start, L.start + L.bits);
    else if (L.single) s = b.slice(8 - L.start - L.bits, 8 - L.start);
    else s = bin(chunk.slice().reverse()).slice(-(L.bits + L.start), L.start ? -L.start : undefined); // plain little endian
    return s ? BigInt('0b' + s) : null;
  }
  function display(raw, data) {
    if (raw == null) return null;
    const bytes = Math.ceil((data.bitscount || 8) / 8);
    if (data.bytesascii) {
      const h = raw.toString(16).padStart(bytes * 2, '0');
      return fromHex(h).map(c => (c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '')).join('').trim();
    }
    let v = Number(raw);
    if (data.signed && bytes <= 2) { const lim = 2 ** (8 * bytes); if (v >= lim / 2) v -= lim; }
    if (!data.scaled) {
      if (data.lists && data.lists[String(v)] != null) return data.lists[String(v)];
      return raw.toString(16).toUpperCase().padStart(bytes * 2, '0');
    }
    const div = data.divideby || 1;
    const res = (v * (data.step ?? 1) + (data.offset || 0)) / div;
    const dec = data.format && data.format.includes('.') ? data.format.split('.')[1].length : (Number.isInteger(res) ? 0 : 2);
    return res.toFixed(dec).replace('.', ',') + (data.unit ? ' ' + data.unit : '');
  }
  // Writes a raw value into a byte array (copy returned). Returns null when the layout is not one AUTORYX may write.
  function setRaw(bytes, item, data, ecuEndian, raw) {
    const L = layout(item, data, ecuEndian);
    if (L.little && !L.single) return null;
    if (L.sb + L.reqLen > bytes.length) return null;
    const v = BigInt(raw);
    if (v < 0n || v >= (1n << BigInt(L.bits))) return null;
    const out = bytes.slice();
    const chunk = bin(out.slice(L.sb, L.sb + L.reqLen)).split('');
    const vb = v.toString(2).padStart(L.bits, '0');
    const at = L.little ? 8 - L.start - L.bits : L.start;
    for (let i = 0; i < L.bits; i++) chunk[at + i] = vb[i];
    const s = chunk.join('');
    for (let k = 0; k < L.reqLen; k++) out[L.sb + k] = parseInt(s.slice(k * 8, k * 8 + 8), 2);
    return out;
  }
  function decodeAll(ecu, req, resp) {
    const out = [];
    for (const [name, item] of Object.entries(req.receivebyte_dataitems || {})) {
      const data = ecu.data[name]; if (!data) continue;
      const raw = getRaw(resp, item, data, ecu.endian);
      out.push({ name, raw: raw == null ? null : raw.toString(), text: display(raw, data), unit: data.unit || '', list: data.lists || null, comment: data.comment || '' });
    }
    return out;
  }

  // ── Identification (same rules as DDT4all's scanner) ──
  const ascii = a => a.map(c => String.fromCharCode(c)).join('');
  // bytes: full positive answer to 21 80, starting with 0x61.
  function identKwp(b) {
    if (!b || b[0] !== 0x61) return null;
    const h = (i, n) => hx(b.slice(i, i + n));
    if (b.length > 20) return { diag: String(b[7]), supplier: ascii(b.slice(8, 11)), soft: h(16, 2), version: h(18, 2) };
    if (b.length > 7) return { diag: String(b[2]), supplier: ascii(b.slice(3, 6)), soft: h(6, 3), version: h(9, 3) };
    return null;
  }
  function identUds(f1a0, f18a, f194, f195) {
    const clean = a => ascii((a || []).filter(c => c !== 0xFF && c !== 0x00)).trim();
    if (!f1a0 || !f1a0.length) return null;
    return { diag: String(f1a0[0]), supplier: clean(f18a), soft: clean(f194), version: ascii((f195 || []).slice(0, 16)).replace(/[\x00\xFF]/g, '').trim() };
  }
  function exact(a, id) {
    if (!a.diagnostic_version) return false;
    if (parseInt(a.diagnostic_version, 16) !== parseInt(id.diag, 16)) return false;
    const p = (x, y) => { x = String(x || '').trim(); return x === String(y || '').trim().slice(0, x.length); };
    return p(a.supplier_code, id.supplier) && p(a.soft_version, id.soft) && p(a.version, id.version);
  }
  // Picks the ECU file for an address and an identification. kind: 'exact' | 'approx' | 'guess'.
  function match(pack, address, id) {
    const cands = Object.entries(pack.ecus).filter(([, e]) => e.address === address);
    if (!cands.length) return null;
    if (id) {
      for (const [name, e] of cands) if (e.autoidents.some(a => exact(a, id))) return { name, kind: 'exact' };
      let best = null, gap = Infinity;
      for (const [name, e] of cands) for (const a of e.autoidents) {
        if (String(a.supplier_code).trim() !== id.supplier.trim() || String(a.soft_version).trim() !== id.soft.trim()) continue;
        const d = Math.abs(parseInt(a.version, 16) - parseInt(id.version, 16));
        if (Number.isFinite(d) && d < gap) { gap = d; best = name; }
      }
      if (best) return { name: best, kind: 'approx' };
    }
    return { name: null, kind: 'guess', options: cands.map(([n]) => n) };
  }

  // ── What a file offers ──
  const sid = r => (r.sentbytes || '').slice(0, 2).toUpperCase();
  const BLOCK_NAME = /reset|init|apprent|learn|virgin|vierge|erase|effac|program|flash|download|upload|codage|coding|\bvin\b|key|clé|cle\b|badge|immo|secur|calib|sécur|recopie|transfer|eeprom|default|usine|plant/i;
  function catalogue(ecu) {
    const reads = ecu.requests.filter(r => ['21', '22'].includes(sid(r)) && Object.keys(r.receivebyte_dataitems || {}).length && !Object.keys(r.sendbyte_dataitems || {}).length);
    const writes = [];
    for (const w of ecu.requests.filter(r => ['3B', '2E'].includes(sid(r)))) {
      const items = Object.keys(w.sendbyte_dataitems || {});
      if (!items.length || BLOCK_NAME.test(w.name)) continue;
      const lid = w.sentbytes.slice(2, sid(w) === '3B' ? 4 : 6);
      const rd = reads.find(r => r.sentbytes.slice(2) === lid && sid(r) === (sid(w) === '3B' ? '21' : '22') && items.every(n => n in r.receivebyte_dataitems));
      if (!rd) continue;
      const editable = items.filter(n => { const d = ecu.data[n]; return d && d.lists && Object.keys(d.lists).length >= 2 && !d.bytesascii; });
      if (editable.length) writes.push({ write: w, read: rd, editable });
    }
    // "Write one bit / one byte" requests (Clio III UCH style): a selector lists the configuration names,
    // each one is read back through the read request that carries a data item of the same name.
    for (const w of ecu.requests.filter(r => sid(r) === '3B' && !BLOCK_NAME.test(r.name))) {
      const items = Object.entries(w.sendbyte_dataitems || {});
      if (items.length !== 2) continue;
      const [[selName], [valName]] = items;
      const sel = ecu.data[selName], val = ecu.data[valName];
      if (!sel || !sel.lists || !val || val.lists) continue;
      const width = val.bitscount || 8;
      const options = [];
      for (const [key, name] of Object.entries(sel.lists)) {
        const d = ecu.data[name];
        // a bit selector writes one bit; any other selector writes the whole value, so the item must fill it exactly
        const bits = d && (d.bitscount || 8);
        if (!d || !d.lists || d.bytesascii || (/\bbit\b/i.test(selName) ? bits !== 1 : bits !== width)) continue;
        const rd = reads.find(r => name in r.receivebyte_dataitems);
        if (rd) options.push({ key: Number(key), name, read: rd });
      }
      if (options.length) writes.push({ indexed: true, write: w, selName, valName, options });
    }
    // Tests: list-valued parameters are chosen by the user, every other byte keeps the file's template.
    const tests = ecu.requests.filter(r => ['30', '2F'].includes(sid(r)) && !BLOCK_NAME.test(r.name) && !/stop|status|etat|état/i.test(r.name))
      .map(r => ({ req: r, stop: ecu.requests.find(s => s !== r && sid(s) === sid(r) && /stop/i.test(s.name) && s.sentbytes.slice(2, 4) === r.sentbytes.slice(2, 4)) || null }));
    return { reads, writes, tests };
  }
  // Builds the bytes of a request from its template and chosen raw values (name → raw).
  function build(ecu, req, values = {}) {
    let bytes = fromHex(req.sentbytes);
    for (const [name, item] of Object.entries(req.sendbyte_dataitems || {})) {
      if (!(name in values)) continue;
      const next = setRaw(bytes, item, ecu.data[name] || {}, ecu.endian, values[name]);
      if (!next) throw new Error(`Encodage non pris en charge pour « ${name} »`);
      bytes = next;
    }
    return bytes;
  }
  // Values of a write request taken from the matching read response, then the change applied.
  function planWrite(ecu, w, readResp, changeName, changeRaw) {
    const values = {};
    for (const [name, wi] of Object.entries(w.write.sendbyte_dataitems)) {
      const ri = w.read.receivebyte_dataitems[name];
      const raw = getRaw(readResp, ri, ecu.data[name] || {}, ecu.endian);
      if (raw == null) throw new Error(`Valeur actuelle de « ${name} » illisible : écriture bloquée`);
      values[name] = raw;
    }
    const before = { ...values };
    values[changeName] = BigInt(changeRaw);
    return { bytes: build(ecu, w.write, values), before, values };
  }
  async function readJson(blob) {
    let text;
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] === 0x1F && head[1] === 0x8B) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Ce navigateur ne sait pas décompresser le fichier (.gz).');
      text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = await blob.text();
    return JSON.parse(text);
  }
  async function unpack(blob) {
    const pack = await readJson(blob);
    if (!/^autoryx-ddt-pack\/[12]$/.test(pack.format || '') || !pack.ecus) throw new Error('Ce fichier n\'est pas une base AUTORYX.');
    return pack;
  }
  // Full description of one ECU file (format 2 keeps each file compressed until it is needed).
  async function def(pack, name) {
    const e = pack && pack.ecus[name];
    if (!e) return null;
    if (e.requests) return e;
    const b64 = pack.files && pack.files[name];
    if (!b64) return null;
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    Object.assign(e, JSON.parse(text));
    delete pack.files[name];
    return e;
  }
  return { readJson, def, hx, fromHex, getRaw, display, setRaw, decodeAll, identKwp, identUds, match, catalogue, build, planWrite, unpack, sid, BLOCK_NAME };
})();
if (typeof module !== 'undefined') module.exports = Ddt;
