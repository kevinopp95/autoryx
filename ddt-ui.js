// AUTORYX · manufacturer screens built from the vehicle pack (DDT). Needs Bluetooth direct.
const DdtUi = (() => {
  let pack = null, packInfo = null, cur = null;   // cur: { ecu (scan entry), file, def, cat, tab }
  const results = {};                              // request name → decoded items
  let testTimer = null, testRun = null;
  const backups = (() => { try { return JSON.parse(localStorage.getItem('autoryx_ddt_backup') || '{}') || {}; } catch { return {}; } })();
  const saveBackups = () => { try { localStorage.setItem('autoryx_ddt_backup', JSON.stringify(backups)); } catch {} };
  const MODEL_NAMES = { x85: 'Clio III', x95: 'Mégane III / Scénic III', x84: 'Mégane II / Scénic II', x65: 'Clio II', x98: 'Clio IV', x44: 'Twingo II', x61: 'Kangoo II', x91: 'Laguna III', x87: 'Captur', x07: 'Twingo III', x52: 'Dacia Logan / Sandero', x10: 'Zoé' };
  const nice = n => String(n).replace(/^CF_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const vinKey = () => (typeof _vehicle !== 'undefined' && _vehicle && _vehicle.vin) || 'vehicule';

  // ── pack storage (IndexedDB, this phone only) ──
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('autoryx', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbPut(key, val) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function idbGet(key) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

  const wantedProject = () => (typeof _vehicle !== 'undefined' && _vehicle && _vehicle.project) || null;
  async function loadCodes() {
    try { const blob = await idbGet('dtcpack'); if (blob) { const j = await Ddt.readJson(blob); if (j.format === 'autoryx-dtc-pack/1') globalThis.DTC_LOCAL = j.codes; } } catch {}
  }
  async function listStored() { try { return (await idbGet('packs')) || []; } catch { return []; } }
  async function loadStored() {
    const want = wantedProject();
    if (pack && (!want || pack.project === want)) return pack;
    try {
      const list = await listStored();
      const key = want && list.includes(want) ? want : list[0];
      const blob = key ? await idbGet('pack_' + key) : await idbGet('pack');   // 'pack' = first version, before several models
      if (blob) { pack = await Ddt.unpack(blob); packInfo = { project: pack.project, count: pack.count, list }; }
    } catch (e) { ObdBle.note('Base constructeur illisible : ' + e.message); }
    return pack;
  }
  async function importFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    try {
      const head = await Ddt.readJson(f);
      if (head.format === 'autoryx-dtc-pack/1') {
        await idbPut('dtcpack', f);
        globalThis.DTC_LOCAL = head.codes;
        toast(`${head.count} libellés de codes défaut importés`);
        input.value = ''; renderPackPanel(); return;
      }
      const p = await Ddt.unpack(f);
      if (typeof _vehicle !== 'undefined' && _vehicle && _vehicle.project && _vehicle.project !== p.project) toast(`Attention : base ${MODEL_NAMES[p.project] || p.project}, alors que le VIN indique ${MODEL_NAMES[_vehicle.project] || _vehicle.project}.`, 7000);
      await idbPut('pack_' + p.project, f);
      const list = [...new Set([...(await listStored()), p.project])];
      await idbPut('packs', list);
      pack = p; packInfo = { project: p.project, count: p.count, list };
      toast(`Base ${p.project.toUpperCase()} importée : ${p.count} calculateurs`);
    } catch (e) { toast('Import impossible : ' + e.message, 7000); }
    input.value = '';
    renderPackPanel();
    if (typeof _lastScan !== 'undefined' && _lastScan) renderModules(_lastScan);
  }
  function renderPackPanel() {
    const el = document.getElementById('packPanel'); if (!el) return;
    el.hidden = false;
    const want = wantedProject();
    const mismatch = packInfo && want && packInfo.project !== want;
    el.innerHTML = `<div class="panel-h"><span class="panel-t">Base constructeur</span><span class="panel-sub push">${packInfo ? `${(MODEL_NAMES[packInfo.project] || packInfo.project.toUpperCase())} · ${packInfo.count} calculateurs${packInfo.list && packInfo.list.length > 1 ? ` · ${packInfo.list.length} modèles importés` : ''}` : 'non importée'}</span></div>
      ${mismatch ? `<p class="panel-sub" style="margin:0 0 12px;color:var(--warn)">Cette base ne correspond pas au modèle lu dans le VIN (${esc(MODEL_NAMES[want] || want)}). Importez le fichier de ce modèle.</p>` : ''}
      <p class="panel-sub" style="margin:0 0 12px">${packInfo ? 'Après un scan, ouvrez un calculateur pour lire ses mesures, sa configuration et lancer ses tests.' : 'Importez le fichier préparé sur le PC (par exemple autoryx-clio3.json) pour débloquer mesures constructeur, configuration et tests actifs.'}</p>
      ${globalThis.DTC_LOCAL ? `<p class="panel-sub" style="margin:0 0 12px">Libellés de codes défaut : ${Object.keys(globalThis.DTC_LOCAL).length} codes importés.</p>` : ''}
      <label class="btn btn-soft sm" style="cursor:pointer">${svgI('file')}${packInfo ? 'Importer un fichier' : 'Importer la base'}<input type="file" accept=".gz,.json,application/gzip,application/json" hidden onchange="DdtUi.importFile(this)"></label>`;
  }

  // ── ECU screen ──
  function identOf(e) {
    const r = e.identRaw; if (!r) return null;
    if (r.kwp) return Ddt.identKwp(Ddt.fromHex(r.kwp));
    return Ddt.identUds(Ddt.fromHex(r.f1a0 || ''), Ddt.fromHex(r.f18a || ''), Ddt.fromHex(r.f194 || ''), Ddt.fromHex(r.f195 || ''));
  }
  async function open(address, tab = 'read') {
    if (!bleMode) { toast('Disponible en Bluetooth direct, boîtier connecté'); return; }
    if (!(await loadStored())) { toast('Importez d\'abord la base constructeur'); return; }
    const e = _lastScan && _lastScan.ecus.find(x => x.address === address);
    if (!e) return;
    const id = identOf(e);
    const m = Ddt.match(pack, e.code, id);
    if (!m) { toast(`Aucune fiche pour « ${e.name} » dans la base ${pack.project.toUpperCase()}`); return; }
    const saved = (() => { try { return localStorage.getItem('autoryx_ddt_file_' + e.code); } catch { return null; } })();
    const file = m.name || (saved && m.options.includes(saved) ? saved : null);
    cur = { ecu: e, id, match: m, file, tab };
    if (file) await select(file);
    stopLoops();
    showScreen('ecu');
    render();
  }
  async function select(file) {
    cur.file = file; cur.def = await Ddt.def(pack, file); cur.cat = Ddt.catalogue(cur.def);
    for (const k of Object.keys(results)) delete results[k];
    if (cur.match.kind === 'guess') try { localStorage.setItem('autoryx_ddt_file_' + cur.ecu.code, file); } catch {}
  }
  async function choose(file) { if (!file) return; await select(file); render(); }
  function tab(t) { cur.tab = t; render(); }

  async function send(bytes, kind) {
    return Ddt.fromHex((await api('/ddt/send', { tx: cur.ecu.address, rx: cur.ecu.rx, bytes: Ddt.hx(bytes), kind })).bytes);
  }
  async function readReq(name) {
    const r = cur.def.requests.find(x => x.name === name);
    const resp = await send(Ddt.fromHex(r.sentbytes), 'read');
    results[name] = { t: new Date().toLocaleTimeString('fr-FR'), items: Ddt.decodeAll(cur.def, r, resp), resp };
    return resp;
  }
  let busy = false;
  async function run(fn) {
    if (busy) { toast('Une communication est déjà en cours'); return; }
    busy = true; render();
    try { await fn(); } catch (e) { toast(e.message, 7000); } finally { busy = false; render(); }
  }
  const readOne = name => run(() => readReq(name));
  const readAll = () => run(async () => { for (const r of cur.cat.reads) { try { await readReq(r.name); } catch {} render(); } });

  // configuration: plain write (the read gives every value, one item changes)
  const armed = {};
  function arm(key, text) {
    if (armed[key] && Date.now() - armed[key] < 5000) { delete armed[key]; return true; }
    armed[key] = Date.now(); toast(text + ' Appuyez encore pour confirmer. Moteur coupé, contact mis.', 5000); return false;
  }
  function backupKey(item, file) { return `${vinKey()}|${file || (cur && cur.file) || 'proc'}|${item}`; }
  function remember(item, raw, file) { const k = backupKey(item, file); if (!(k in backups)) { backups[k] = String(raw); saveBackups(); } }
  async function applyPlain(wIndex, item, sel) {
    const w = cur.cat.writes[wIndex], newRaw = sel.value;
    if (!arm('w' + wIndex + item, `Changer « ${nice(item)} » ?`)) return;
    await run(async () => {
      const resp = await readReq(w.read.name);
      const plan = Ddt.planWrite(cur.def, w, resp, item, newRaw);
      remember(item, plan.before[item]);
      await send(plan.bytes, 'write');
      const back = await readReq(w.read.name);
      for (const [name, v] of Object.entries(plan.values)) {
        const got = Ddt.getRaw(back, w.read.receivebyte_dataitems[name], cur.def.data[name] || {}, cur.def.endian);
        if (got !== BigInt(v)) throw new Error(`Écrit, mais la relecture de « ${nice(name)} » diffère. Vérifiez puis restaurez l'origine.`);
      }
      toast(`${nice(item)} : modifié et vérifié`);
    });
  }
  async function applyIndexed(wIndex, oIndex, sel, restore) {
    const w = cur.cat.writes[wIndex], o = w.options[oIndex];
    const newRaw = restore ? backups[backupKey(o.name)] : sel.value;
    if (newRaw == null) return;
    if (!arm('i' + wIndex + '_' + oIndex + (restore ? 'r' : ''), restore ? `Remettre « ${nice(o.name)} » à l'origine ?` : `Changer « ${nice(o.name)} » ?`)) return;
    await run(async () => {
      const resp = await readReq(o.read.name);
      const item = o.read.receivebyte_dataitems[o.name], data = cur.def.data[o.name];
      const before = Ddt.getRaw(resp, item, data, cur.def.endian);
      if (before == null) throw new Error('Valeur actuelle illisible : écriture bloquée');
      remember(o.name, before);
      const others = Ddt.decodeAll(cur.def, o.read, resp).filter(x => x.name !== o.name);
      await send(Ddt.build(cur.def, w.write, { [w.selName]: BigInt(o.key), [w.valName]: BigInt(newRaw) }), 'write');
      const back = await readReq(o.read.name);
      if (Ddt.getRaw(back, item, data, cur.def.endian) !== BigInt(newRaw)) throw new Error('Écrit, mais la relecture diffère. Vérifiez puis restaurez l\'origine.');
      const changed = Ddt.decodeAll(cur.def, o.read, back).filter(x => x.name !== o.name && others.find(y => y.name === x.name && y.raw !== x.raw));
      if (changed.length) throw new Error(`Attention : « ${nice(changed[0].name)} » a aussi changé. Restaurez l'origine.`);
      toast(`${nice(o.name)} : ${restore ? 'origine restaurée' : 'modifié et vérifié'}`);
    });
  }
  async function loadOption(wIndex, oIndex) { const o = cur.cat.writes[wIndex].options[oIndex]; await run(() => readReq(o.read.name)); }

  // tests
  async function startTest(i) {
    const t = cur.cat.tests[i];
    const values = {};
    document.querySelectorAll(`[data-test="${i}"]`).forEach(s => { values[s.name] = BigInt(s.value); });
    if (!arm('t' + i, `Lancer « ${t.req.name} » ?`)) return;
    await run(async () => {
      const bytes = Ddt.build(cur.def, t.req, values);
      await send(bytes, 'test');
      testRun = { i, values, until: Date.now() + 10000 };
      clearInterval(testTimer);
      testTimer = setInterval(async () => {
        if (!testRun) return clearInterval(testTimer);
        if (Date.now() > testRun.until) return stopTest();
        api('/ddt/keepalive', {}).catch(() => {});
        render();
      }, 2000);
      toast('Test lancé : arrêt automatique dans 10 s');
    });
  }
  async function stopTest() {
    clearInterval(testTimer);
    const r = testRun; testRun = null;
    if (!r) return;
    const t = cur.cat.tests[r.i];
    const stop = t.stop ? Ddt.hx(Ddt.build(cur.def, t.stop, Object.fromEntries(Object.entries(r.values).filter(([n]) => n in (t.stop.sendbyte_dataitems || {}))))) : '';
    try { await api('/ddt/stop', { tx: cur.ecu.address, rx: cur.ecu.rx, bytes: stop }); toast('Test arrêté'); } catch (e) { toast(e.message, 6000); }
    render();
  }

  function itemsTable(items) {
    return `<dl class="ddt-dl">${items.map(x => `<dt title="${esc(x.comment)}">${esc(nice(x.name))}</dt><dd>${esc(x.text == null ? '—' : x.text)}</dd>`).join('')}</dl>`;
  }
  function render() {
    const host = document.getElementById('ecuBody'); if (!host || !cur) return;
    const e = cur.ecu, m = cur.match;
    document.getElementById('ecuTitle').textContent = shortName(e.name);
    const id = cur.id;
    let h = `<section class="panel"><div class="panel-h"><span class="panel-t">Fiche utilisée</span><span class="chip ${m.kind === 'exact' ? 'ok' : 'warn'} push">${m.kind === 'exact' ? 'identification exacte' : m.kind === 'approx' ? 'version la plus proche' : 'à choisir'}</span></div>
      <p class="panel-sub" style="margin:0">${id ? `Fournisseur ${esc(id.supplier)} · diag ${esc(id.diag)} · logiciel ${esc(id.soft)} · version ${esc(id.version)}` : 'Identification non lue.'}</p>
      ${m.kind === 'guess' ? `<div class="field" style="margin-top:12px"><label for="ddtFile">Fiche du calculateur</label><select id="ddtFile" onchange="DdtUi.choose(this.value)"><option value="">Choisir…</option>${m.options.map(o => `<option ${o === cur.file ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
        <p class="panel-sub" style="margin:8px 0 0">L'identification ne correspond à aucune fiche : choisissez celle qui ressemble le plus à la référence du calculateur. Tant que la fiche n'est pas certaine, la configuration est bloquée.</p>` : `<p class="panel-sub mono" style="margin:6px 0 0">${esc(cur.file)}</p>`}</section>`;
    if (!cur.def) { host.innerHTML = h; return; }
    const c = cur.cat, canWrite = m.kind !== 'guess';
    h += `<div class="filter-chips" style="margin:14px 0"><button aria-pressed="${cur.tab === 'read'}" onclick="DdtUi.tab('read')">Mesures · ${c.reads.length}</button><button aria-pressed="${cur.tab === 'conf'}" onclick="DdtUi.tab('conf')">Configuration · ${c.writes.reduce((n, w) => n + (w.indexed ? w.options.length : w.editable.length), 0)}</button><button aria-pressed="${cur.tab === 'test'}" onclick="DdtUi.tab('test')">Tests · ${c.tests.length}</button></div>`;
    const dis = busy ? 'disabled' : '';
    if (cur.tab === 'read') {
      h += `<div style="margin-bottom:12px"><button class="btn btn-primary sm" ${dis} onclick="DdtUi.readAll()">${svgI('refresh')}Tout lire</button></div>` + c.reads.map(r => {
        const res = results[r.name];
        return `<article class="panel ddt-req"><div class="panel-h"><span class="panel-t">${esc(r.name)}</span><button class="btn btn-soft sm push" ${dis} onclick="DdtUi.readOne(${JSON.stringify(r.name).replace(/"/g, '&quot;')})">${res ? 'Relire' : 'Lire'}</button></div>${res ? itemsTable(res.items) : ''}</article>`;
      }).join('');
    } else if (cur.tab === 'conf') {
      if (!canWrite) h += `<div class="panel empty">Choisissez d'abord une fiche certaine.</div>`;
      else if (!c.writes.length) h += `<div class="panel empty">Aucune configuration modifiable en sécurité pour ce calculateur.</div>`;
      else h += `<section class="panel"><p class="panel-sub" style="margin:0">Moteur coupé, contact mis. Chaque valeur est lue, sauvegardée dans ce téléphone, écrite puis relue. La valeur d'origine reste disponible.</p></section>` + c.writes.map((w, wi) => {
        if (w.indexed) return w.options.map((o, oi) => {
          const res = results[o.read.name], x = res && res.items.find(i => i.name === o.name);
          const d = cur.def.data[o.name], bk = backups[backupKey(o.name)];
          return `<div class="coding-item mg-item"><div class="coding-info"><div class="coding-name">${esc(nice(o.name))}</div>${d.comment ? `<div class="coding-desc">${esc(d.comment)}</div>` : ''}
            <div class="mono" style="font-size:12px;color:var(--ink-3);margin-top:6px">${x ? 'Actuel : ' + esc(x.text) : 'Pas encore lu'}${bk != null ? ' · origine : ' + esc(d.lists[bk] || bk) : ''}</div></div>
            <div class="mg-acts">${!x ? `<button class="btn btn-soft sm" ${dis} onclick="DdtUi.loadOption(${wi},${oi})">Lire</button>` : `<select class="input" style="width:auto" id="ddt_${wi}_${oi}">${Object.entries(d.lists).map(([k, v]) => `<option value="${k}" ${String(k) === x.raw ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
              <button class="btn btn-primary sm" ${dis} onclick="DdtUi.applyIndexed(${wi},${oi},document.getElementById('ddt_${wi}_${oi}'))">Appliquer</button>
              ${bk != null && bk !== x.raw ? `<button class="btn btn-soft sm" ${dis} onclick="DdtUi.applyIndexed(${wi},${oi},null,true)">${svgI('undo')}Origine</button>` : ''}`}</div></div>`;
        }).join('');
        const res = results[w.read.name];
        return `<article class="panel ddt-req"><div class="panel-h"><span class="panel-t">${esc(w.write.name)}</span><button class="btn btn-soft sm push" ${dis} onclick="DdtUi.readOne(${JSON.stringify(w.read.name).replace(/"/g, '&quot;')})">${res ? 'Relire' : 'Lire'}</button></div>
          ${res ? w.editable.map(n => { const x = res.items.find(i => i.name === n), d = cur.def.data[n], sid = `ddtp_${wi}_${n.replace(/\W/g, '')}`, bk = backups[backupKey(n)];
            return `<div class="coding-item mg-item"><div class="coding-info"><div class="coding-name">${esc(nice(n))}</div><div class="mono" style="font-size:12px;color:var(--ink-3)">Actuel : ${esc(x ? x.text : '—')}${bk != null ? ' · origine : ' + esc(d.lists[bk] || bk) : ''}</div></div>
              <div class="mg-acts"><select class="input" style="width:auto" id="${sid}">${Object.entries(d.lists).map(([k, v]) => `<option value="${k}" ${x && String(k) === x.raw ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
              <button class="btn btn-primary sm" ${dis} onclick="DdtUi.applyPlain(${wi},${JSON.stringify(n).replace(/"/g, '&quot;')},document.getElementById('${sid}'))">Appliquer</button></div></div>`; }).join('') : ''}</article>`;
      }).join('');
    } else {
      if (!c.tests.length) h += `<div class="panel empty">Aucun test actif autorisé pour ce calculateur.</div>`;
      else h += `<section class="panel"><p class="panel-sub" style="margin:0">Moteur coupé, contact mis, personne près des pièces en mouvement. Un test s'arrête tout seul après 10 secondes.</p></section>` + c.tests.map((t, i) => {
        const running = testRun && testRun.i === i;
        const params = Object.keys(t.req.sendbyte_dataitems || {}).filter(n => cur.def.data[n] && cur.def.data[n].lists);
        return `<article class="panel ddt-req"><div class="panel-h"><span class="panel-t">${esc(t.req.name)}</span></div>
          ${params.map(n => `<div class="field" style="margin-bottom:10px"><label>${esc(nice(n))}</label><select class="input" data-test="${i}" name="${esc(n)}">${Object.entries(cur.def.data[n].lists).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>`).join('')}
          ${running ? `<button class="btn btn-dark sm" onclick="DdtUi.stopTest()">${svgI('stop')}Arrêter · ${Math.max(0, Math.ceil((testRun.until - Date.now()) / 1000))} s</button>`
            : `<button class="btn btn-primary sm" ${dis || (testRun ? 'disabled' : '')} onclick="DdtUi.startTest(${i})">${svgI('play')}Lancer</button>`}</article>`;
      }).join('');
    }
    host.innerHTML = h;
  }
  async function fileOf(e) {
    if (!pack || !e || !e.code) return null;
    const m = Ddt.match(pack, e.code, identOf(e));
    if (!m) return null;
    if (m.name) return { name: m.name, def: await Ddt.def(pack, m.name), kind: m.kind };
    try { const s = localStorage.getItem('autoryx_ddt_file_' + e.code); if (s && pack.ecus[s]) return { name: s, def: await Ddt.def(pack, s), kind: 'guess' }; } catch {}
    return null;
  }
  async function readByName(e, def, pattern) {
    const r = def.requests.find(x => /^2[12]/.test(x.sentbytes) && !Object.keys(x.sendbyte_dataitems || {}).length && Object.keys(x.receivebyte_dataitems || {}).some(n => pattern.test(n)));
    if (!r) return null;
    const resp = Ddt.fromHex((await api('/ddt/send', { tx: e.address, rx: e.rx, bytes: r.sentbytes, kind: 'read' })).bytes);
    const name = Object.keys(r.receivebyte_dataitems).find(n => pattern.test(n));
    const raw = Ddt.getRaw(resp, r.receivebyte_dataitems[name], def.data[name] || {}, def.endian);
    return raw == null ? null : Number(raw);
  }
  const ODO = /^Odom[eè]tre Total$|odom[eè]tre g[ée]n[ée]ral/i;
  // Odometer from the instrument cluster ("Odomètre Total"), when the pack knows it.
  async function readOdometer() {
    if (!bleMode || !(await loadStored()) || !_lastScan) return null;
    for (const e of _lastScan.ecus) {
      const f = await fileOf(e); if (!f || f.kind === 'guess') continue;
      if (!f.def.requests.some(x => Object.keys(x.receivebyte_dataitems || {}).some(n => ODO.test(n)))) continue;
      try { const km = await readByName(e, f.def, ODO); if (km != null && km > 0 && km < 2e6) return { km, source: shortName(e.name) }; } catch {}
    }
    return null;
  }
  // Tests actifs and Procédures screens, built from the pack.
  let _procRows = [];
  async function hub(kind, host) {
    if (!(await loadStored())) {
      host.innerHTML = `<section class="panel"><p class="panel-sub" style="margin:0 0 12px">Les ${kind === 'test' ? 'tests actifs' : 'procédures'} viennent de la base constructeur de votre modèle. Importez-la une fois depuis le Scan complet.</p><button class="btn btn-primary" onclick="showScreen('fullscan')">Aller au scan complet</button></section>`;
      return;
    }
    if (!_lastScan || !_lastScan.ecus.length) {
      host.innerHTML = `<section class="panel"><p class="panel-sub" style="margin:0 0 12px">Lancez d'abord un scan complet : AUTORYX identifie chaque calculateur et charge sa fiche.</p><button class="btn btn-primary" onclick="showScreen('fullscan');runFullScan()">Lancer le scan complet</button></section>`;
      return;
    }
    const rows = (await Promise.all(_lastScan.ecus.map(async e => ({ e, f: await fileOf(e) })))).filter(x => x.f);
    if (kind === 'test') {
      host.innerHTML = rows.map(({ e, f }) => {
        const t = Ddt.catalogue(f.def).tests;
        const blocked = ['752', '740'].includes(e.address);
        return `<div class="coding-item mg-item"><div class="coding-info"><div class="coding-name">${esc(shortName(e.name))}</div><div class="coding-desc">${blocked ? 'Tests bloqués par sécurité sur ce calculateur.' : t.length ? `${t.length} test${t.length > 1 ? 's' : ''} : ${esc(t.slice(0, 3).map(x => x.req.name).join(', '))}${t.length > 3 ? '…' : ''}` : 'Aucun test actif dans sa fiche.'}</div></div>
          <div class="mg-acts">${!blocked && t.length ? `<button class="btn btn-primary sm" onclick="DdtUi.open('${esc(e.address)}','test')">${svgI('play')}Ouvrir les tests</button>` : ''}</div></div>`;
      }).join('') || '<div class="panel empty">Aucun calculateur identifié dans la base.</div>';
      return;
    }
    const procs = [];
    for (const { e, f } of rows) for (const p of PROCS) if (f.kind !== 'guess' && p.applies(f.def, e)) procs.push({ p, e, f });
    _procRows = procs;
    host.innerHTML = (procs.length ? procs.map(({ p, e }, i) => `<article class="panel ddt-req"><div class="panel-h"><span class="panel-t">${esc(p.title)}</span><span class="chip push">${esc(shortName(e.name))}</span></div>
        <p class="panel-sub" style="margin:0">${esc(p.desc)}</p><div id="procOut_${i}"></div>
        <div><button class="btn btn-primary sm" onclick="DdtUi.runProc(${i})">${svgI('play')}${esc(p.action)}</button></div></article>`).join('')
      : '<div class="panel empty">Aucune procédure disponible pour les calculateurs identifiés.</div>')
      + `<section class="panel"><p class="panel-sub" style="margin:0">Volontairement non proposés : calibrations de direction, purge ABS, airbag, apprentissages de clés et d'injecteurs. Une erreur sur ces systèmes touche à la sécurité ; ils restent réservés à l'atelier.</p></section>`;
  }
  const PROCS = [
    { id: 'oil_reset', title: "Remise à zéro de l'entretien (vidange)", action: 'Remettre à zéro',
      desc: "Après une vidange : le tableau de bord repart sur l'intervalle configuré (kilomètres et mois). Les valeurs actuelles sont sauvegardées avant.",
      applies: def => ['Ecriture Autonomie de vidange en km', 'Ecriture Autonomie de vidange en mois', 'Lecture Configuration'].every(n => def.requests.some(r => r.name === n)),
      async run(e, def, out, file) {
        const kmData = 'Autonomie de vidange courante en km', moData = 'Autonomie de vidange courante en mois';
        const iv = await readByName(e, def, /^Paramètres autonomie de vidange/), mo = await readByName(e, def, /^Nombre de mois maxi entre chaque vidange$/);
        if (!iv || !mo) throw new Error("Intervalle de vidange illisible dans la configuration : rien n'a été écrit.");
        const curKm = await readByName(e, def, /^Autonomie de vidange courante en km$/), curMo = await readByName(e, def, /^Autonomie de vidange courante en mois$/);
        out(`Intervalle configuré : ${(iv * 1000).toLocaleString('fr-FR')} km, ${mo} mois. Actuel : ${curKm == null ? '—' : curKm.toLocaleString('fr-FR') + ' km'}, ${curMo == null ? '—' : curMo + ' mois'}.`);
        if (curKm != null) remember(kmData, curKm, file);
        if (curMo != null) remember(moData, curMo, file);
        const wKm = def.requests.find(r => r.name === 'Ecriture Autonomie de vidange en km'), wMo = def.requests.find(r => r.name === 'Ecriture Autonomie de vidange en mois');
        await api('/ddt/send', { tx: e.address, rx: e.rx, bytes: Ddt.hx(Ddt.build(def, wKm, { [kmData]: BigInt(iv * 1000) })), kind: 'write' });
        await api('/ddt/send', { tx: e.address, rx: e.rx, bytes: Ddt.hx(Ddt.build(def, wMo, { [moData]: BigInt(mo) })), kind: 'write' });
        const nk = await readByName(e, def, /^Autonomie de vidange courante en km$/), nm = await readByName(e, def, /^Autonomie de vidange courante en mois$/);
        if (nk !== iv * 1000 || nm !== mo) throw new Error(`Écrit, mais la relecture diffère (${nk} km, ${nm} mois).`);
        return `Entretien remis à zéro : ${nk.toLocaleString('fr-FR')} km et ${nm} mois avant la prochaine vidange.`;
      } },
  ];
  async function runProc(i) {
    const r = _procRows[i]; if (!r) return;
    if (!arm('p' + i, `${r.p.title} ?`)) return;
    const box = document.getElementById('procOut_' + i);
    const out = t => { box.insertAdjacentHTML('beforeend', `<p class="panel-sub mono" style="margin:6px 0 0">${esc(t)}</p>`); };
    try { out('Communication avec ' + shortName(r.e.name) + '…'); const msg = await r.p.run(r.e, r.f.def, out, r.f.name); out(msg); toast(msg, 6000); }
    catch (err) { out('Arrêté : ' + err.message); toast(err.message, 7000); }
  }

  // Renault fault codes in plain French, from each ECU's own ReadDTC description.
  async function describeScan() {
    const scan = bleEngine.lastScan && bleEngine.lastScan();
    if (!scan || !(await loadStored())) return;
    for (const e of scan.ecus) {
      if (!e.dtcs.length) continue;
      const f = await fileOf({ ...e, identRaw: e.identRaw, code: e.code }); if (!f) continue;
      const req = f.def.requests.find(r => /^(17|19)/.test(r.sentbytes) && Object.keys(r.receivebyte_dataitems || {}).some(n => /^(FirstDTC|DTC)$/i.test(n)));
      if (!req) continue;
      const items = req.receivebyte_dataitems, data = f.def.data;
      const codeName = Object.keys(items).find(n => /^(FirstDTC|DTC)$/i.test(n));
      const list = (data[codeName] || {}).lists || {};
      const fl = n => (data[n] || {}).lists || {};
      for (const d of e.dtcs) {
        const name = list[String(d.raw)];
        if (!name || d.st == null) { if (name) d.label = name; continue; }
        const specific = 'Type Of Fault' in items && (d.st & 0x80) && Object.keys(fl('Specific Fault')).length;
        const fault = (specific ? fl('Specific Fault') : fl('Standard Fault'))[String(d.st & 0x1F)];
        d.label = name + (fault && !/non défini/i.test(fault) ? ' · ' + fault.charAt(0).toLowerCase() + fault.slice(1) : '');
      }
    }
  }
  function leave() { if (testRun) stopTest(); }
  return { loadCodes, describeScan, importFile, renderPackPanel, loadStored, readOdometer, hub, runProc, MODEL_NAMES, open, choose, tab, readOne, readAll, applyPlain, applyIndexed, loadOption, startTest, stopTest, leave, hasPack: () => !!packInfo, render };
})();
