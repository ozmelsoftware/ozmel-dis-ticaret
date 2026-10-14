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
import { startOfDay, fmtISO } from '../core/report.js';
import { createCapacityHelpers } from '../core/bottleneck.js';
import { collapsiblePanel } from '../core/collapsible.js';
import { orderSummary, orderStatus, orderReportBody } from './_orderReport.js';

// Görünüm + açık pano satırları oturum boyu korunur (modüle dönünce aynı kalır).
const SR = { view: 'liste', panoOpen: new Set() };

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

  // — Pano yardımcıları (referans siparisGenelYuzde / siparisTamamlandiMi / workOrderStats.pct) —
  const todayISO = fmtISO(today);
  const stepsOf = (o) => (woByOrder.get(o.id) || []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const woDone = (w) => producedByWo.get(w.id) || 0;
  const woPct = (w) => { const tgt = w.targetQuantity || 0; return tgt > 0 ? Math.min(100, Math.round(woDone(w) / tgt * 100)) : 0; };
  const genelYuzde = (o) => { const s = stepsOf(o); if (!s.length) return 0; const done = s.filter(w => (w.targetQuantity || 0) > 0 && woDone(w) >= w.targetQuantity).length; return Math.round(done / s.length * 100); };
  const tamamMi = (o) => { const s = stepsOf(o); return s.length > 0 && s.every(w => (w.targetQuantity || 0) > 0 && woDone(w) >= w.targetQuantity); };

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
    const toggle = `
      <div class="panel"><div class="panel-body" style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ${SR.view === 'liste' ? 'btn-primary' : 'btn-ghost'}" data-view="liste">${esc(t('sr.viewList'))}</button>
        <button class="btn ${SR.view === 'pano' ? 'btn-primary' : 'btn-ghost'}" data-view="pano">${esc(t('sr.viewPano'))}</button>
      </div></div>`;
    container.innerHTML = `
      <div class="module-head">
        <div>
          <h2>${esc(t('menu.sales'))}</h2>
          <div class="text-muted" style="font-size:13.5px; margin-top:6px;">${esc(t('sr.subtitle'))}</div>
        </div>
      </div>
      ${toggle}
      ${SR.view === 'pano' ? `<div id="sr-pano"></div>` : `
      <div class="toolbar" style="align-items:center; gap:12px; flex-wrap:wrap;">
        <div class="search"><input class="input" type="search" id="sr-search" placeholder="${esc(t('ss.searchPlaceholder'))}" value="${esc(search)}"></div>
        <span class="mono text-muted" id="sr-count" style="font-size:12px; margin-left:auto;"></span>
      </div>
      <div id="sr-list"></div>`}`;

    container.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { SR.view = b.dataset.view; render(); }));
    if (SR.view === 'pano') { paintPano(); return; }
    const inp = container.querySelector('#sr-search');
    inp.addEventListener('input', () => { search = inp.value; paint(); });
    paint();
  }

  function paintPano() {
    const host = container.querySelector('#sr-pano');
    const dash = t('common.dash');
    const list = orders.filter(o => !tamamMi(o))
      .sort((a, b) => (a.requestedDeliveryDate || '9999-99-99').localeCompare(b.requestedDeliveryDate || '9999-99-99'));

    const body = list.length === 0
      ? `<div style="color:#8b949e; text-align:center; padding:60px 0; font-size:16px;">${esc(t('sr.panoEmpty'))}</div>`
      : `<div style="display:flex; flex-direction:column; gap:10px;">${list.map(o => {
        const steps = stepsOf(o);
        const gecikmis = o.requestedDeliveryDate && o.requestedDeliveryDate < todayISO;
        const acik = SR.panoOpen.has(o.id);
        const gy = genelYuzde(o);
        const renk = gy >= 100 ? '#3fb950' : gy > 0 ? '#58a6ff' : '#30363d';
        const p = products.byId.get(o.productCodeId) || {};
        return `<div>
          <div class="sr-pano-bar" data-oid="${o.id}" style="position:relative; height:52px; background:#21262d; border-radius:8px; overflow:hidden; cursor:pointer; border:1px solid #30363d;">
            <div style="position:absolute; inset:0; width:${gy}%; background:${renk}; transition:width .2s;"></div>
            <div style="position:relative; z-index:1; height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 18px;">
              <div style="display:flex; align-items:center; gap:12px;">
                <span style="font-family:var(--font-mono); font-size:11px; color:#e6edf3; opacity:.85;">${acik ? '▼' : '▶'}</span>
                <span style="font-family:var(--font-mono); font-weight:700; font-size:19px; color:#e6edf3; text-shadow:0 1px 2px rgba(0,0,0,.4);">${esc(o.orderNo || o.salesOrderNo || '')}</span>
                ${steps.length === 0 ? `<span style="font-size:13px; color:#f0883e;">${esc(t('sr.panoWaiting'))}</span>` : ''}
                ${gecikmis ? `<span style="font-size:12px; color:#f85149; font-weight:600;">${esc(t('sr.panoLate'))}</span>` : ''}
              </div>
              <span style="font-family:var(--font-mono); font-weight:700; font-size:19px; color:#e6edf3; text-shadow:0 1px 2px rgba(0,0,0,.4);">%${gy}</span>
            </div>
          </div>
          ${acik ? `<div style="background:#161b22; border:1px solid #30363d; border-top:none; border-radius:0 0 8px 8px; padding:16px 20px;">
            <div style="font-size:14px; color:#8b949e; margin-bottom:12px;">${esc(o.customer || dash)} · ${esc(p.code || ('#' + o.productCodeId))} · ${esc(t('sr.metaQty', { n: fmtTr(o.targetQuantity) }))} · ${esc(t('sr.metaDue', { date: o.requestedDeliveryDate ? fmtDateTR(o.requestedDeliveryDate) : dash }))}</div>
            ${steps.length === 0 ? '' : `<div style="display:flex; flex-direction:column; gap:9px;">${steps.map(w => {
              const pct = woPct(w);
              const barRenk = pct >= 100 ? '#3fb950' : pct > 0 ? '#58a6ff' : '#30363d';
              return `<div style="display:grid; grid-template-columns:140px 1fr 42px; align-items:center; gap:10px;">
                <span style="font-size:14px; color:${pct > 0 ? '#e6edf3' : '#6e7681'};">${esc(ops.label(w.operationId))}</span>
                <div style="height:10px; background:#21262d; border-radius:5px; overflow:hidden;"><div style="height:100%; width:${pct}%; background:${barRenk};"></div></div>
                <span style="font-size:14px; font-family:var(--font-mono); color:#8b949e; text-align:right;">${pct}</span>
              </div>`;
            }).join('')}</div>`}
          </div>` : ''}
        </div>`;
      }).join('')}</div>`;

    host.innerHTML = `
      <div id="satis-pano-root" style="background:#0d1117; border-radius:8px; padding:24px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
          <div style="color:#e6edf3; font-family:var(--font-heading); font-size:22px; font-weight:600;">${esc(t('sr.panoTitle'))}</div>
          <button class="btn btn-sm btn-ghost sr-pano-fs" style="color:#e6edf3; border-color:#30363d;">⛶ ${esc(t('pano.fullscreen'))}</button>
        </div>
        ${body}
      </div>`;

    host.querySelectorAll('.sr-pano-bar').forEach(el => el.addEventListener('click', () => {
      const id = Number(el.dataset.oid);
      if (SR.panoOpen.has(id)) SR.panoOpen.delete(id); else SR.panoOpen.add(id);
      paintPano();
    }));
    const fs = host.querySelector('.sr-pano-fs');
    if (fs) fs.addEventListener('click', () => {
      const root = host.querySelector('#satis-pano-root');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (root && root.requestFullscreen) root.requestFullscreen().catch(() => {});
    });
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
