// _orderReport.js — sipariş özeti + durum rozeti + rapor gövdesi (ortak).
// Satış Siparişleri (Rapor modalı) ve Satış Raporları (açılır panel) paylaşır.
// Referans (docs/referans/2026-09-30.html): orderStats, orderStatusBadge, siparisRaporIcerigi,
// workOrderStats, productDailyTarget, orderSteps.
//
// ctx: ortak veri + yardımcılar — çağıran bir kez kurar, her sipariş için geçer:
//   { woByOrder:Map, producedByWo:Map, production:[], plans:[], today:Date,
//     getCapacity:fn, productBottleneck:fn, products, ops, centers }   // lookups: .byId / .label
//
// İlerleme/hedef YALNIZ SON rota adımından (müşteriye giden bitmiş ürün son adımdan çıkar).
// İKİ AYRI kapasite: (a) ETA yedek hızı = O ADIMIN kapasitesi (getCapacity); (b) Kapasite
// Yetersiz rozeti = ürünün DARBOĞAZ kapasitesi (productBottleneck). Karıştırma.

import { esc } from '../core/states.js';
import { t } from '../core/i18n.js';
import { fmtTr, fmtDateTR } from '../core/format.js';
import { fmtISO, parseISO, addDays } from '../core/report.js';
import { estimateCompletion } from '../core/eta.js';

// İş emri etiketi: woNo + split (varsa). Referans woNoGoster sipariş no + sıradan üretir;
// v2 kaydedilmiş woNo'yu kullanır.
export function woLabel(w) { return (w.woNo || '') + (w.splitLabel ? '-' + w.splitLabel : ''); }

// Bir iş emrinin (adımın) kendi kapasitesi — ETA yedek hızı (referans capForStep).
function stepCapOf(order, w, ctx) {
  return ctx.getCapacity(order.productCodeId, w.workCenterId, w.operationId)?.capacity ?? null;
}

// Referans orderStats: son adım iş emirlerinden ilerleme + ETA + kapasite/gecikme riski.
export function orderSummary(order, ctx) {
  const wos = ctx.woByOrder.get(order.id) || [];
  // SAPMA 1 (düzeltildi): son adım = iş emirlerinin EN BÜYÜK sequence'i (referans maxSira),
  // ürünün rotasındaki en büyük sequence DEĞİL. Şu an sonuç aynı; rotaya adım eklenirse ayrışır.
  const lastSeq = wos.length ? wos.reduce((m, w) => Math.max(m, Number(w.sequence) || 0), -Infinity) : null;
  const lastWos = lastSeq == null ? [] : wos.filter(w => Number(w.sequence) === lastSeq);
  const hedef = lastWos.reduce((s, w) => s + (Number(w.targetQuantity) || 0), 0);
  const uretilen = lastWos.reduce((s, w) => s + (ctx.producedByWo.get(w.id) || 0), 0);
  const kalan = Math.max(0, hedef - uretilen);
  const pct = hedef > 0 ? Math.round(uretilen / hedef * 100) : 0;
  // Hesaplanan tamamlanma — YALNIZ ETA etiketi/eta atlaması için (rozet DEĞİL; rozet
  // Tamamlandı'yı yalnız sipariş durumundan alır). 20.000/20.000 ama durumu Aktif olan
  // sipariş "Zamanında" rozeti alır, bitiş kutusunda "Tamamlandı" yazar — referans böyle.
  const doneByProduction = hedef > 0 && uretilen >= hedef;

  // SAPMA 2 (düzeltildi): ETA yedek hızı = O ADIMIN kapasitesi (referans capForStep/
  // getCapacity(ürün, iş merkezi, operasyon)), ürün darboğazı DEĞİL. Makine planı varsa
  // plan-bazlı ETA önceliklidir (estimateCompletion opts.plans). Üretimi/planı olmayan adımda
  // adım kapasitesine düşer, böylece başlamamış siparişte de ETA dolu.
  let eta = null;
  if (wos.length && !doneByProduction) {
    for (const w of lastWos) {
      const est = estimateCompletion(w, ctx.production, { today: ctx.today, fallbackRate: stepCapOf(order, w, ctx), plans: ctx.plans });
      if (est.etaDate && (!eta || est.etaDate > eta)) eta = est.etaDate;
    }
  }
  const due = order.requestedDeliveryDate ? parseISO(order.requestedDeliveryDate) : null;
  // Gecikme Riski: son adımın en geç ETA'sı > siparişin istenen teslim tarihi. Referansın
  // geçerli workOrderStats'ı (2. tanım) da siparişin teslim tarihine bakar — hesap doğru.
  const riskli = !!(eta && due && eta > due);
  // Kapasite Yetersiz (AYRI kapasite): başlangıç + ⌈hedef / DARBOĞAZ kapasitesi⌉ gün > istenen
  // teslim (referans feasible === false). Sipariş hedefi kullanılır (son adım toplamı değil).
  const bottleneckCap = ctx.productBottleneck(order.productCodeId).bottleneck?.capacity ?? null;
  const orderTarget = Number(order.targetQuantity) || 0;
  const start = order.startDate ? parseISO(order.startDate) : ctx.today;
  let gerekliGun = null, planFinish = null, kapasiteYetersiz = false;
  if (bottleneckCap > 0 && orderTarget > 0) {
    gerekliGun = Math.ceil(orderTarget / bottleneckCap);
    planFinish = addDays(start, gerekliGun);
    if (due) kapasiteYetersiz = planFinish > due;
  }
  return { wos, lastWos, hedef, uretilen, kalan, pct, doneByProduction, bottleneckCap, eta, due,
    riskli, gerekliGun, planFinish, kapasiteYetersiz, isEmriVar: wos.length > 0 };
}

// Referans orderStatusBadge + "İş Emri Bekliyor". Öncelik sırası (brief bölüm 3, Adım 1):
// iş emri yok → Tamamlandı (durum) → İptal (durum) → Gecikme Riski → Kapasite Yetersiz → Zamanında.
// SAPMA 4: sipariş durumu sözlüğü bu adımda DEĞİŞTİRİLMEZ; rozet yalnız Tamamlandı/İptal
// değerlerine bakar (ikisi de Order::STATUSES'te var). ETL "Aktif" yazdığından çoğu sipariş
// alttaki üç dala düşer.
export function orderStatus(order, z) {
  if (!z.isEmriVar) return { text: t('ss.stWaiting'), cls: 'warning' };
  if (order.status === 'Tamamlandı') return { text: t('ss.stDone'), cls: 'success' };
  if (order.status === 'İptal') return { text: t('ss.stCancelled'), cls: 'neutral' };
  if (z.riskli) return { text: t('ss.stRisk'), cls: 'danger' };
  if (z.kapasiteYetersiz) return { text: t('ss.stCapacity'), cls: 'warning' };
  return { text: t('ss.stOnTime'), cls: 'success' };
}

// Referans siparisRaporIcerigi — rapor gövdesi (modal body / açılır panel body) HTML döner.
export function orderReportBody(order, z, ctx) {
  const { products, ops, centers, producedByWo, production, today } = ctx;
  const p = products.byId.get(order.productCodeId) || {};
  const dash = t('common.dash');
  const etaText = z.doneByProduction ? t('ss.stDone') : (z.eta ? fmtDateTR(fmtISO(z.eta)) : dash);

  const info = [
    [t('ss.customer'), order.customer || dash],
    [t('ss.product'), (p.code || '') + (p.name ? ' — ' + p.name : '')],
    [t('ss.qty'), fmtTr(order.targetQuantity)],
    [t('ss.orderDate'), order.startDate ? fmtDateTR(order.startDate) : dash],
    [t('ss.due'), order.requestedDeliveryDate ? fmtDateTR(order.requestedDeliveryDate) : dash],
  ].map(([l, v]) => `<div><div class="ss-r-lbl">${esc(l)}</div><div class="mono ss-r-val">${esc(v)}</div></div>`).join('');

  let etaBlock;
  if (!z.isEmriVar) {
    etaBlock = `<div class="ss-r-warn">${esc(t('ss.noWo'))}</div>`;
  } else {
    const kpis = [
      { lbl: t('ss.kpiProduced'), val: `${fmtTr(z.uretilen)} / ${fmtTr(z.hedef)}`, color: 'var(--color-accent-500)' },
      { lbl: t('ss.kpiRemaining'), val: fmtTr(Math.max(0, z.hedef - z.uretilen)), color: 'var(--color-accent-500)' },
      { lbl: t('ss.kpiEta'), val: etaText, color: z.riskli ? 'var(--color-danger)' : 'var(--color-success)' },
    ].map(k => `<div class="ss-kpi" style="border-top-color:${k.color};"><div class="ss-kpi-lbl">${esc(k.lbl)}</div><div class="ss-kpi-val">${esc(k.val)}</div></div>`).join('');
    etaBlock = `<div class="ss-kpis">${kpis}</div><div class="text-muted" style="font-size:12.5px; margin-top:10px;">${esc(t('ss.etaNote'))}</div>`;
  }

  // Bölünmüş son adım (>1 iş emri): her biri ayrı ETA.
  let splitBlock = '';
  if (z.lastWos.length > 1) {
    const rows = z.lastWos.map(w => {
      // Aynı hesap: makine planı > fiili ortalama > adım kapasitesi.
      const est = estimateCompletion(w, production, { today, fallbackRate: stepCapOf(order, w, ctx), plans: ctx.plans });
      const eta = est.complete ? t('ss.stDone')
        : (est.etaDate ? fmtDateTR(fmtISO(est.etaDate)) + (est.planInsufficient ? t('ss.planInsufficient') : '') : dash);
      return `<tr><td class="mono">${esc(woLabel(w))}</td><td>${esc(centers.label(w.workCenterId))}</td>
        <td class="mono" style="text-align:right;">${esc(fmtTr(w.targetQuantity))}</td>
        <td class="mono" style="text-align:right;">${esc(fmtTr(producedByWo.get(w.id) || 0))}</td>
        <td class="mono">${esc(eta)}</td></tr>`;
    }).join('');
    splitBlock = `
      <div style="margin-top:20px;">
        <div class="text-muted" style="font-size:12.5px; margin-bottom:8px;">${esc(t('ss.splitNote'))}</div>
        <table class="ss-r-table">
          <thead><tr><th>${esc(t('ss.colWo'))}</th><th>${esc(t('ss.colMachine'))}</th><th style="text-align:right;">${esc(t('ss.colTarget'))}</th><th style="text-align:right;">${esc(t('ss.colProduced'))}</th><th>${esc(t('ss.colEta'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // Tüm iş emirleri (rota sırasına göre).
  let allBlock = '';
  if (z.isEmriVar) {
    const sorted = z.wos.slice().sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
    const rows = sorted.map(w => {
      const done = producedByWo.get(w.id) || 0;
      const tgt = Number(w.targetQuantity) || 0;
      const pct = tgt > 0 ? Math.min(100, Math.round(done / tgt * 100)) : 0;
      return `<tr><td class="mono">${esc(woLabel(w))}</td><td>${esc(ops.label(w.operationId))}</td><td>${esc(centers.label(w.workCenterId))}</td>
        <td><div class="ss-prog"><span class="ss-prog-bar"><i style="width:${pct}%; background:var(--color-accent-500);"></i></span><span class="mono ss-prog-pct">%${pct}</span></div></td></tr>`;
    }).join('');
    allBlock = `
      <div style="margin-top:20px;">
        <div class="ss-r-sec">${esc(t('ss.woSection'))}</div>
        <table class="ss-r-table">
          <thead><tr><th>${esc(t('ss.colWoNo'))}</th><th>${esc(t('ss.colOperation'))}</th><th>${esc(t('ss.colMachine'))}</th><th>${esc(t('ss.colProgress'))}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  return `
    <div class="ss-r-info">${info}</div>
    <div class="ss-r-eta"><div class="ss-r-sec">${esc(t('ss.etaSection'))}</div>${etaBlock}</div>
    ${splitBlock}
    ${allBlock}`;
}
