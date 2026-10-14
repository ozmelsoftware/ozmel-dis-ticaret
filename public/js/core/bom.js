// BOM (Ürün Ağacı) verim hesapları — referans v81 ile BİREBİR.
// Kaynak fonksiyonlar: bomCocuklari / bomYaprakMi / bomYapraklariTopla / bomDugumHesapla /
// urunHammaddeIhtiyaciHesapla / malzemeKategorisi / tumMalzemeKodlariKategoriye.
//
// Referansta ağaç düğümünün tek `.kod`'u vardır; v2'de düğümün kimliği `productCodeId`'dir
// (ETL: referans `kod` → product_code_id). Bu yüzden createBom'a düğümler + `codeOf(node)`
// çözücüsü verilir; her düğüme string `code` iliştirilir ve tüm hesaplar referanstaki gibi
// KOD üzerinden yürür. Fiziksel alanlar (materialLength/Weight, partLength, cutLoss, outer/
// innerDiameter, unitQuantity) düğümün kendisindedir (referans hammaddeUzunluk/… birebir).
//
// Salt hesap — veri çekmez. Stok şimdi, Ürün Ağaçları "Verim" kolonu sonra aynı yerden kullanır.

/**
 * @param {Array} treeRows product-trees listAll satırları (id, parentId, productCodeId,
 *        unitQuantity, materialLength, materialWeight, partLength, cutLoss, outerDiameter, innerDiameter)
 * @param {(node:any)=>string} codeOf düğümün string kodunu döndürür (ör. products.byId.get(n.productCodeId)?.code)
 */
export function createBom(treeRows, codeOf) {
  const nodes = treeRows.map(n => ({
    id: n.id, parentId: n.parentId ?? null, code: codeOf(n) || '',
    unitQuantity: n.unitQuantity, materialLength: n.materialLength, materialWeight: n.materialWeight,
    partLength: n.partLength, cutLoss: n.cutLoss, outerDiameter: n.outerDiameter, innerDiameter: n.innerDiameter,
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const kids = new Map();   // parentId → [node]
  for (const n of nodes) { const p = n.parentId; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
  const children = (id) => kids.get(id) || [];
  const isLeaf = (id) => children(id).length === 0;                       // bomYaprakMi

  // bomYapraklariTopla — yapraklar + kümülatif birim çarpanı
  function collectLeaves(nodeId, mult = 1) {
    const node = byId.get(nodeId);
    if (!node) return [];
    const c = children(nodeId);
    if (c.length === 0) return [{ node, cumUnit: mult }];
    return c.flatMap(ch => collectLeaves(ch.id, mult * (Number(ch.unitQuantity) || 1)));
  }

  // bomDugumHesapla — parça adedi / ağırlığı / et kalınlığı
  function nodeYield(node) {
    const leaf = isLeaf(node.id);
    let parcaAdedi = null, parcaAgirligi = null, kalinlik = null;
    if (node.outerDiameter != null && node.innerDiameter != null) {
      kalinlik = Math.round(((node.outerDiameter - node.innerDiameter) / 2) * 100) / 100;
    }
    if (leaf && node.materialLength && node.partLength) {
      parcaAdedi = Math.floor(node.materialLength / (node.partLength + (Number(node.cutLoss) || 0)));
      parcaAgirligi = parcaAdedi > 0 ? Math.round((node.materialWeight / parcaAdedi) * 100000) / 100000 : 0;
    }
    return { ...node, leaf, parcaAdedi, parcaAgirligi, kalinlik };
  }

  // urunHammaddeIhtiyaciHesapla — bitmiş ürün kodu + adet → malzeme başına gereklilik
  function requirement(productCode, qty) {
    const root = nodes.find(n => n.code === productCode && n.parentId == null);
    if (!root || !qty) return [];
    const leaves = collectLeaves(root.id);
    const grup = {};
    for (const y of leaves) {
      const h = nodeYield(y.node);
      if (!grup[h.code]) grup[h.code] = { node: h, gerekliParca: 0 };
      grup[h.code].gerekliParca += y.cumUnit * qty;
    }
    return Object.values(grup).map(g => {
      const gerekliParca = Math.ceil(g.gerekliParca);
      const tupSayisi = g.node.parcaAdedi > 0 ? Math.ceil(gerekliParca / g.node.parcaAdedi) : null;
      return {
        code: g.node.code, gerekliParca, parcaAdediPerTup: g.node.parcaAdedi, tupSayisi,
        toplamUzunluk: tupSayisi != null ? tupSayisi * g.node.materialLength : null,
        toplamAgirlik: tupSayisi != null ? Math.round(tupSayisi * g.node.materialWeight * 1000) / 1000 : null,
      };
    });
  }

  // malzemeKategorisi — ağaçtan türetilen kategori
  function category(code) {
    const leafNode = nodes.find(n => n.code === code && isLeaf(n.id));
    if (leafNode) return leafNode.materialLength ? 'Hammadde' : 'Satınalınan Malzeme';
    const isChild = nodes.some(n => n.code === code && n.parentId != null);
    if (isChild) return 'Yarı Mamül';
    return null;
  }

  // tumMalzemeKodlariKategoriye — kod → kategori, benzersiz + tr sıralı
  function codesByCategory() {
    const res = { 'Hammadde': [], 'Satınalınan Malzeme': [], 'Yarı Mamül': [] };
    const seen = new Set();
    for (const n of nodes) {
      if (seen.has(n.code)) continue;
      seen.add(n.code);
      const kat = category(n.code);
      if (kat) res[kat].push(n.code);
    }
    for (const k of Object.keys(res)) res[k].sort((a, b) => String(a).localeCompare(String(b), 'tr'));
    return res;
  }

  return { nodes, byId, children, isLeaf, collectLeaves, nodeYield, requirement, category, codesByCategory };
}
