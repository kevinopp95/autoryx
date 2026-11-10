// AUTORYX · manufacturer screens built from the vehicle pack (DDT). Needs Bluetooth direct.
const DdtUi = (() => {
  let pack = null, packInfo = null, cur = null;   // cur: { ecu (scan entry), file, def, cat, tab }
  const results = {};                              // request name → decoded items
  let testTimer = null, testRun = null;
  const backups = (() => { try { return JSON.parse(localStorage.getItem('autoryx_ddt_backup') || '{}') || {}; } catch { return {}; } })();
  const saveBackups = () => { try { localStorage.setItem('autoryx_ddt_backup', JSON.stringify(backups)); } catch {} };
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

  async function loadStored() {
    if (pack) return pack;
    try { const blob = await idbGet('pack'); if (blob) { pack = await Ddt.unpack(blob); packInfo = { project: pack.project, count: pack.count }; } } catch (e) { ObdBle.note('Base constructeur illisible : ' + e.message); }
    return pack;
  }
  async function importFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    try {
      const p = await Ddt.unpack(f);
      await idbPut('pack', f);
      pack = p; packInfo = { project: p.project, count: p.count };
      toast(`Base ${p.project.toUpperCase()} importée : ${p.count} calculateurs`);
    } catch (e) { toast('Import impossible : ' + e.message, 7000); }
    input.value = '';
    renderPackPanel();
    if (typeof _lastScan !== 'undefined' && _lastScan) renderModules(_lastScan);
  }
  function renderPackPanel() {
    const el = document.getElementById('packPanel'); if (!el) return;
    el.hidden = false;
    el.innerHTML = `<div class="panel-h"><span class="panel-t">Base constructeur</span><span class="panel-sub push">${packInfo ? `${packInfo.project.toUpperCase()} · ${packInfo.count} calculateurs, dans ce téléphone` : 'non importée'}</span></div>
      <p class="panel-sub" style="margin:0 0 12px">${packInfo ? 'Après un scan, ouvrez un calculateur pour lire ses mesures, sa configuration et lancer ses tests.' : 'Importez le fichier préparé sur le PC (autoryx-clio3.json.gz) pour débloquer mesures constructeur, configuration et tests actifs.'}</p>
      <label class="btn btn-soft sm" style="cursor:pointer">${svgI('file')}${packInfo ? 'Remplacer la base' : 'Importer la base'}<input type="file" accept=".gz,.json,application/gzip,application/json" hidden onchange="DdtUi.importFile(this)"></label>`;
  }

  // ── ECU screen ──
  function identOf(e) {
    const r = e.identRaw; if (!r) return null;
    if (r.kwp) return Ddt.identKwp(Ddt.fromHex(r.kwp));
    return Ddt.identUds(Ddt.fromHex(r.f1a0 || ''), Ddt.fromHex(r.f18a || ''), Ddt.fromHex(r.f194 || ''), Ddt.fromHex(r.f195 || ''));
  }
  async function open(address) {
    if (!bleMode) { toast('Disponible en Bluetooth direct, boîtier connecté'); return; }
    if (!(await loadStored())) { toast('Importez d\'abord la base constructeur'); return; }
    const e = _lastScan && _lastScan.ecus.find(x => x.address === address);
    if (!e) return;
    const id = identOf(e);
    const m = Ddt.match(pack, e.code, id);
    if (!m) { toast(`Aucune fiche pour « ${e.name} » dans la base ${pack.project.toUpperCase()}`); return; }
    const saved = (() => { try { return localStorage.getItem('autoryx_ddt_file_' + e.code); } catch { return null; } })();
    const file = m.name || (saved && m.options.includes(saved) ? saved : null);
    cur = { ecu: e, id, match: m, file, tab: 'read' };
    if (file) select(file);
    stopLoops();
    showScreen('ecu');
    render();
  }
  function select(file) {
    cur.file = file; cur.def = pack.ecus[file]; cur.cat = Ddt.catalogue(cur.def);
    for (const k of Object.keys(results)) delete results[k];
    if (cur.match.kind === 'guess') try { localStorage.setItem('autoryx_ddt_file_' + cur.ecu.code, file); } catch {}
  }
  function choose(file) { select(file); render(); }
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
  function backupKey(item) { return `${vinKey()}|${cur.file}|${item}`; }
  function remember(item, raw) { const k = backupKey(item); if (!(k in backups)) { backups[k] = String(raw); saveBackups(); } }
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
  function leave() { if (testRun) stopTest(); }
  return { importFile, renderPackPanel, loadStored, open, choose, tab, readOne, readAll, applyPlain, applyIndexed, loadOption, startTest, stopTest, leave, hasPack: () => !!packInfo, render };
})();
