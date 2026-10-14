# Brief — Stok (yeniden tasarım, v81'e hizalama)

Kaynak: referans `docs/referans/2026-10-13.html` → `viewStok` (yeni 12L) + `viewStokHammaddeSade`,
`viewStokYariMamul`, `tumMalzemeKodlariKategoriye`, `malzemeKategorisi`, `acikSiparislerIcinGerekliKalan`,
`hammaddeStokBilgisiByKod` (değişti). Fark: `docs/staging-v81-fark.md` §3. Design prompt'u:
`docs/design-promptlari-v81.md` §2 (design dosyası sonra gelecek).

**Mevcut `stok.js` tümden yeniden yazılacak.** Eski (sipariş-seçmeli WIP zaman çizgisi) tasarım
v81'de **kaldırıldı** — yeni ekran kategori sekmeli ve sade. Salt-okuma, form yok, **yeni BE ucu yok**
(hepsi `listAll`).

---

## Ekran (3 sekme — WIP YOK)

Üstte sekme çubuğu (sayıyla): **Hammadde (N)** · **Satınalınan Malzemeler (M)** · **Yarı Mamül (K)**.

- **Hammadde / Satınalınan** (aynı tablo — `viewStokHammaddeSade`): Kod | Açıklama | **Mevcut Stok** |
  **Açık Siparişler İçin Gerekli** | **Kalan** | (ok). Birim: malzemenin kendi birimi (kg ya da adet).
  Kalan negatif kırmızı / pozitif yeşil (kalın). "Gerekli" >0 ve detay varsa satır açılır → sipariş
  kırılımı ("SP-… — kalan N kg", sipariş no tıklanınca iş emirlerine gider).
- **Yarı Mamül** (`viewStokYariMamul`): Kod | Üretilen (Kendi Siparişleri) | Diğer Ürünlerin İhtiyacı |
  Kalan. Açıklama metni: "Kendi siparişlerinde üretilmiş ama henüz başka ürüne aktarılmamış miktar".
- Genel boş hal (ürün ağacı yoksa): "Henüz Ürün Ağacı tanımlı değil — önce Ürün Ağaçları'ndan ilişki girin."

---

## Veri & hesap (hepsi mevcut `listAll` — yeni okuma ucu yok)

Yükleme: product-codes, product-trees, operations, purchase-receipts, purchase-requests,
incoming-inspections, orders, work-orders, routes, production (bugünkü `stok.js` ile aynı set).

### 1. Kategori (`malzemeKategorisi` / `tumMalzemeKodlariKategoriye`)
Ürün ağacından türetilir (v2 `type` alanından DEĞİL — bkz. AÇIK KARAR 1):
- Ağaç **yaprağı** + `materialLength` (hammaddeUzunluk) dolu → **Hammadde**
- Ağaç yaprağı + `materialLength` boş → **Satınalınan Malzeme**
- Çocuğu olan (başka ürünün girdisi) → **Yarı Mamül**
Gerekli yardımcılar: `bomYaprakMi` (çocuğu yok mu). v2'de ağaç yürüyüşü `stok.js`'te zaten var.

### 2. Mevcut stok (`hammaddeStokBilgisiByKod`)
= onaylı gelen − tüketilen (malzemenin birimi; kg ya da adet). v2 `stok.js`'te bu mantık VAR:
- onaylı gelen = `incoming_inspections.overallResult='Uygun'` girişler → `purchase_receipts.quantity`
- **DEĞİŞİKLİK (v81):** tüketim artık "Kesim/Cutting" operasyon adı eşleşmesiyle değil, **ürünün
  rotasındaki EN DÜŞÜK sıra numaralı adımın** üretimiyle hesaplanır (TR/EN operasyon adından bağımsız).
  v2'deki `CUT_RE`/`outgoingOperationId` yaklaşımı bununla değiştirilecek. **Hesap değişikliği —
  tüketilen/net sayılar değişebilir; 10-13 verisiyle doğrulanmalı.**

### 3. Açık siparişler için gerekli (`acikSiparislerIcinGerekliKalan`) — YENİ ÇEKİRDEK HESAP
Açık (`durum≠Tamamlandı`) siparişlerde bu malzemenin kalan ihtiyacı: her sipariş için
`urunHammaddeIhtiyaciHesapla(ürün, hedefMiktar)` → bu malzemeye düşen tam gereklilik; ilk-sıra
adım üretimine göre orantılanıp tüketilen düşülür. Döner: `{toplam, detay:[{orderNo, kalan}]}`.
**Kalan = Mevcut Stok − gerekli.toplam.**

### 4. Yarı Mamül (`viewStokYariMamul`)
Üretilen (son aşama, kendi `durum≠Tamamlandı` siparişleri, `asamaUretilen(order.id, sonSira)`) −
diğer ürünlerin ihtiyacı (`acikSiparislerIcinGerekliKalan`) = kalan.

---

## En büyük parça — BOM verim hesabı (v2'de YOK, port edilecek)

`acikSiparislerIcinGerekliKalan` → `urunHammaddeIhtiyaciHesapla` → `bomYapraklariTopla` +
**`bomDugumHesapla`** zincirine dayanır. `tutarlilik-raporu.md` §C bunları "YOK — en kritik hesap
kaybı" olarak işaretlemiş. **Girdi alanları v2'de VAR** (ProductTree DTO: `partLength`, `cutLoss`,
`materialLength`, `materialWeight`, `unitQuantity`) — sadece hesap fonksiyonları port edilmemiş.

- `bomDugumHesapla(node)` → `{kod, aciklama, parcaAdedi = floor(materialLength/(partLength+cutLoss)),
  hammaddeUzunluk, hammaddeAgirlik}`
- `bomYapraklariTopla(kökId)` → yapraklar + kümülatif birim çarpanı (v2 `multFromRoot` benzeri)
- `urunHammaddeIhtiyaciHesapla(ürün, adet)` → malzeme başına `{gerekliParca, tupSayisi, toplamUzunluk,
  toplamAgirlik}`

**Öneri:** bunlar paylaşılan **`core/bom.js`**'e çıkarılsın — Stok şimdi, **Ürün Ağaçları "Verim"
kolonu** (ayrıca eksik, tutarlilik §C) sonra aynı yerden kullanır. Mevcut `stok.js`'teki ağaç
yürüyüşü (nodeById/rootProductOf/multFromRoot) bu modüle taşınır.

---

## Kapsam dışı
- WIP / sipariş-aşama zaman çizgisi (v81 Stok'tan çıkarıldı; `wipOzetHesapla` başka ekranda).
- Ürün Ağaçları "Verim" kolonu (ayrı iş — ama `core/bom.js` buna da hazır olacak).

## Kesinleşti — HER ŞEY REFERANSLA (index/v81) BİREBİR, sapma yok
1. **Kategori:** ağaçtan türetilir (`malzemeKategorisi` birebir): yaprak + `materialLength` → Hammadde,
   yaprak + length yok → Satınalınan Malzeme, çocuğu olan → Yarı Mamül. v2 `type` alanı kategoride
   KULLANILMAZ (referans da kullanmıyor).
2. **BOM verim hesabı bu turda kurulur** — `core/bom.js` (`bomDugumHesapla`, `bomYapraklariTopla`,
   `bomCocuklari`, `bomYaprakMi`, `urunHammaddeIhtiyaciHesapla`) referanstaki gövdelerle birebir.
   "Gerekli" (kg/adet) index'teki gibi çıkar. Basitleştirme YOK.
3. **Tüketim** ilk-sıra rota adımından hesaplanır (referans `hammaddeStokBilgisiByKod` birebir).
   Min-stok uyarısı referans yeni tabloda yok → gösterilmez.

## Doğrulama & kayıt
`node --check`, TR/EN anahtar dengesi, tarayıcıda aç. Yeni `stok.*` anahtarları (sekmeler, kolonlar,
boş haller) + `ceviri-sozlugu.md`. Eski `stok.*` (WIP/aşama) anahtarları kullanılmıyorsa temizlenir.
`?v` bump. Her adım ayrı commit (CLAUDE.md).
