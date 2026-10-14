// Giriş Kalite Kontrolleri — v2 modülü. İKİ SEVİYE iç içe: kayıt -> karakteristik[]
// -> değer[]. Karakteristik editörü: her karakteristik bir blok, kendi değerleri
// (TagList; sayı ya da 'Uygun'/'Uygun Değil'). Genel sonuç açılır liste.
// i18n: etiketler () => t(...). Tip (olcusel/nitel) ve genel sonuç (Kabul/Red/Şartlı
// Kabul) BE'de TR saklanır; yalnızca GÖSTERİM t() ile çevrilir.

import { resource } from '../core/api.js';
import { DataTable } from '../core/table.js';
import { openDrawer } from '../core/drawer.js';
import { FkSelect } from '../core/fkselect.js';
import { TagList } from '../core/taglist.js';
import { toast } from '../core/toast.js';
import { confirmDialog, errorState, esc } from '../core/states.js';
import { loadLookup, mapProduct, withCurrent } from '../core/lookups.js';
import { measurementDetail } from './_measDetail.js';
import { exportInspectionExcel } from './_girisKaliteExcel.js';
import { t } from '../core/i18n.js';

const api = resource('incoming-inspections');
const canWrite = (window.SESSION_ROLE ?? 'editor') === 'editor';

// Karakteristik tipi ve genel sonuç: seçenekler dile göre kurulur (değer BE'de TR).
const charTypeOptions = () => [
  { value: '', label: t('qc.selectType') },
  { value: 'olcusel', label: t('qc.olcusel') },
  { value: 'nitel', label: t('qc.nitel') }
];
const resultOptions = () => [
  { value: '', label: t('qc.selectResult') },
  { value: 'Kabul', label: t('qc.Kabul') },
  { value: 'Red', label: t('qc.Red') },
  { value: 'Şartlı Kabul', label: t('qc.Şartlı Kabul') }
];
// Genel sonucun tablo etiketi (değer TR kalır). Anahtar yoksa ham değer.
const resultLabel = (v) => { if (!v) return '—'; const k = 'qc.' + v; const s = t(k); return s === k ? v : s; };

export async function viewIncomingInspections(container) {
  container.innerHTML = `<div class="loading">${t('common.loading')}</div>`;
  let products, receipts;
  try {
    [products, receipts] = await Promise.all([
      loadLookup('product-codes', (r) => ({ id: r.id, code: r.code, name: r.name, unit: r.unit })),
      loadLookup('purchase-receipts', (r) => ({ id: r.id, code: '#' + r.id, name: r.date || '' })),
    ]);
  } catch (err) { container.innerHTML = ''; container.appendChild(errorState({ message: err.message, onRetry: () => viewIncomingInspections(container) })); return; }

  // Excel'e aktar bağlamı. kapsananOzet Part B'de (çoklu kapsama) doldurulacak — şimdilik boş.
  const excelCtx = (row) => ({
    materialLabel: (id) => products.label(id),
    materialCode: (id) => products.byId.get(id)?.code || '',
    birim: (products.byId.get(row.materialCodeId)?.unit) || '',
    kapsananOzet: [],
  });

  const table = new DataTable(container, {
    title: () => t('menu.incoming-inspections'),
    subtitle: () => t('ii.subtitle'),
    canWrite,
    addLabel: () => t('ii.new'),
    // Salt-okuma güvenli: Excel'e aktar her kullanıcıda etkin.
    rowActions: [{ label: () => t('gk.excelBtn'), kind: 'btn-ghost', onClick: (row) => exportInspectionExcel(row, excelCtx(row)) }],
    onAdd: () => openForm(null),
    onEdit: (row) => openForm(row),
    onDelete: (row) => remove(row),
    // Genişleyen satır: her karakteristik + değerleri + kendi limitlerine göre tolerans.
    expand: (row) => measurementDetail((row.characteristics || []).map(c => ({
      location: c.name || ('#' + c.charNo), lower: c.lowerLimit, upper: c.upperLimit, values: c.values || []
    }))),
    load: () => api.listAll().then(r => r.data),
    searchText: (r) => [r.supplier, products.label(r.materialCodeId), r.inspectorName].join(' '),
    emptyMessage: () => t('ii.empty'),
    columns: [
      { label: () => t('field.supplier'), render: (r) => esc(r.supplier || '—') },
      { label: () => t('field.material'), render: (r) => r.materialCodeId ? esc(products.label(r.materialCodeId)) : '—' },
      { label: () => t('ii.inspectionDate'), render: (r) => esc(r.inspectionDate || '—') },
      { label: () => t('field.characteristic'), render: (r) => r.characteristics.length, className: 'mono' },
      { label: () => t('field.result'), render: (r) => esc(resultLabel(r.overallResult)) }
    ]
  });

  function openForm(row) {
    const editing = !!row;
    if (editing) table.markActive(row.id);
    const materialFk = new FkSelect({ source: products.source, rows: products.rows, value: row?.materialCodeId ?? null, placeholder: t('pr.selectMaterial') });
    const receiptFk = new FkSelect({ source: receipts.source, rows: receipts.rows, value: row?.purchaseReceiptId ?? null, placeholder: t('ii.selectReceipt') });
    const chars = new CharacteristicsEditor();

    openDrawer({
      title: () => t(editing ? 'ii.editTitle' : 'ii.newTitle'),
      submitLabel: () => t(editing ? 'action.update' : 'action.add'),
      values: editing ? { ...row } : { overallResult: '' },
      fields: [
        { name: 'secId', type: 'section', label: () => t('ii.secControl') },
        { name: 'supplier', label: () => t('field.supplier'), type: 'text' },
        { name: 'materialCodeId', label: () => t('field.material'), type: 'fk', fk: materialFk },
        { name: 'purchaseReceiptId', label: () => t('ii.purchaseReceipt'), type: 'fk', fk: receiptFk },
        { name: 'drawingNo', label: () => t('ii.drawingNo'), type: 'text' },
        { name: 'reason', label: () => t('ii.reason'), type: 'text' },
        { name: 'secQty', type: 'section', label: () => t('ii.secDateQty') },
        { name: 'arrivalDate', label: () => t('ii.arrivalDate'), type: 'date' },
        { name: 'inspectionDate', label: () => t('ii.inspectionDate'), type: 'date' },
        { name: 'receivedQty', label: () => t('ii.receivedQty'), type: 'number', step: 'any' },
        { name: 'sampleQty', label: () => t('ii.sampleQty'), type: 'number' },
        { name: 'inspectorName', label: () => t('ii.inspectorName'), type: 'text' },
        { name: 'overallResult', label: () => t('ii.overallResult'), type: 'select', options: withCurrent(resultOptions(), row?.overallResult) },
        { name: 'secChars', type: 'section', label: () => t('ii.secChars') },
        { name: 'characteristics', type: 'component', component: chars }
      ],
      onSubmit: async (v) => (editing ? await api.update(row.id, v) : await api.create(v)).data,
      onSaved: async (saved) => { toast(t(editing ? 'ii.updated' : 'ii.added'), 'success'); await table.reload(); table.flash(saved.id); },
      onClose: () => table.markActive(null)
    });
  }

  async function remove(row) {
    const ok = await confirmDialog({ title: t('ii.deleteTitle'), body: t('ii.deleteBody'), confirmLabel: t('action.delete'), danger: true });
    if (!ok) return;
    try { await api.remove(row.id); toast(t('ii.deleted'), 'success'); await table.reload(); }
    catch (err) { toast(err.message, 'danger'); }
  }
}

// Karakteristik editörü: her karakteristik bir blok + kendi değerleri (TagList).
class CharacteristicsEditor {
  constructor() {
    this.blocks = [];
    this.cb = null;
    this.el = document.createElement('div');
    this.body = el('div', '');
    this.el.appendChild(this.body);
    const add = el('button', 'btn btn-secondary btn-sm rows-ed-add', esc(t('ii.addChar')));
    add.type = 'button';
    add.addEventListener('click', () => { this.addBlock({}); this.emit(); });
    this.el.appendChild(add);
    this.paintEmpty();
  }
  onChange(cb) { this.cb = cb; }
  emit() { this.cb && this.cb(); }
  setValue(list) {
    this.blocks.forEach(b => b.el.remove());
    this.blocks = [];
    for (const c of (list || [])) this.addBlock(c);
    this.paintEmpty();
  }
  getValue() {
    return this.blocks.map(b => ({
      charNo: b.charNo.value, name: b.name.value, specText: b.specText.value, type: b.type.value,
      nominal: b.nominal.value, lowerLimit: b.lower.value, upperLimit: b.upper.value, unit: b.unit.value,
      values: b.values.getValue()
    })).filter(c => c.name);
  }
  addBlock(c) {
    const block = el('div', 'char-block');
    const head = el('div', 'char-head', `<b>${esc(t('field.characteristic'))}</b>`);
    const x = el('button', 'row-x', '×'); x.type = 'button';
    head.appendChild(x);
    const body = el('div', 'char-body');
    const charNo = inp('number', c.charNo);
    const name = inp('text', c.name);
    const specText = inp('text', c.specText);
    const type = sel(charTypeOptions(), c.type);
    const nominal = inp('number', c.nominal), lower = inp('number', c.lowerLimit), upper = inp('number', c.upperLimit);
    const unit = inp('text', c.unit);
    // Karakteristik değerleri tekilleştirilMEZ — 13.28, 13.28, 13.2 gibi tekrarlar normaldir.
    const values = new TagList({ value: (c.values || []).map(v => v == null ? '' : String(v)).filter(Boolean), placeholder: t('ii.valuePlaceholder'), unique: false });
    body.append(
      fld(t('field.no'), charNo), fld(t('field.name'), name), fld(t('ii.spec'), specText), fld(t('field.type'), type),
      fld(t('field.nominal'), nominal), fld(t('field.lowerLimit'), lower), fld(t('field.upperLimit'), upper), fld(t('field.unit'), unit),
      fld(t('ii.values'), values.el, 'char-values')
    );
    block.append(head, body);
    const entry = { el: block, charNo, name, specText, type, nominal, lower, upper, unit, values };
    x.addEventListener('click', () => { block.remove(); this.blocks = this.blocks.filter(b => b !== entry); this.emit(); this.paintEmpty(); });
    for (const ctrl of [charNo, name, specText, nominal, lower, upper, unit]) ctrl.addEventListener('input', () => this.emit());
    type.addEventListener('change', () => this.emit());
    values.onChange(() => this.emit());
    this.body.appendChild(block);
    this.blocks.push(entry);
    this.paintEmpty();
  }
  paintEmpty() {
    let e = this.body.querySelector('.rows-empty');
    if (this.blocks.length === 0) { if (!e) { e = el('div', 'rows-empty', esc(t('ii.noChar'))); this.body.appendChild(e); } }
    else if (e) e.remove();
  }
}

function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
function inp(type, value) { const i = document.createElement('input'); i.className = 'input'; i.type = type; if (type === 'number') i.step = 'any'; i.value = value ?? ''; return i; }
function sel(options, value) {
  const s = document.createElement('select'); s.className = 'input';
  for (const o of options) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; if (String(value ?? '') === String(o.value)) op.selected = true; s.appendChild(op); }
  return s;
}
function fld(label, control, extraCls) {
  const w = el('div', 'field' + (extraCls ? ' ' + extraCls : ''));
  w.innerHTML = `<label>${esc(label)}</label>`;
  w.appendChild(control);
  return w;
}
