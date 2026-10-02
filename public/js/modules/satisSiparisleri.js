// Satış Siparişleri — v2 modülü (yeni ekran). Tasarım: Satis-Siparisleri-v2.dc.html.
// Referans: v78 viewSatisSiparisleri. Aynı `orders` tablosunu source='satis' görünümüyle
// okur (Üretim Siparişleri ekranıyla aynı kayıtlar, farklı odak). Migration yok.
//
// Durum rozeti + özet + rapor gövdesi ORTAK modülden (_orderReport.js, referans orderStats/
// orderStatusBadge/siparisRaporIcerigi). Rozet: Tamamlandı/İptal sipariş durumundan, Gecikme
// Riski/Kapasite Yetersiz hesaplanır. İlerleme yalnız SON rota adımından — bir sipariş beş
// operasyondan geçse de müşteriye giden bitmiş ürün son adımdan çıkar.
//
// Sıralanabilir tablo (kolon başlığı) + arama + durum filtreleri + Rapor modalı + drawer.
// i18n: dil değişince VERİ ÇEKMEDEN yeniden çizilir (veri closure'da).

import { resource, request } from '../core/api.js';
import { openDrawer } from '../core/drawer.js';
import { FkSelect } from '../core/fkselect.js';
import { toast } from '../core/toast.js';
import { errorState, esc } from '../core/states.js';
import { loadLookup, mapProduct, mapNamed } from '../core/lookups.js';
import { t, bindLang } from '../core/i18n.js';
import { fmtTr, fmtDateTR } from '../core/format.js';
import { startOfDay } from '../core/report.js';
import { createCapacityHelpers } from '../core/bottleneck.js';
import { orderSummary, orderStatus, orderReportBody } from './_orderReport.js';

const api = resource('orders');
const canWrite = (window.SESSION_ROLE ?? 'editor') === 'editor';

// [alan, i18n başlık, genişlik, hiza] — sıralama alan adına göre; 'durum' yüzdeye göre.
const COLUMNS = [
  ['salesOrderNo', 'ss.colSalesNo', '150px', 'left'],
  ['orderNo', 'ss.colOrderNo', '150px', 'left'],
  ['customer', 'ss.colCustomer', '200px', 'left'],
  ['productCodeId', 'ss.colProduct', '200px', 'left'],
  ['targetQuantity', 'ss.colQty', '100px', 'right'],
  ['startDate', 'ss.colOrderDate', '140px', 'left'],
  ['requestedDeliveryDate', 'ss.colDue', '150px', 'left'],
  ['durum', 'ss.colStatus', '200px', 'left'],
];
const FILTERS = [['hepsi', 'ss.fAll'], ['bekleyen', 'ss.fWaiting'], ['geride', 'ss.fRisk'], ['tamam', 'ss.fDone']];
const SEARCH_FIELDS = ['salesOrderNo', 'orderNo', 'customer', 'note'];

export async function viewSatisSiparisleri(container, params) {
  container.innerHTML = `<div class="loading">${t('common.loading')}</div>`;
  let products, ops, centers, orders, workOrders, production, routes, caps, wh, statuses;
  try {
    let allOrders;
    [products, ops, centers, allOrders, workOrders, production, routes, caps, wh, statuses] = await Promise.all([
      loadLookup('product-codes', mapProduct),
      loadLookup('operations', mapNamed),
      loadLookup('work-centers', mapNamed),
      api.listAll().then(r => r.data),
      resource('work-orders').listAll().then(r => r.data),
      resource('production').listAll().then(r => r.data),
      resource('routes').listAll().then(r => r.data),
      resource('capacities').listAll().then(r => r.data),   // ETA yedek hızı + kapasite riski
      request('/working-hours').then(r => r.data),
      request('/order-statuses').then(r => r.data),   // create için varsayılan durum
    ]);
    orders = allOrders.filter(o => o.source === 'satis');
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(errorState({ message: err.message, onRetry: () => viewSatisSiparisleri(container) }));
    return;
  }

  const { productBottleneck } = createCapacityHelpers({ caps, routes, wh, products, ops, centers, t });
  const woByOrder = new Map();
  for (const w of workOrders) { if (!woByOrder.has(w.orderId)) woByOrder.set(w.orderId, []); woByOrder.get(w.orderId).push(w); }
  const producedByWo = new Map();
  for (const p of production) producedByWo.set(p.workOrderId, (producedByWo.get(p.workOrderId) || 0) + (Number(p.actualQuantity) || 0));
  const today = startOfDay(new Date());

  // Ortak rapor modülüne (referans orderStats/orderStatusBadge/siparisRaporIcerigi) geçilen bağlam.
  const ctx = { woByOrder, producedByWo, production, today, productBottleneck, products, ops, centers };
  const summary = (o) => orderSummary(o, ctx);

  let search = '';
  let filter = 'hepsi';
  let sortKey = 'startDate';
  let sortDir = -1;
  let reportId = null;

  function visible() {
    const q = search.trim().toLocaleLowerCase('tr');
    const rows = orders.filter(o => {
      if (q) {
        const hay = [...SEARCH_FIELDS.map(k => o[k] || ''), products.byId.get(o.productCodeId)?.code || ''].join(' ').toLocaleLowerCase('tr');
        if (!hay.includes(q)) return false;
      }
      // Filtreler yeni rozetlere eşlenir: İş Emri Bekliyor / Gecikme Riski / Tamamlandı (durum).
      if (filter === 'bekleyen') return !(woByOrder.get(o.id) || []).length;
      if (filter === 'geride') { const z = summary(o); return z.isEmriVar && z.riskli; }
      if (filter === 'tamam') return o.status === 'Tamamlandı';
      return true;
    });
    const val = (o) => {
      if (sortKey === 'targetQuantity') return Number(o.targetQuantity) || 0;
      if (sortKey === 'durum') return summary(o).pct;
      if (sortKey === 'productCodeId') return products.byId.get(o.productCodeId)?.code || '';
      return o[sortKey] || '';
    };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'number' && typeof vb === 'number') return sortDir * (va - vb);
      return sortDir * String(va).localeCompare(String(vb), 'tr', { numeric: true });
    });
  }

  render();
  bindLang(container, render);

  function render() {
    container.innerHTML = `
      <div class="module-head">
        <div>
          <h2>${esc(t('menu.satis-siparisleri'))}</h2>
          <div class="text-muted" style="font-size:13.5px; margin-top:6px;">${esc(t('ss.subtitle'))}</div>
        </div>
        <button class="btn btn-primary" id="ss-new"${canWrite ? '' : ` disabled title="${esc(t('common.readonlyHint'))}"`}>${esc(t('ss.new'))}</button>
      </div>
      <div class="toolbar" style="align-items:center; gap:12px; flex-wrap:wrap;">
        <div class="search"><input class="input" type="search" id="ss-search" placeholder="${esc(t('ss.searchPlaceholder'))}" value="${esc(search)}"></div>
        <div class="ss-filters">
          ${FILTERS.map(([id, lbl]) => `<button type="button" class="ss-filter${id === filter ? ' on' : ''}" data-f="${id}">${esc(t(lbl))}</button>`).join('')}
        </div>
        <span class="mono text-muted" id="ss-count" style="font-size:12px; margin-left:auto;"></span>
      </div>
      <div id="ss-table"></div>
      <div class="ss-foot text-muted">${esc(t('ss.footNote'))}</div>`;

    const inp = container.querySelector('#ss-search');
    inp.addEventListener('input', () => { search = inp.value; paint(); });
    container.querySelector('#ss-new').addEventListener('click', () => { if (canWrite) openForm(null); });
    // Filtre değişince TAM yeniden çiz — düğmelerin .on sınıfı da tazelensin (arama değeri korunur).
    container.querySelectorAll('.ss-filter').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; render(); }));
    paint();
  }

  function paint() {
    const list = visible();
    container.querySelector('#ss-count').textContent = t('ss.counter', { shown: list.length, total: orders.length });

    const arrow = (k) => sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    const head = COLUMNS.map(([key, lbl, w, al]) =>
      `<th class="ss-th${sortKey === key ? ' on' : ''}" data-key="${key}" style="width:${w}; text-align:${al};">${esc(t(lbl))}${arrow(key)}</th>`).join('')
      + '<th class="ss-th-actions"></th>';

    const rows = list.map(o => {
      const z = summary(o);
      const st = orderStatus(o, z);
      const p = products.byId.get(o.productCodeId) || {};
      const overdue = !z.doneByProduction && z.due && z.due < today;
      return `
        <tr>
          <td class="mono ss-strong">${esc(o.salesOrderNo || t('common.dash'))}</td>
          <td class="mono text-muted">${esc(o.orderNo || t('common.dash'))}</td>
          <td>${esc(o.customer || t('common.dash'))}</td>
          <td><div class="mono">${esc(p.code || ('#' + o.productCodeId))}</div><div class="ss-sub">${esc(p.name || '')}</div></td>
          <td class="mono" style="text-align:right;">${esc(fmtTr(o.targetQuantity))}</td>
          <td class="mono">${esc(o.startDate ? fmtDateTR(o.startDate) : t('common.dash'))}</td>
          <td class="mono"${overdue ? ' style="color:var(--color-danger);"' : ''}>${esc(o.requestedDeliveryDate ? fmtDateTR(o.requestedDeliveryDate) : t('common.dash'))}</td>
          <td>
            <span class="ss-badge ss-badge-${st.cls}">${esc(st.text)}</span>
            <div class="ss-prog"><span class="ss-prog-bar"><i style="width:${z.isEmriVar ? Math.min(z.pct, 100) : 0}%; background:${badgeColor(st.cls)};"></i></span><span class="mono ss-prog-pct">${z.isEmriVar ? '%' + z.pct : t('common.dash')}</span></div>
          </td>
          <td class="ss-c-actions">
            <div class="ss-acts">
              <button class="btn btn-primary btn-sm" data-report="${o.id}">${esc(t('ss.report'))}</button>
              <button class="btn btn-ghost btn-sm" data-goprod="${o.id}">${esc(t('ss.goProd'))}</button>
              ${canWrite ? `<button class="btn btn-ghost btn-sm" data-edit="${o.id}">${esc(t('action.edit'))}</button>` : ''}
            </div>
          </td>
        </tr>`;
    }).join('');

    container.querySelector('#ss-table').innerHTML = `
      <div class="ss-tablewrap">
        <table class="ss-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${list.length ? rows : `<tr><td colspan="${COLUMNS.length + 1}" class="ss-empty">${esc(t('ss.empty'))}</td></tr>`}</tbody>
        </table>
      </div>`;

    container.querySelectorAll('.ss-th').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      paint();
    }));
    container.querySelectorAll('[data-report]').forEach(b => b.addEventListener('click', () => openReport(Number(b.dataset.report))));
    container.querySelectorAll('[data-goprod]').forEach(b => b.addEventListener('click', () => { location.hash = `#orders?id=${b.dataset.goprod}`; }));
    if (canWrite) container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const o = orders.find(x => x.id === Number(b.dataset.edit)); if (o) openForm(o);
    }));
  }

  // --- Rapor modalı --- (gövde ortak modülden: orderReportBody)
  function openReport(id) {
    reportId = id;
    const o = orders.find(x => x.id === id); if (!o) return;
    const z = summary(o);

    const overlay = document.createElement('div');
    overlay.className = 'ss-modal-backdrop';
    overlay.innerHTML = `
      <div class="ss-modal" role="dialog" aria-modal="true">
        <div class="ss-modal-head">
          <span class="ss-modal-title">${esc(t('ss.reportTitle', { no: o.orderNo || o.salesOrderNo || '' }))}</span>
          <button class="btn btn-ghost" id="ss-r-x">×</button>
        </div>
        <div class="ss-modal-body">${orderReportBody(o, z, ctx)}</div>
        <div class="ss-modal-foot"><button class="btn btn-secondary" id="ss-r-close">${esc(t('action.close'))}</button></div>
      </div>`;
    container.appendChild(overlay);
    const close = () => { overlay.remove(); reportId = null; };
    overlay.querySelector('#ss-r-x').addEventListener('click', close);
    overlay.querySelector('#ss-r-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  // --- Yeni / düzenle formu (drawer) ---
  function openForm(row) {
    const editing = !!row;
    const productFk = new FkSelect({ source: products.source, rows: products.rows, value: row?.productCodeId ?? null, placeholder: t('ord.selectProduct') });
    openDrawer({
      title: () => t(editing ? 'ss.editTitle' : 'ss.newTitle'),
      submitLabel: () => t(editing ? 'action.update' : 'action.add'),
      values: editing ? { ...row } : {},
      fields: [
        { name: 'salesOrderNo', label: () => t('ss.salesNo'), type: 'text' },
        { name: 'customer', label: () => t('ss.customer'), type: 'text' },
        { name: 'productCodeId', label: () => t('ss.product'), type: 'fk', fk: productFk, required: true },
        { name: 'targetQuantity', label: () => t('ss.qty'), type: 'number', step: 'any', required: true },
        { name: 'startDate', label: () => t('ss.orderDate'), type: 'date' },
        { name: 'requestedDeliveryDate', label: () => t('ss.due'), type: 'date' },
        { name: 'note', label: () => t('field.note'), type: 'textarea' },
      ],
      onSubmit: async (v) => {
        if (editing) {
          // orderNo / source / status'a dokunma (bu ekranda gösterilmez).
          return (await api.update(row.id, v)).data;
        }
        // Yeni satış siparişi: source='satis', takip no üret, başlangıç durumu.
        const payload = { ...v, source: 'satis', status: statuses[0] || 'Hammadde Bekleniyor', orderNo: makeOrderNo(v.salesOrderNo) };
        return (await api.create(payload)).data;
      },
      onSaved: async () => { toast(t('ss.saved'), 'success'); orders = (await api.listAll()).data.filter(o => o.source === 'satis'); render(); },
    });
  }

  // Takip no (order_no): mevcut veri deseni SP-<yıl>-<müşteri PO no> (ör. SP-2026-50500).
  // Son kısım satisSiparisNo (müşterinin PO'su), sıra değil. PO boşsa sıra numarasına düşer.
  // Çakışırsa BE 409 döner; kullanıcı yeniden dener.
  function makeOrderNo(salesNo) {
    const year = new Date().getFullYear();
    const po = String(salesNo || '').trim();
    if (po) return `SP-${year}-${po}`;
    let max = 0;
    for (const o of orders) {
      const m = String(o.orderNo || '').match(new RegExp('^SP-' + year + '-(\\d+)$'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `SP-${year}-${String(max + 1).padStart(4, '0')}`;
  }
}

function badgeColor(cls) {
  return cls === 'success' ? 'var(--color-success)' : cls === 'danger' ? 'var(--color-danger)'
    : cls === 'warning' ? 'var(--color-warning)' : cls === 'neutral' ? 'var(--color-neutral-400)'
    : 'var(--color-accent-500)';
}
