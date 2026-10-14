// Kapasite Analizi — v2 modülü (yeni ekran). Tasarım: "Kapasite Analizi.html" / referans v81
// viewKapasiteAnalizi. Gerçekleşen üretimden (production) makine/ürün/operasyon başına GÜNLÜK
// kapasiteyi hesaplar, tanımlı kapasiteyle (capacities) karşılaştırır, sapma >%10 ve ≥3 gün
// veri olan satırlarda öneri verir. "Uygula" öneriyi capacities'e yazar.
//
// Veri istemcide türetilir (listAll — yeni OKUMA ucu yok). Hariç tutulan günler yeni
// capacity-exclusions ucundan (migration 045). Çalışma saati / duruş / kapasite çözümü
// core/capacity.js'ten, dönem yardımcıları core/report.js'ten paylaşılır.
//
// "Uygula" geri yazımı: öneri GÜNLÜK bir sayı; v2 kapasite modeli capacityPerShift + opsiyonel
// minutes (dk/adet). capacities.js'in kendi kuralıyla tutarlı olsun diye minutes = gunDk/öneri
// ve capacityPerShift = öneri yazılır (minutes doluysa capacityPerShift = floor(gunDk/minutes)).
//
// i18n: tüm metinler t(); dil değişince bindLang render()'ı VERİ ÇEKMEDEN yeniden çağırır.
// Makine/ürün/operasyon adları sunucudan geldiği gibi basılır (lookup.label).

import { resource, request, ValidationError, ApiError } from '../core/api.js';
import { errorState, esc, confirmDialog } from '../core/states.js';
import { toast } from '../core/toast.js';
import { loadLookup, mapProduct, mapNamed } from '../core/lookups.js';
import { t, bindLang } from '../core/i18n.js';
import { shiftWorkMinutes, downtimeMinutes, resolveCapacity } from '../core/capacity.js';
import { MONTHS, mondayOf, parseISO, fmtISO } from '../core/report.js';
import { fmtTr, fmtDateTR } from '../core/format.js';

const canWrite = (window.SESSION_ROLE ?? 'editor') === 'editor';
const MIN_GUN = 3;                                             // güvenilir öneri için en az gün
const NOT_IFADELERI = ['iş emri kapamak', 'giriş yapılmıştır'];   // not filtresi ifadeleri

// Oturum boyu modül düzeyinde durum (modüle dönünce korunur).
const S = { mod: 'tum', deger: 'durussuz', makine: '', arama: '', sirala: null, yon: 1, notDisla: false };

const r50 = (v) => Math.round(v / 50) * 50;
const kn = (v) => v === null || v === undefined ? '—' : Math.round(v).toLocaleString('tr-TR');

export async function viewKapasiteAnalizi(container) {
  container.innerHTML = `<div class="loading">${t('common.loading')}</div>`;
  let centers, products, operations, workOrders, production, caps, wh, exclusions;
  try {
    const d = (n) => resource(n).listAll().then(r => r.data);
    [centers, products, operations, workOrders, production, caps, wh, exclusions] = await Promise.all([
      loadLookup('work-centers', mapNamed),
      loadLookup('product-codes', mapProduct),
      loadLookup('operations', mapNamed),
      d('work-orders'),
      d('production'),
      d('capacities'),
      request('/working-hours').then(r => r.data),
      d('capacity-exclusions'),
    ]);
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(errorState({ message: err.message, onRetry: () => viewKapasiteAnalizi(container) }));
    return;
  }

  const excApi = resource('capacity-exclusions');
  const capApi = resource('capacities');
  const woMap = new Map(workOrders.map(w => [w.id, w]));
  const shiftMin = shiftWorkMinutes(wh);
  const gunDk = shiftMin.total;
  const vmin = { 'Sabah': shiftMin['Sabah'], 'Öğleden Sonra': shiftMin['Öğleden Sonra'] };

  // --- Aday kayıtlar + hariç sayaçları (referans kapasiteAnalizKayitlari) ---
  function hesaplaKayitlar() {
    const sonuc = { kayitlar: [], haric: { tarih: {}, not: { n: 0, adet: 0 }, mesai: { n: 0, adet: 0 }, bos: { n: 0 } } };
    if (!gunDk || gunDk <= 0) return sonuc;
    const haricTarih = new Set(exclusions.map(h => h.date));
    const adaylar = [];
    for (const p of production) {
      const w = woMap.get(p.workOrderId);
      if (!w) continue;
      const adet = Number(p.actualQuantity) || 0;
      if (haricTarih.has(p.date)) { const h = sonuc.haric.tarih[p.date] = sonuc.haric.tarih[p.date] || { n: 0, adet: 0 }; h.n++; h.adet += adet; continue; }
      const not = (p.note || '').toLocaleLowerCase('tr');
      if (S.notDisla && NOT_IFADELERI.some(x => not.includes(x))) { sonuc.haric.not.n++; sonuc.haric.not.adet += adet; continue; }
      if (!Object.prototype.hasOwnProperty.call(vmin, p.shift) || !vmin[p.shift]) { sonuc.haric.mesai.n++; sonuc.haric.mesai.adet += adet; continue; }
      const durus = downtimeMinutes(p.downtimeStart, p.downtimeEnd, wh);
      if (adet <= 0 && durus <= 0) { sonuc.haric.bos.n++; continue; }
      adaylar.push({ p, w, adet, durus, tarih: p.date });
    }
    // Aynı makine+gün+vardiyada birden çok iş emri → vardiya süresi eşit bölünür.
    const grp = {};
    const anahtar = a => a.w.workCenterId + '|' + a.tarih + '|' + a.p.shift;
    adaylar.forEach(a => { (grp[anahtar(a)] = grp[anahtar(a)] || new Set()).add(a.w.id); });
    adaylar.forEach(a => { const n = grp[anahtar(a)].size; a.pay = vmin[a.p.shift] / n; a.paylasimli = n > 1; a.durusDk = Math.min(a.durus, a.pay); });
    sonuc.kayitlar = adaylar;
    return sonuc;
  }

  // Ürün+operasyon+makine(+dönem) bazında topla (referans kapasiteAnalizGrupla).
  function grupla(kayitlar, donemFn) {
    const m = {};
    for (const a of kayitlar) {
      const donem = donemFn ? donemFn(a.tarih) : '';
      const key = [a.w.productCodeId, a.w.operationId, a.w.workCenterId, donem].join('|');
      const g = m[key] = m[key] || { productCodeId: a.w.productCodeId, operationId: a.w.operationId, workCenterId: a.w.workCenterId, donem, adet: 0, plan: 0, durus: 0, paylasilan: 0, gunler: new Set(), kayit: 0 };
      g.adet += a.adet; g.plan += a.pay; g.durus += a.durusDk; g.gunler.add(a.tarih); g.kayit++;
      if (a.paylasimli) g.paylasilan += a.pay;
    }
    return Object.values(m);
  }

  function metrik(g) {
    const net = g.plan - g.durus;
    return {
      gun: g.gunler.size, kayit: g.kayit, adet: g.adet,
      gercek: g.plan > 0 ? g.adet * gunDk / g.plan : null,
      dsiz: (g.adet > 0 && net > 0) ? g.adet * gunDk / net : null,
      durusYuzde: g.plan > 0 ? g.durus / g.plan * 100 : 0,
      paylasimYuzde: g.plan > 0 ? g.paylasilan / g.plan * 100 : 0,
    };
  }

  const tanimliGunluk = (productId, wcId, opId) => resolveCapacity(caps, productId, wcId, opId, gunDk);

  // Öneri: dsiz 50'ye yuvarlanır; ±%10 Uygun, <3 gün Az veri, tanımsız Tanımla, sapma Düşür/Artır.
  function oneriHesapla(tanimli, dsiz, gun) {
    if (dsiz === null) return { tip: 'yok' };
    const hedef = r50(dsiz);
    if (gun < MIN_GUN) return { tip: 'az', hedef };
    if (!tanimli) return { tip: 'tanimla', hedef };
    const fark = (dsiz - tanimli) / tanimli;
    if (Math.abs(fark) <= 0.10) return { tip: 'uygun', hedef, fark };
    return { tip: fark < 0 ? 'dusur' : 'artir', hedef, fark };
  }

  const prodLabel = (id) => products.label(id);
  const prodCode = (id) => { const r = products.byId.get(id); return r && r.code ? r.code : ('#' + id); };   // ÜRÜN sütunu: referans gibi sadece kod
  const opLabel = (id) => id == null ? '—' : operations.label(id);
  const wcLabel = (id) => id == null ? '—' : centers.label(id);
  const farkRenk = (p) => p === null ? 'var(--ink)' : Math.abs(p) <= 10 ? 'var(--good)' : p < 0 ? 'var(--flag)' : 'var(--accent)';

  // Dönem anahtar + etiket
  const aylikKey = (iso) => iso.slice(0, 7);
  const haftaKey = (iso) => fmtISO(mondayOf(parseISO(iso)));
  const aylikEtiket = (k) => { const [y, m] = k.split('-'); return MONTHS()[parseInt(m, 10) - 1] + ' ' + y; };
  const haftaEtiket = (k) => { const [, m, d] = k.split('-'); return d + '.' + m; };

  // --- Uygula: öneriyi capacities'e yaz (capacities.js kuralıyla tutarlı) ---
  async function uygula(row) {
    if (!canWrite || row.oneri.hedef == null) return;
    const hedef = row.oneri.hedef;
    const ok = await confirmDialog({
      title: t('ka.applyTitle'),
      body: t('ka.applyBody', { urun: prodCode(row.productCodeId), makine: wcLabel(row.workCenterId), n: fmtTr(hedef) })
        + (row.paylasimYuzde >= 30 ? '\n\n' + t('ka.applyShareWarn', { p: Math.round(row.paylasimYuzde) }) : ''),
      confirmLabel: t('ka.applyConfirm'),
    });
    if (!ok) return;
    const minutes = hedef > 0 ? Math.round((gunDk / hedef) * 100) / 100 : null;
    const existing = caps.find(c => c.productCodeId === row.productCodeId && c.workCenterId === row.workCenterId && c.operationId === (row.operationId ?? null));
    try {
      let saved;
      if (existing) {
        ({ data: saved } = await capApi.update(existing.id, { capacityPerShift: hedef, minutes, updatedAt: existing.updatedAt }));
        const i = caps.findIndex(c => c.id === existing.id); if (i >= 0) caps[i] = saved;
      } else {
        ({ data: saved } = await capApi.create({ productCodeId: row.productCodeId, workCenterId: row.workCenterId, operationId: row.operationId ?? null, capacityPerShift: hedef, minutes }));
        caps.push(saved);
      }
      toast(t('ka.applied', { n: fmtTr(hedef) }), 'success');
      render();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('err.GENERIC'), 'danger');
    }
  }

  // --- Hariç tarih ekle / kaldır ---
  async function haricEkle() {
    const tarih = container.querySelector('#ka-haric-tarih')?.value;
    const not = (container.querySelector('#ka-haric-not')?.value || '').trim();
    if (!tarih) { toast(t('ka.excDatePick'), 'danger'); return; }
    if (exclusions.some(h => h.date === tarih)) { toast(t('ka.excDup'), 'danger'); return; }
    try {
      const { data } = await excApi.create({ date: tarih, note: not });
      exclusions.push(data);
      toast(t('ka.excAdded', { d: fmtDateTR(tarih) }), 'success');
      render();
    } catch (err) {
      if (err instanceof ValidationError) toast(Object.values(err.fields)[0] || t('err.GENERIC'), 'danger');
      else toast(err instanceof ApiError ? err.message : t('err.GENERIC'), 'danger');
    }
  }
  async function haricKaldir(id) {
    const row = exclusions.find(h => h.id === id);
    const ok = await confirmDialog({ title: t('ka.excRemoveTitle'), body: t('ka.excRemoveBody'), confirmLabel: t('ka.excRemoveConfirm') });
    if (!ok) return;
    try {
      await excApi.remove(id);
      exclusions = exclusions.filter(h => h.id !== id);
      toast(t('ka.excRemoved', { d: row ? fmtDateTR(row.date) : '' }), 'success');
      render();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('err.GENERIC'), 'danger');
    }
  }

  // Filtre (makine + ürün/operasyon arama) — grup seviyesinde
  function grupFiltre(g) {
    if (S.makine && g.workCenterId !== Number(S.makine)) return false;
    const q = S.arama.trim().toLocaleLowerCase('tr');
    if (!q) return true;
    return [prodLabel(g.productCodeId), opLabel(g.operationId), wcLabel(g.workCenterId)].some(v => String(v).toLocaleLowerCase('tr').includes(q));
  }

  let KAP_SATIRLAR = [];   // "Tüm Zamanlar" tablosundaki hesaplanmış satırlar (Uygula closure'u)

  render();
  bindLang(container, render);

  function render() {
    if (production.length === 0) { container.innerHTML = ''; container.appendChild(emptyBox(t('ka.emptyNoProd'), t('ka.emptyNoProdHint'))); return; }
    if (!gunDk || gunDk <= 0) { container.innerHTML = ''; container.appendChild(emptyBox(t('ka.emptyNoWh'), t('ka.emptyNoWhHint'))); return; }

    const A = hesaplaKayitlar();
    const tumKayit = A.kayitlar;
    const makineIds = [...new Set(tumKayit.map(a => a.w.workCenterId))].sort((a, b) => wcLabel(a).localeCompare(wcLabel(b), 'tr'));
    const gunSayisi = new Set(tumKayit.map(a => a.tarih)).size;
    const toplamHaricTarih = Object.values(A.haric.tarih).reduce((s, h) => s + h.n, 0);

    container.innerHTML = `
      <div class="module-head"><div>
        <h2>${esc(t('menu.kapasite-analizi'))}</h2>
        <div class="text-muted" style="font-size:13.5px; margin-top:6px;">${esc(t('ka.subtitle'))}</div>
      </div></div>
      <div id="ka-ust"></div>
      ${renderYontem()}
      <div id="ka-govde"></div>
      <div id="ka-haric"></div>`;

    container.querySelector('#ka-ust').innerHTML = renderUst(makineIds);
    container.querySelector('#ka-govde').innerHTML = (S.mod === 'tum') ? renderTum(tumKayit) : renderMatris(tumKayit);
    container.querySelector('#ka-haric').innerHTML = renderHaric(A, tumKayit.length, gunSayisi, toplamHaricTarih);
    bindEvents();
  }

  function renderUst(makineIds) {
    const segBtn = (id, label, grp, cur) => `<button class="btn btn-sm ${cur === id ? 'btn-primary' : 'btn-ghost'}" data-seg="${grp}" data-val="${id}">${esc(label)}</button>`;
    return `
    <div class="panel"><div class="panel-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
      <div style="display:flex;gap:6px;">
        ${segBtn('tum', t('ka.modeAll'), 'mod', S.mod)}${segBtn('aylik', t('ka.modeMonthly'), 'mod', S.mod)}${segBtn('haftalik', t('ka.modeWeekly'), 'mod', S.mod)}
      </div>
      ${S.mod === 'tum' ? '' : `
      <div style="display:flex;gap:6px;align-items:center;"><span class="field-hint">${esc(t('ka.shownValue'))}</span>
        ${segBtn('durussuz', t('ka.valDowntimeless'), 'deger', S.deger)}${segBtn('gercek', t('ka.valActual'), 'deger', S.deger)}
      </div>`}
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="ka-makine" style="padding:6px 8px;">
          <option value="">${esc(t('ka.allMachines'))}</option>
          ${makineIds.map(id => `<option value="${id}" ${S.makine === String(id) ? 'selected' : ''}>${esc(wcLabel(id))}</option>`).join('')}
        </select>
        <input type="text" id="ka-arama" placeholder="${esc(t('ka.searchPlaceholder'))}" value="${esc(S.arama)}" style="padding:6px 8px;width:180px;">
      </div>
    </div></div>`;
  }

  function renderYontem() {
    return `
    <div class="panel"><div class="panel-body text-muted" style="font-size:12.5px;line-height:1.6;">
      ${t('ka.methodHtml', { sabah: fmtTr(vmin['Sabah']), ogle: fmtTr(vmin['Öğleden Sonra']), gun: fmtTr(gunDk), min: MIN_GUN })}
    </div></div>`;
  }

  function renderTum(tumKayit) {
    let satirlar = grupla(tumKayit, null).filter(grupFiltre).map(g => {
      const m = metrik(g);
      const tanimli = tanimliGunluk(g.productCodeId, g.workCenterId, g.operationId);
      const oneri = oneriHesapla(tanimli, m.dsiz, m.gun);
      const fark = (tanimli && m.dsiz !== null) ? (m.dsiz - tanimli) / tanimli * 100 : null;
      return { ...g, ...m, tanimli, oneri, farkSayi: fark };
    });
    satirlar = sirala(satirlar);
    KAP_SATIRLAR = satirlar;   // Uygula closure'u için

    const cols = [
      ['urun', t('ka.colProduct'), 'left'], ['op', t('ka.colOperation'), 'left'], ['makine', t('ka.colMachine'), 'left'],
      ['gun', t('ka.colDay'), 'right'], ['adet', t('ka.colTotal'), 'right'], ['tanimli', t('ka.colDefined'), 'right'],
      ['gercek', t('ka.colActual'), 'right'], ['dsiz', t('ka.colDowntimeless'), 'right'], ['durusYuzde', t('ka.colDowntimePct'), 'right'],
      ['farkSayi', t('ka.colDiff'), 'right'], ['oneri', t('ka.colSuggestion'), 'left'],
    ];
    const th = cols.map(([id, label, hiza]) => {
      const ok = S.sirala === id ? (S.yon === 1 ? ' ↑' : ' ↓') : '';
      return `<th data-sort="${id}" style="text-align:${hiza};cursor:pointer;${S.sirala === id ? 'color:var(--accent);' : ''}">${esc(label)}${ok}</th>`;
    }).join('') + '<th></th>';

    const body = satirlar.length === 0
      ? `<tr><td colspan="12" style="text-align:center;color:var(--ink-faint);padding:20px;">${esc(t('ka.noMatch'))}</td></tr>`
      : satirlar.map((s, i) => `<tr>
          <td class="mono"><b>${esc(prodCode(s.productCodeId))}</b></td>
          <td>${esc(opLabel(s.operationId))}</td>
          <td>${esc(wcLabel(s.workCenterId))}</td>
          <td class="mono">${s.gun}<div class="field-hint">${t('ka.nRecords', { n: s.kayit })}</div></td>
          <td class="mono" style="text-align:right;">${kn(s.adet)}</td>
          <td class="mono" style="text-align:right;">${s.tanimli != null ? kn(s.tanimli) : `<span class="field-hint">${esc(t('ka.undefined'))}</span>`}</td>
          <td class="mono" style="text-align:right;">${kn(s.gercek)}</td>
          <td class="mono" style="text-align:right;"><b>${kn(s.dsiz)}</b></td>
          <td class="mono" style="text-align:right;">${s.durusYuzde > 0 ? '%' + s.durusYuzde.toFixed(1).replace('.', ',') : '—'}</td>
          <td class="mono" style="text-align:right;color:${farkRenk(s.farkSayi)};">${s.farkSayi === null ? '—' : (s.farkSayi > 0 ? '+' : '') + Math.round(s.farkSayi) + '%'}</td>
          <td>${oneriRozet(s.oneri)}${s.paylasimYuzde >= 30 ? `<div class="field-hint" style="color:var(--flag);cursor:help;" title="${esc(t('ka.shareWarnTitle', { p: Math.round(s.paylasimYuzde) }))}">${esc(t('ka.shareWarn', { p: Math.round(s.paylasimYuzde) }))}</div>` : ''}</td>
          <td>${canWrite && ['dusur', 'artir', 'tanimla'].includes(s.oneri.tip) ? `<button class="btn btn-sm btn-ghost" data-apply="${i}">${esc(t('ka.apply'))}</button>` : ''}</td>
        </tr>`).join('');

    return `<div class="panel"><div class="panel-head"><h3>${esc(t('ka.modeAll'))}</h3><span class="field-hint">${t('ka.rowCount', { n: satirlar.length })}</span></div>
      <div class="table-wrap" style="overflow-x:auto;"><table class="table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  }

  function renderMatris(tumKayit) {
    const haftalik = S.mod === 'haftalik';
    const donemFn = haftalik ? haftaKey : aylikKey;
    const gruplar = grupla(tumKayit, donemFn);
    const donemler = [...new Set(gruplar.map(g => g.donem))].sort();
    const satirMap = {};
    for (const g of gruplar) {
      const k = [g.productCodeId, g.operationId, g.workCenterId].join('|');
      const s = satirMap[k] = satirMap[k] || { productCodeId: g.productCodeId, operationId: g.operationId, workCenterId: g.workCenterId, adetToplam: 0, donemler: {} };
      s.adetToplam += g.adet; s.donemler[g.donem] = metrik(g);
    }
    const satirlar = Object.values(satirMap).filter(grupFiltre).sort((a, b) => b.adetToplam - a.adetToplam);
    const etiket = haftalik ? haftaEtiket : aylikEtiket;
    const baslik = haftalik ? t('ka.modeWeekly') : t('ka.modeMonthly');
    const degerAd = S.deger === 'durussuz' ? t('ka.valDowntimeless') : t('ka.valActual');

    const head = `<tr><th>${esc(t('ka.colProduct'))}</th><th>${esc(t('ka.colOperation'))}</th><th>${esc(t('ka.colMachine'))}</th><th style="text-align:right;">${esc(t('ka.colDefinedShort'))}</th>${donemler.map(d => `<th style="text-align:right;" title="${esc(d)}">${esc(etiket(d))}</th>`).join('')}</tr>`;
    const body = satirlar.length === 0
      ? `<tr><td colspan="${donemler.length + 4}" style="text-align:center;color:var(--ink-faint);padding:20px;">${esc(t('ka.noMatch'))}</td></tr>`
      : satirlar.map(s => {
        const tanimli = tanimliGunluk(s.productCodeId, s.workCenterId, s.operationId);
        return `<tr>
          <td class="mono"><b>${esc(prodCode(s.productCodeId))}</b></td><td>${esc(opLabel(s.operationId))}</td><td>${esc(wcLabel(s.workCenterId))}</td>
          <td class="mono" style="text-align:right;">${tanimli != null ? kn(tanimli) : '<span class="field-hint">—</span>'}</td>
          ${donemler.map(d => {
          const m = s.donemler[d];
          const v = m ? (S.deger === 'durussuz' ? m.dsiz : m.gercek) : null;
          if (v === null || v === undefined) return '<td class="mono" style="text-align:right;"><span class="field-hint">—</span></td>';
          const fark = tanimli ? (v - tanimli) / tanimli * 100 : null;
          return `<td class="mono" style="text-align:right;"><b style="color:${farkRenk(fark)};">${kn(v)}</b><div class="field-hint">${t('ka.nDays', { n: m.gun })}</div></td>`;
        }).join('')}
        </tr>`;
      }).join('');

    return `<div class="panel"><div class="panel-head"><h3>${esc(baslik)} — ${esc(degerAd)}</h3>
      <span class="field-hint">${esc(haftalik ? t('ka.weeklyHint') : t('ka.monthlyHint'))}</span></div>
      <div class="table-wrap" style="overflow-x:auto;"><table class="table"><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
  }

  function renderHaric(A, katilanKayit, gunSayisi, toplamHaricTarih) {
    const liste = [...exclusions].sort((a, b) => b.date.localeCompare(a.date));
    const satirlar = liste.length === 0
      ? `<div class="field-hint">${esc(t('ka.noExclusions'))}</div>`
      : `<div class="table-wrap" style="overflow-x:auto;"><table class="table">
          <thead><tr><th>${esc(t('ka.colDate'))}</th><th style="text-align:right;">${esc(t('ka.colRecords'))}</th><th style="text-align:right;">${esc(t('ka.colQty'))}</th><th>${esc(t('ka.colNote'))}</th><th></th></tr></thead>
          <tbody>${liste.map(h => { const s = A.haric.tarih[h.date] || { n: 0, adet: 0 }; return `<tr>
            <td class="mono">${esc(fmtDateTR(h.date))}</td><td class="mono" style="text-align:right;">${s.n}</td><td class="mono" style="text-align:right;">${kn(s.adet)}</td>
            <td style="font-size:12px;">${esc(h.note || '')}</td>
            <td>${canWrite ? `<button class="btn btn-sm btn-ghost" data-exc-del="${h.id}">${esc(t('ka.includeBack'))}</button>` : ''}</td></tr>`; }).join('')}</tbody>
        </table></div>`;

    const ekle = canWrite ? `<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">
        <input type="date" id="ka-haric-tarih" style="padding:6px 8px;">
        <input type="text" id="ka-haric-not" placeholder="${esc(t('ka.excNotePlaceholder'))}" style="padding:6px 8px;min-width:240px;">
        <button class="btn btn-sm btn-ghost" id="ka-haric-ekle">${esc(t('ka.excAdd'))}</button></div>` : '';

    return `<div class="panel">
      <div class="panel-head"><h3>${esc(t('ka.exclTitle'))}</h3>
        <span class="field-hint">${t('ka.included', { k: katilanKayit, g: gunSayisi })}</span></div>
      <div class="panel-body">
        ${satirlar}
        ${ekle}
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;font-weight:400;">
          <input type="checkbox" id="ka-not-disla" ${S.notDisla ? 'checked' : ''}>
          ${t('ka.noteFilter', { n: A.haric.not.n, adet: kn(A.haric.not.adet) })}
        </label>
        <div class="field-hint" style="margin-top:6px;">${t('ka.excludedSummary', { bos: A.haric.bos.n, mesai: A.haric.mesai.n, tar: toplamHaricTarih })}</div>
      </div>
    </div>`;
  }

  function sirala(satirlar) {
    if (!S.sirala) return satirlar.sort((a, b) => b.adet - a.adet);
    const a = S.sirala, y = S.yon;
    const val = (x) => {
      if (a === 'urun') return prodCode(x.productCodeId);
      if (a === 'op') return opLabel(x.operationId);
      if (a === 'makine') return wcLabel(x.workCenterId);
      if (a === 'tanimli') return x.tanimli;
      return x[a];
    };
    return [...satirlar].sort((x, z) => {
      const vx = val(x), vz = val(z);
      if (typeof vx === 'number' || typeof vz === 'number') return y * ((vx ?? -1e9) - (vz ?? -1e9));
      return y * String(vx || '').localeCompare(String(vz || ''), 'tr', { numeric: true });
    });
  }

  function oneriRozet(o) {
    if (o.tip === 'uygun') return `<span class="badge badge-good">${esc(t('ka.sugOk'))}</span>`;
    if (o.tip === 'dusur') return `<span class="badge badge-warn">${esc(t('ka.sugLower', { n: kn(o.hedef) }))}</span>`;
    if (o.tip === 'artir') return `<span class="badge badge-neutral">${esc(t('ka.sugRaise', { n: kn(o.hedef) }))}</span>`;
    if (o.tip === 'tanimla') return `<span class="badge badge-neutral">${esc(t('ka.sugDefine', { n: kn(o.hedef) }))}</span>`;
    if (o.tip === 'az') return `<span class="badge badge-neutral" title="${esc(t('ka.sugLowDataTitle', { n: MIN_GUN }))}">${esc(t('ka.sugLowData'))}</span>`;
    return '<span class="field-hint">—</span>';
  }

  function bindEvents() {
    container.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => { S[b.dataset.seg] = b.dataset.val; render(); }));
    const mk = container.querySelector('#ka-makine'); if (mk) mk.addEventListener('change', (e) => { S.makine = e.target.value; render(); });
    const ar = container.querySelector('#ka-arama'); if (ar) ar.addEventListener('change', (e) => { S.arama = e.target.value; render(); });
    container.querySelectorAll('[data-sort]').forEach(th => th.addEventListener('click', () => { const id = th.dataset.sort; S.yon = S.sirala === id ? -S.yon : 1; S.sirala = id; render(); }));
    container.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click', () => uygula(KAP_SATIRLAR[Number(b.dataset.apply)])));
    container.querySelectorAll('[data-exc-del]').forEach(b => b.addEventListener('click', () => haricKaldir(Number(b.dataset.excDel))));
    const he = container.querySelector('#ka-haric-ekle'); if (he) he.addEventListener('click', haricEkle);
    const nd = container.querySelector('#ka-not-disla'); if (nd) nd.addEventListener('change', (e) => { S.notDisla = e.target.checked; render(); });
  }

  function emptyBox(title, hint) {
    const d = document.createElement('div');
    d.className = 'panel';
    d.innerHTML = `<div class="panel-body" style="text-align:center;padding:48px 24px;"><div style="font-size:18px;font-weight:600;">${esc(title)}</div><div class="text-muted" style="margin-top:8px;font-size:14px;">${esc(hint)}</div></div>`;
    return d;
  }
}
