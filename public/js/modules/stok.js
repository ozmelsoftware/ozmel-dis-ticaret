// Stok — v2 modülü (v81 yeniden tasarım). Referans: viewStok + viewStokHammaddeSade +
// viewStokYariMamul + hammaddeStokBilgisiByKod + acikSiparislerIcinGerekliKalan (BİREBİR).
// Eski sipariş-seçmeli WIP zaman çizgisi KALDIRILDI — ekran kategori sekmeli ve sade.
//
// 3 sekme: Hammadde / Satınalınan Malzeme / Yarı Mamül (kategori ağaçtan türetilir — core/bom.js).
//   Hammadde/Satınalınan: Kod | Açıklama | Mevcut Stok | Açık Siparişler İçin Gerekli | Kalan
//     (satır açılınca açık sipariş kırılımı). Mevcut = onaylı gelen − tüketilen (malzemenin birimi).
//   Yarı Mamül: Kod | Üretilen (kendi siparişleri, son aşama) | Diğer Ürünlerin İhtiyacı | Kalan.
//
// Tüketim: ürünün rotasındaki EN DÜŞÜK sıra adımının üretimi × BOM kümülatif çarpanı (referans:
// Kesim adı eşleşmesi DEĞİL — TR/EN bağımsız). Gereklilik: core/bom.js urunHammaddeIhtiyaci.
//
// Salt-okuma, form yok, yeni BE ucu yok (hepsi listAll). i18n: bindLang render()'ı VERİ
// ÇEKMEDEN yeniden çağırır; kod/ad'lar sunucudan geldiği gibi basılır.

import { resource } from '../core/api.js';
import { errorState, esc } from '../core/states.js';
import { loadLookup } from '../core/lookups.js';
import { t, bindLang } from '../core/i18n.js';
import { fmtTr } from '../core/format.js';
import { createBom } from '../core/bom.js';

const mapProductFull = (r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, unit: r.unit });

const S = { tab: 'hammadde', openRow: null };   // oturum boyu modül durumu

export async function viewStok(container) {
  container.innerHTML = `<div class="loading">${t('common.loading')}</div>`;

  let products, trees, orders, workOrders, routes, production, requests, receipts, inspections;
  try {
    const d = (n) => resource(n).listAll().then(r => r.data);
    [products, trees, orders, workOrders, routes, production, requests, receipts, inspections] = await Promise.all([
      loadLookup('product-codes', mapProductFull),
      d('product-trees'), d('orders'), d('work-orders'), d('routes'), d('production'),
      d('purchase-requests'), d('purchase-receipts'), d('incoming-inspections'),
    ]);
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(errorState({ message: err.message, onRetry: () => viewStok(container) }));
    return;
  }

  // — Kod ⇄ ürün id eşlemeleri —
  const codeOf = (id) => products.byId.get(id)?.code || ('#' + id);
  const prodByCode = new Map();
  for (const p of products.rows) if (p.code) prodByCode.set(p.code, p);
  const descOf = (code) => prodByCode.get(code)?.name || '';
  const unitOf = (code) => (prodByCode.get(code)?.unit || '').toLowerCase();

  const bom = createBom(trees, (n) => codeOf(n.productCodeId));

  // — Üretim: iş emri id → üretilen (actualQuantity toplamı) —
  const producedByWo = new Map();
  for (const p of production) producedByWo.set(p.workOrderId, (producedByWo.get(p.workOrderId) || 0) + (Number(p.actualQuantity) || 0));
  const woProduced = (woId) => producedByWo.get(woId) || 0;

  // — Rota: ürün id → {min, max} sıra —
  const seqByProduct = new Map();
  for (const r of routes) {
    if (r.sequence == null) continue;
    const e = seqByProduct.get(r.productCodeId) || { min: Infinity, max: -Infinity };
    e.min = Math.min(e.min, r.sequence); e.max = Math.max(e.max, r.sequence);
    seqByProduct.set(r.productCodeId, e);
  }
  // ürün id + sıra → o adımda üretilen (asamaUretilen)
  const stepProduced = (productId, seq) => workOrders.reduce((s, w) =>
    (w.productCodeId === productId && w.sequence === seq) ? s + woProduced(w.id) : s, 0);
  const orderStepProduced = (orderId, seq) => workOrders.reduce((s, w) =>
    (w.orderId === orderId && w.sequence === seq) ? s + woProduced(w.id) : s, 0);

  // — Onaylı gelen: incoming_inspections.overallResult='Uygun' → receipt → request —
  const approvedReceiptIds = new Set(inspections.filter(i => i.overallResult === 'Uygun' && i.purchaseReceiptId != null).map(i => i.purchaseReceiptId));
  const approvedByRequest = new Map();   // requestId → onaylı miktar toplamı
  for (const rc of receipts) {
    if (!approvedReceiptIds.has(rc.id) || rc.purchaseRequestId == null) continue;
    approvedByRequest.set(rc.purchaseRequestId, (approvedByRequest.get(rc.purchaseRequestId) || 0) + (Number(rc.quantity) || 0));
  }
  const orderById = new Map(orders.map(o => [o.id, o]));

  // — Bir malzeme kodunun örnek yaprak düğümü → verim (h) —
  function leafYield(code) {
    const leaf = bom.nodes.find(n => n.code === code && bom.isLeaf(n.id));
    return leaf ? bom.nodeYield(leaf) : null;
  }
  // birimDonusum — referans birebir
  function birimDonusum(miktar, birim, h) {
    const b = String(birim || '').toLowerCase().trim();
    if (!h) return { kg: 0, adet: miktar };
    if (b.includes('kg')) return { kg: miktar, adet: h.parcaAgirligi > 0 ? miktar / h.parcaAgirligi : 0 };
    if (b.includes('tüp') || b.includes('tup') || b.includes('boru')) return { kg: miktar * h.materialWeight, adet: miktar * h.parcaAdedi };
    return { kg: miktar * h.parcaAgirligi, adet: miktar };
  }

  // — hammaddeStokBilgisiByKod (referans birebir) —
  function stokByCode(code) {
    const matId = prodByCode.get(code)?.id;
    const h = leafYield(code);
    let gelenKg = 0, gelenAdet = 0;
    const bagliSiparisler = new Set();
    for (const req of requests) {
      if (req.materialCodeId !== matId) continue;
      const onaylanan = approvedByRequest.get(req.id) || 0;
      const dd = birimDonusum(onaylanan, req.unit, h);
      gelenKg += dd.kg; gelenAdet += dd.adet;
      if (req.orderId != null) { const o = orderById.get(req.orderId); if (o) bagliSiparisler.add(o.orderNo); }
    }
    // Bu malzemeyi kullanan tüm KÖK ürünler; her kökün ilk-sıra üretimi × kümülatif çarpan
    const kullananKokler = new Map();   // rootProductId → root code
    for (const n of bom.nodes) {
      if (n.code !== code) continue;
      let cur = n, guard = 0;
      while (cur && cur.parentId != null && bom.byId.has(cur.parentId) && guard++ < 100) cur = bom.byId.get(cur.parentId);
      if (cur) kullananKokler.set(cur.id, cur.code);   // cur.id = tree node id (kök); kodundan ürün id'si ayrı
    }
    let tuketilenAdet = 0;
    for (const [, kokCode] of kullananKokler) {
      const rootProductId = prodByCode.get(kokCode)?.id;
      if (rootProductId == null) continue;
      const rootNode = bom.nodes.find(n => n.code === kokCode && n.parentId == null);
      if (!rootNode) continue;
      const carpan = bom.collectLeaves(rootNode.id).filter(y => y.node.code === code).reduce((s, y) => s + y.cumUnit, 0);
      const seq = seqByProduct.get(rootProductId);
      if (!seq || seq.min === Infinity) continue;
      const uretilen = stepProduced(rootProductId, seq.min);
      tuketilenAdet += uretilen * carpan;
    }
    const tuketilenKg = h ? tuketilenAdet * h.parcaAgirligi : 0;
    const yuv = (n) => Math.round(n * 1000) / 1000;
    return {
      code, gelenKg: yuv(gelenKg), gelenAdet: Math.round(gelenAdet),
      tuketilenKg: yuv(tuketilenKg), tuketilenAdet: Math.round(tuketilenAdet),
      netKg: yuv(gelenKg - tuketilenKg), netAdet: Math.round(gelenAdet - tuketilenAdet),
      bagliSiparisler: [...bagliSiparisler],
    };
  }

  // — acikSiparislerIcinGerekliKalan (referans birebir) —
  function gerekliKalan(code) {
    const kgBazli = unitOf(code) === 'kg';
    let toplam = 0;
    const detay = [];
    for (const order of orders) {
      if (order.status === 'Tamamlandı') continue;
      const urunKod = codeOf(order.productCodeId);
      const liste = bom.requirement(urunKod, order.targetQuantity);
      const kayit = liste.find(l => l.code === code);
      if (!kayit) continue;
      const tamGerekli = kgBazli ? (kayit.toplamAgirlik ?? kayit.gerekliParca) : kayit.gerekliParca;
      if (!tamGerekli) continue;
      const seq = seqByProduct.get(order.productCodeId);
      if (!seq || seq.min === Infinity) continue;
      const uretilenBu = orderStepProduced(order.id, seq.min);
      const oran = tamGerekli / order.targetQuantity;
      const tuketilenBu = uretilenBu * oran;
      const kalan = Math.max(0, tamGerekli - tuketilenBu);
      if (kalan > 0.0001) { toplam += kalan; detay.push({ orderId: order.id, orderNo: order.orderNo, kalan: Math.round(kalan * 100) / 100 }); }
    }
    return { toplam: Math.round(toplam * 100) / 100, detay };
  }

  render();
  bindLang(container, render);

  function render() {
    const kategoriler = bom.codesByCategory();
    if (trees.length === 0) {
      container.innerHTML = headHTML() + emptyBox(t('stok.emptyNoTree'), t('stok.emptyNoTreeHint'));
      return;
    }
    const tabBar = `
      <div class="panel"><div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap;">
        ${tabBtn('hammadde', t('stok.tabRaw'), kategoriler['Hammadde'].length)}
        ${tabBtn('satinalinan', t('stok.tabBought'), kategoriler['Satınalınan Malzeme'].length)}
        ${tabBtn('yarimamul', t('stok.tabSemi'), kategoriler['Yarı Mamül'].length)}
      </div></div>`;
    const bodyHTML = S.tab === 'yarimamul'
      ? renderYariMamul(kategoriler['Yarı Mamül'])
      : renderHammadde(kategoriler[S.tab === 'hammadde' ? 'Hammadde' : 'Satınalınan Malzeme']);

    container.innerHTML = headHTML() + tabBar + bodyHTML;
    bindEvents();
  }

  function headHTML() {
    return `
      <div class="module-head"><div>
        <h2>${esc(t('menu.stok'))}</h2>
        <div class="text-muted" style="font-size:13.5px; margin-top:6px;">${esc(t('stok.subtitle'))}</div>
      </div></div>`;
  }

  function tabBtn(id, label, n) {
    return `<button class="btn ${S.tab === id ? 'btn-primary' : 'btn-ghost'}" data-tab="${id}">${esc(label)} (${n})</button>`;
  }

  // Hammadde / Satınalınan (ortak tablo) — viewStokHammaddeSade
  function renderHammadde(codes) {
    if (!codes.length) return `<div class="panel"><div class="panel-body text-muted" style="padding:18px;">${esc(t('stok.emptyCat'))}</div></div>`;
    const rows = codes.map(code => {
      const bilgi = stokByCode(code);
      const kgBazli = unitOf(code) === 'kg';
      const birim = kgBazli ? t('stok.kg') : t('stok.piece');
      const mevcut = kgBazli ? bilgi.netKg : bilgi.netAdet;
      const gerekli = gerekliKalan(code);
      const kalan = Math.round((mevcut - gerekli.toplam) * 100) / 100;
      const acik = S.openRow === code;
      const expandable = gerekli.detay.length > 0;
      const kalanColor = kalan < 0 ? 'var(--color-danger)' : 'var(--color-success)';
      const detayHTML = (acik && expandable) ? `
        <tr><td colspan="5" style="background:var(--color-surface-2, var(--color-neutral-100)); padding:10px 20px;">
          ${gerekli.detay.map(dt => `<div style="display:flex;justify-content:space-between;max-width:320px;padding:3px 0;font-size:13px;">
            <a class="xlink mono" href="#orders?id=${dt.orderId}">${esc(dt.orderNo || '')}</a>
            <span class="mono">${esc(fmtTr(dt.kalan))} ${esc(birim)}</span>
          </div>`).join('')}
        </td></tr>` : '';
      return `
        <tr${expandable ? ` class="stok-expandable" data-row="${esc(code)}" style="cursor:pointer;"` : ''}>
          <td class="mono"><b>${esc(code)}</b></td>
          <td>${esc(descOf(code))}</td>
          <td class="mono" style="text-align:right;">${esc(fmtTr(mevcut))} ${esc(birim)}</td>
          <td class="mono" style="text-align:right;">${gerekli.toplam > 0 ? esc(fmtTr(gerekli.toplam) + ' ' + birim) : '<span class="text-muted">—</span>'} ${expandable ? `<span class="text-muted">${acik ? '▾' : '▸'}</span>` : ''}</td>
          <td class="mono" style="text-align:right;"><b style="color:${kalanColor};">${esc(fmtTr(kalan))} ${esc(birim)}</b></td>
        </tr>${detayHTML}`;
    }).join('');
    return `
      <div class="panel"><div class="table-wrap" style="overflow-x:auto;"><table class="table">
        <thead><tr>
          <th>${esc(t('stok.colCode'))}</th><th>${esc(t('stok.colDesc'))}</th>
          <th style="text-align:right;">${esc(t('stok.colCurrent'))}</th>
          <th style="text-align:right;">${esc(t('stok.colNeeded'))}</th>
          <th style="text-align:right;">${esc(t('stok.colRemain'))}</th>
        </tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  // Yarı Mamül — viewStokYariMamul
  function renderYariMamul(codes) {
    if (!codes.length) return `<div class="panel"><div class="panel-body text-muted" style="padding:18px;">${esc(t('stok.emptySemi'))}</div></div>`;
    const rows = codes.map(code => {
      const productId = prodByCode.get(code)?.id;
      const seq = productId != null ? seqByProduct.get(productId) : null;
      const sonSira = seq && seq.max !== -Infinity ? seq.max : null;
      let uretilen = 0;
      if (sonSira != null) for (const o of orders) if (o.productCodeId === productId && o.status !== 'Tamamlandı') uretilen += orderStepProduced(o.id, sonSira);
      const gerekli = gerekliKalan(code);
      const kalan = Math.round((uretilen - gerekli.toplam) * 100) / 100;
      const kalanColor = kalan < 0 ? 'var(--color-danger)' : 'var(--color-success)';
      const piece = t('stok.piece');
      return `
        <tr>
          <td class="mono"><b>${esc(code)}</b></td>
          <td class="mono" style="text-align:right;">${esc(fmtTr(uretilen))} ${esc(piece)}</td>
          <td class="mono" style="text-align:right;">${gerekli.toplam > 0 ? esc(fmtTr(gerekli.toplam) + ' ' + piece) : '<span class="text-muted">—</span>'}</td>
          <td class="mono" style="text-align:right;"><b style="color:${kalanColor};">${esc(fmtTr(kalan))} ${esc(piece)}</b></td>
        </tr>`;
    }).join('');
    return `
      <div class="panel"><div class="panel-body text-muted" style="font-size:12.5px;">${esc(t('stok.semiHint'))}</div>
        <div class="table-wrap" style="overflow-x:auto;"><table class="table">
          <thead><tr>
            <th>${esc(t('stok.colCode'))}</th>
            <th style="text-align:right;">${esc(t('stok.colSemiProduced'))}</th>
            <th style="text-align:right;">${esc(t('stok.colSemiNeeded'))}</th>
            <th style="text-align:right;">${esc(t('stok.colRemain'))}</th>
          </tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function emptyBox(title, hint) {
    return `<div class="panel"><div class="panel-body" style="text-align:center;padding:48px 24px;">
      <div style="font-size:18px;font-weight:600;">${esc(title)}</div>
      <div class="text-muted" style="margin-top:8px;font-size:14px;">${esc(hint)}</div></div></div>`;
  }

  function bindEvents() {
    container.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.openRow = null; render(); }));
    container.querySelectorAll('.stok-expandable').forEach(tr => tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;   // sipariş bağlantısına tıklama satırı açmasın
      const code = tr.dataset.row; S.openRow = S.openRow === code ? null : code; render();
    }));
  }
}
