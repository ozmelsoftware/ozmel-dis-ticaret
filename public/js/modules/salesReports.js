// Satış Raporları — v2 (SALT OKUNUR). Satış siparişlerinin açılır-kapanır konsolide listesi.
// Referans: v78 viewSatisRaporlari. Her sipariş core/collapsible.js paneli; gövdesi ORTAK
// _orderReport.js:orderReportBody (Satış Siparişleri Rapor modalıyla AYNI içerik). Yalnız
// source='satis'. Migration/yeni BE yok — Satış Siparişleri ile aynı listAll çağrıları.
//
// Eski sürümdeki tarih filtresi, müşteri filtresi, aylık grafik, ürün/müşteri kırılımı
// KALDIRILDI (yanlış çift sayım yapıyordu; brief). i18n: dil değişince veri ÇEKMEDEN
// yeniden çizilir (bindLang); katlama durumu collapsiblePanel'de (localStorage).

import { resource, request } from '../core/api.js';
import { errorState, emptyState, esc } from '../core/states.js';
import { loadLookup, mapProduct, mapNamed } from '../core/lookups.js';
import { t, bindLang } from '../core/i18n.js';
import { fmtTr, fmtDateTR } from '../core/format.js';
import { startOfDay } from '../core/report.js';
import { createCapacityHelpers } from '../core/bottleneck.js';
import { collapsiblePanel } from '../core/collapsible.js';
import { orderSummary, orderStatus, orderReportBody } from './_orderReport.js';

export async function viewSalesReports(container) {
  container.innerHTML = `<div class="loading">${t('common.loading')}</div>`;
  let products, ops, centers, orders, workOrders, production, routes, caps, wh, plans;
  try {
    let allOrders;
    [products, ops, centers, allOrders, workOrders, production, routes, caps, wh, plans] = await Promise.all([
      loadLookup('product-codes', mapProduct),
      loadLookup('operations', mapNamed),
      loadLookup('work-centers', mapNamed),
      resource('orders').listAll().then(r => r.data),
      resource('work-orders').listAll().then(r => r.data),
      resource('production').listAll().then(r => r.data),
      resource('routes').listAll().then(r => r.data),
      resource('capacities').listAll().then(r => r.data),
      request('/working-hours').then(r => r.data),
      resource('machine-plans').listAll().then(r => r.data),
    ]);
    orders = allOrders.filter(o => o.source === 'satis');
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(errorState({ message: err.message, onRetry: () => viewSalesReports(container) }));
    return;
  }

  // İki ayrı kapasite (ETA adım kapasitesi / Kapasite Yetersiz darboğazı) — Satış Siparişleri ile aynı bağlam.
  const { getCapacity, productBottleneck } = createCapacityHelpers({ caps, routes, wh, products, ops, centers, t });
  const woByOrder = new Map();
  for (const w of workOrders) { if (!woByOrder.has(w.orderId)) woByOrder.set(w.orderId, []); woByOrder.get(w.orderId).push(w); }
  const producedByWo = new Map();
  for (const p of production) producedByWo.set(p.workOrderId, (producedByWo.get(p.workOrderId) || 0) + (Number(p.actualQuantity) || 0));
  const today = startOfDay(new Date());
  const ctx = { woByOrder, producedByWo, production, plans, today, getCapacity, productBottleneck, products, ops, centers };

  // Sıralama: startDate, yeniden eskiye.
  orders.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));

  let search = '';

  // Arama: ürün (kod/ad), müşteri, satış sipariş no, takip no.
  function visible() {
    const q = search.trim().toLocaleLowerCase('tr');
    if (!q) return orders;
    return orders.filter(o => {
      const p = products.byId.get(o.productCodeId) || {};
      const hay = [o.customer || '', o.salesOrderNo || '', o.orderNo || '', p.code || '', p.name || '']
        .join(' ').toLocaleLowerCase('tr');
      return hay.includes(q);
    });
  }

  render();
  bindLang(container, render);

  function render() {
    container.innerHTML = `
      <div class="module-head">
        <div>
          <h2>${esc(t('menu.sales'))}</h2>
          <div class="text-muted" style="font-size:13.5px; margin-top:6px;">${esc(t('sr.subtitle'))}</div>
        </div>
      </div>
      <div class="toolbar" style="align-items:center; gap:12px; flex-wrap:wrap;">
        <div class="search"><input class="input" type="search" id="sr-search" placeholder="${esc(t('ss.searchPlaceholder'))}" value="${esc(search)}"></div>
        <span class="mono text-muted" id="sr-count" style="font-size:12px; margin-left:auto;"></span>
      </div>
      <div id="sr-list"></div>`;

    const inp = container.querySelector('#sr-search');
    inp.addEventListener('input', () => { search = inp.value; paint(); });
    paint();
  }

  function paint() {
    const list = visible();
    container.querySelector('#sr-count').textContent = t('ss.counter', { shown: list.length, total: orders.length });
    const host = container.querySelector('#sr-list');
    host.innerHTML = '';

    if (orders.length === 0) {
      host.appendChild(emptyState({ title: t('sr.emptyTitle'), message: t('sr.emptyBody') }));
      return;
    }
    if (list.length === 0) {
      host.appendChild(emptyState({ title: t('ss.empty') }));
      return;
    }

    const dash = t('common.dash');
    for (const o of list) {
      const z = orderSummary(o, ctx);
      const st = orderStatus(o, z);
      const p = products.byId.get(o.productCodeId) || {};
      // metaHTML bileşen tarafından esc'lenmez — değerleri burada esc ile üret.
      const meta = [
        esc(o.customer || dash),
        esc(p.code || ('#' + o.productCodeId)),
        esc(t('sr.metaQty', { n: fmtTr(o.targetQuantity) })),
        esc(t('sr.metaDue', { date: o.requestedDeliveryDate ? fmtDateTR(o.requestedDeliveryDate) : dash })),
      ].join(' · ');
      host.appendChild(collapsiblePanel({
        key: `sr.order.${o.id}`,
        title: o.orderNo || o.salesOrderNo || dash,
        metaHTML: meta,
        rightHTML: `<span class="ss-badge ss-badge-${st.cls}">${esc(st.text)}</span>`,
        defaultCollapsed: true,
        // Gövde yalnız açıkken üretilir (tembel). Satış Siparişleri Rapor modalıyla aynı içerik.
        body: () => { const d = document.createElement('div'); d.className = 'sr-report'; d.innerHTML = orderReportBody(o, z, ctx); return d; },
        onToggle: paint,
      }));
    }
  }
}
