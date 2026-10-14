// table.js — liste bileseni. Sutun tanimindan tablo uretir; arama + sayfalama +
// satir aksiyonlari (Duzenle/Sil). Salt okuma kullanicida aksiyonlar devre disi + ipucu.
//
// Veriyi bir kez `load()` ile alir; arama ve sayfalama ISTEMCI tarafinda (backend
// arama parametresi almiyor; master tablolar kucuk). reload() cache'i tazeler.

import { skeleton, emptyState, errorState, esc } from './states.js';
import { flashRow } from './toast.js';
import { t, onLangChange } from './i18n.js';

// Etiketler string ya da () => string olabilir — modüller t()'yi geçirip dile göre çevirir.
const lbl = (v) => (typeof v === 'function' ? v() : (v ?? ''));

export class DataTable {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   title: string,
   *   columns: Array<{key?:string, label:string, render?:Function, className?:string}>,
   *   load: () => Promise<Array>,
   *   rowId?: Function, pageSize?: number, searchable?: boolean,
   *   searchText?: (row)=>string, canWrite?: boolean,
   *   addLabel?: string, onAdd?: Function, onEdit?: Function, onDelete?: Function,
   *   emptyMessage?: string,
   *   rowClass?: (row)=>string,   // <tr>'e eklenecek sinif (or. uyari seridi)
   *   flagFilter?: { test:(row)=>boolean, label:(n:number)=>string },
   *                               // toolbar'da tiklanabilir sayac; yalnizca isaretli satirlar
   *   facetFilter?: { values:string[], get:(row)=>string, label?:(v)=>string }
   *                               // tablo ustunde coklu-secim cipleri; secili degerler suzer
   * }} opts
   */
  constructor(container, opts) {
    this.c = container;
    this.o = Object.assign({
      rowId: (r) => r.id, pageSize: 50, searchable: true, canWrite: true,
      searchText: (r) => Object.values(r).join(' ')
    }, opts);
    this.all = null;
    this.search = '';
    this.page = 1;
    this.activeId = null;
    // Çapraz bağlantı odağı: ilk yüklemeden sonra bu id'li satıra git (sayfayı ayarla,
    // genişlet, vurgula). Bir kez uygulanır; dil değişiminde tekrarlanmaz.
    this._focusId = this.o.focusId != null ? String(this.o.focusId) : null;
    this.expanded = new Set();   // genişletilmiş satır id'leri (opts.expand verilmişse)
    this.flagActive = false;     // flagFilter sayacı açık mı (yalnızca işaretli satırlar)
    this.facetActive = new Set();// facetFilter'da seçili değerler (boşsa: hepsi)
    // Dil değişince yalnızca ETİKETLER yeniden çizilir (veri + sayfa/arama/filtre korunur).
    this._unsub = onLangChange(() => this.relabel());
    this.render();
  }

  /** Dil değişimi: bu tablo hâlâ ekrandaysa yeniden çiz (this.all dolu -> load atlanır,
   *  durum korunur); başka modüle geçilmişse aboneliği bırak. */
  relabel() {
    if (this._headEl && this.c.contains(this._headEl)) this.render();
    else this._unsub?.();
  }

  async render() {
    this.c.innerHTML = '';
    this._headEl = this.head();
    this.c.appendChild(this._headEl);
    if (this.o.searchable) this.c.appendChild(this.toolbar());
    if (this.o.facetFilter) { this.facetHost = el('div', 'facet-bar'); this.c.appendChild(this.facetHost); }
    this.body = document.createElement('div');
    this.c.appendChild(this.body);

    this.body.appendChild(skeleton(8));
    if (this.all === null) {
      try { this.all = await this.o.load(); }
      catch (err) {
        this.body.innerHTML = '';
        this.body.appendChild(errorState({ message: err.message, onRetry: () => this.reload() }));
        return;
      }
    }
    if (this._focusId != null) this._prepareFocus(this._focusId);
    this.paint();
    if (this._focusId != null) { this._flashFocus(this._focusId); this._focusId = null; }
  }

  /** Odak satırını içeren sayfayı seç + (varsa) genişlet + aktif işaretle (paint ÖNCESİ). */
  _prepareFocus(id) {
    id = String(id);
    const rows = this.filtered();
    const idx = rows.findIndex(r => String(this.o.rowId(r)) === id);
    if (idx < 0) return;
    this.page = Math.floor(idx / this.o.pageSize) + 1;
    this.activeId = id;
    if (this.o.expand) this.expanded.add(id);
  }

  /** Odak satırını vurgula + görünüme kaydır (paint SONRASI). */
  _flashFocus(id) {
    const tr = this.body?.querySelector(`tbody tr[data-id="${cssEsc(String(id))}"]`);
    if (tr) { flashRow(tr); tr.scrollIntoView({ block: 'center' }); }
  }

  /** Sunucudan tazeler (create/update/delete sonrasi). */
  async reload() { this.all = null; await this.render(); }

  markActive(id) {
    this.activeId = id == null ? null : String(id);
    this.body?.querySelectorAll('tbody tr').forEach(tr =>
      tr.classList.toggle('is-active', tr.dataset.id === this.activeId));
  }

  flash(id) {
    const tr = this.body?.querySelector(`tbody tr[data-id="${cssEsc(String(id))}"]`);
    flashRow(tr);
  }

  // --- parcalar ---
  head() {
    const head = el('div', 'module-head');
    const left = el('div');
    left.appendChild(el('h2', '', esc(lbl(this.o.title))));
    if (this.o.subtitle) {
      const sub = el('div', 'text-muted', esc(lbl(this.o.subtitle)));
      sub.style.cssText = 'font-size:13.5px; margin-top:6px;';
      left.appendChild(sub);
    }
    head.appendChild(left);
    this.addBtn = null;
    if (this.o.addLabel && this.o.onAdd) {
      const b = el('button', 'btn btn-primary', esc(lbl(this.o.addLabel)));
      if (!this.o.canWrite) { b.disabled = true; b.title = t('common.readonlyHint'); }
      else b.addEventListener('click', () => this.o.onAdd());
      head.appendChild(b);
      this.addBtn = b;
    }
    return head;
  }

  toolbar() {
    const bar = el('div', 'toolbar');
    const wrap = el('div', 'search');
    const inp = document.createElement('input');
    inp.className = 'input';
    inp.type = 'search';
    inp.placeholder = t('action.search');
    inp.value = this.search;
    let deb;
    inp.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { this.search = inp.value; this.page = 1; this.paint(); }, 180);
    });
    wrap.appendChild(inp);
    bar.appendChild(wrap);
    if (this.o.flagFilter) { this.flagHost = el('span', 'flag-host'); bar.appendChild(this.flagHost); }
    return bar;
  }

  // Bayrak sayacı (or. "N kayıtta malzeme seçilmemiş"). Sayım güncel this.all
  // üzerinden; tıklanınca this.flagActive değişir ve yalnızca işaretli satırlar süzülür.
  renderFlag() {
    if (!this.o.flagFilter || !this.flagHost) return;
    this.flagHost.innerHTML = '';
    const n = (this.all || []).filter(r => this.o.flagFilter.test(r)).length;
    if (n === 0) { this.flagActive = false; return; }   // işaretli satır yoksa sayaç gizli
    const chip = el('button', 'flag-chip' + (this.flagActive ? ' on' : ''), esc(this.o.flagFilter.label(n)));
    chip.type = 'button';
    chip.addEventListener('click', () => { this.flagActive = !this.flagActive; this.page = 1; this.paint(); });
    this.flagHost.appendChild(chip);
  }

  // Facet filtresi (çoklu seçim): tablonun üstünde değer başına tıklanabilir çip;
  // seçili değer(ler) varsa yalnızca eşleşen satırlar gösterilir (or. sipariş durumu).
  renderFacets() {
    if (!this.o.facetFilter || !this.facetHost) return;
    const f = this.o.facetFilter;
    this.facetHost.innerHTML = '';
    for (const v of f.values) {
      const on = this.facetActive.has(v);
      const chip = el('button', 'facet-chip' + (on ? ' on' : ''), esc(f.label ? f.label(v) : v));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        if (this.facetActive.has(v)) this.facetActive.delete(v); else this.facetActive.add(v);
        this.page = 1; this.paint();
      });
      this.facetHost.appendChild(chip);
    }
    if (this.facetActive.size) {
      const clear = el('button', 'facet-clear', esc(t('action.clear')));
      clear.type = 'button';
      clear.addEventListener('click', () => { this.facetActive.clear(); this.page = 1; this.paint(); });
      this.facetHost.appendChild(clear);
    }
  }

  filtered() {
    let rows = this.all;
    if (this.flagActive && this.o.flagFilter) rows = rows.filter(r => this.o.flagFilter.test(r));
    if (this.o.facetFilter && this.facetActive.size) {
      rows = rows.filter(r => this.facetActive.has(this.o.facetFilter.get(r)));
    }
    const q = this.search.trim().toLocaleLowerCase('tr');
    if (q) rows = rows.filter(r => this.o.searchText(r).toLocaleLowerCase('tr').includes(q));
    return rows;
  }

  paint() {
    this.renderFlag();   // sayacı güncelle (this.all değişmiş/filtre değişmiş olabilir)
    this.renderFacets(); // facet çiplerini (seçili durumla) yeniden çiz
    this.body.innerHTML = '';
    const rows = this.filtered();

    // Liste TAMAMEN boşken sağ üstteki ekleme butonunu gizle — boş hal kartındaki
    // buton (daha görünür, yönlendirici) yeterli. Arama sonucu boşsa (kayıt var)
    // üstteki buton kalır.
    if (this.addBtn) this.addBtn.style.display = this.all.length === 0 ? 'none' : '';

    if (rows.length === 0) {
      this.body.appendChild(this.all.length === 0
        ? emptyState({
            title: t('common.noRecords'),
            message: lbl(this.o.emptyMessage) || t('common.emptyHint'),
            actionLabel: this.o.canWrite ? lbl(this.o.addLabel) : '',
            onAction: this.o.canWrite ? this.o.onAdd : null
          })
        : emptyState({ title: t('common.noResults'), message: t('common.noResultsFor', { q: this.search }) }));
      return;
    }

    const pageSize = this.o.pageSize;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (this.page > pages) this.page = pages;
    const start = (this.page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    const hasActions = this.o.onEdit || this.o.onDelete || (this.o.rowActions && this.o.rowActions.length);
    const hasExpand = !!this.o.expand;
    this._colCount = this.o.columns.length + (hasActions ? 1 : 0) + (hasExpand ? 1 : 0);

    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table');
    table.className = 'table';
    table.innerHTML = `<thead><tr>${hasExpand ? '<th class="expander"></th>' : ''}${
      this.o.columns.map(c => `<th>${esc(lbl(c.label))}</th>`).join('')
    }${hasActions ? '<th></th>' : ''}</tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const row of slice) {
      const id = String(this.o.rowId(row));
      const tr = document.createElement('tr');
      tr.dataset.id = id;
      if (id === this.activeId) tr.classList.add('is-active');
      if (this.o.rowClass) { const rc = this.o.rowClass(row); if (rc) tr.classList.add(rc); }
      // Satıra tıklayınca genişlet (or. sipariş no). Buton/bağlantı/aksiyon tıklamaları hariç
      // (chevron da butondur -> kendi handler'ı çalışır, burada atlanır: çift toggle olmaz).
      if (hasExpand && this.o.expandOnRowClick) {
        tr.classList.add('row-expandable');
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, .actions')) return;
          if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
          this.paint();
        });
      }
      if (hasExpand) tr.appendChild(this.expanderCell(id, row));
      for (const col of this.o.columns) {
        const td = document.createElement('td');
        if (col.className) td.className = col.className;
        if (col.render) td.innerHTML = col.render(row);
        else td.textContent = row[col.key] ?? '';
        tr.appendChild(td);
      }
      if (hasActions) tr.appendChild(this.actionsCell(row));
      tbody.appendChild(tr);
      if (hasExpand && this.expanded.has(id)) tbody.appendChild(this.detailRow(row));
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    this.body.appendChild(wrap);
    this.body.appendChild(this.pager(rows.length, start, slice.length, pages));
  }

  // Genişletme (chevron) hücresi — Ürün Ağaçları'ndaki .tree-toggle deseni.
  expanderCell(id, row) {
    const td = el('td', 'expander');
    const b = el('button', 'tree-toggle', this.expanded.has(id) ? '▾' : '▸');
    b.addEventListener('click', () => {
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      this.paint();
    });
    td.appendChild(b);
    return td;
  }

  detailRow(row) {
    const tr = el('tr', 'detail-row');
    const td = el('td', 'detail-cell');
    td.colSpan = this._colCount;
    const content = this.o.expand(row);
    if (typeof content === 'string') td.innerHTML = content;
    else if (content) td.appendChild(content);
    tr.appendChild(td);
    return tr;
  }

  actionsCell(row) {
    const td = el('td', 'actions');
    // rowActions: Edit/Delete'ten bağımsız, HER ZAMAN etkin ekstra satır eylemleri (ör. Excel'e
    // aktar — salt-okuma güvenli). {label, kind?, onClick}. canWrite'tan etkilenmez.
    for (const a of (this.o.rowActions || [])) {
      const b = el('button', `btn ${a.kind || 'btn-ghost'} btn-sm`, esc(typeof a.label === 'function' ? a.label() : a.label));
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(row); });
      td.appendChild(b);
    }
    if (this.o.onEdit) td.appendChild(this.actionBtn(t('action.edit'), 'btn-ghost', () => this.o.onEdit(row)));
    if (this.o.onDelete) td.appendChild(this.actionBtn(t('action.delete'), 'btn-danger', () => this.o.onDelete(row)));
    return td;
  }

  actionBtn(label, kind, on) {
    const b = el('button', `btn ${kind} btn-sm`, esc(label));
    if (!this.o.canWrite) { b.disabled = true; b.title = t('common.readonlyHint'); }
    else b.addEventListener('click', on);
    return b;
  }

  pager(total, start, shown, pages) {
    const p = el('div', 'pager');
    p.appendChild(el('span', 'text-muted',
      total ? t('table.range', { start: start + 1, end: start + shown, total }) : '0'));
    p.appendChild(el('span', 'grow'));
    const prev = el('button', 'btn btn-secondary btn-sm', t('action.prev'));
    const next = el('button', 'btn btn-secondary btn-sm', t('action.next'));
    prev.disabled = this.page <= 1;
    next.disabled = this.page >= pages;
    prev.addEventListener('click', () => { this.page--; this.paint(); });
    next.addEventListener('click', () => { this.page++; this.paint(); });
    p.append(prev, el('span', 'text-muted', ' ' + t('table.page', { page: this.page, pages }) + ' '), next);
    return p;
  }
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function cssEsc(s) { return s.replace(/["\\]/g, '\\$&'); }
