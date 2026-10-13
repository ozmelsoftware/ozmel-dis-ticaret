# Staging (krc-port) ↔ v81 referans — eklenecek farklar

**Amaç:** staging'deki kodumuzu (`krc-port` dalı, staging.ozmel.com) Melih'in en son
referansıyla (`docs/referans/2026-10-13.html`, v81) karşılaştırıp **eklenecek ekranları**
çıkarmak. Sonraki adım: her yeni ekran için design prompt'u (ekranlar index'le birebir
aynı olacak) → `docs/design-promptlari-v81.md`.

- Referans: `docs/referans/2026-10-13.html` (v81) · önceki `docs/referans/v78.html`
- Yöntem: v78→v81 fonksiyon farkı çıkarıldı (ek: §Fonksiyon kanıtı); v81'de **eklenen**
  her şey staging'in **eksiği** demek, çünkü staging referanstan port ediliyor.
- Doğrulama: her eksik, `public/js` üzerinde grep'le teyit edildi. **Silinen yok**, **seed
  verisi aynı** (md5 birebir) → fark tamamen v81'in eklediği özellikler.

---

## Özet — eklenecek ekranlar (öncelik sırasıyla)

| # | Ekran | Staging bugün | Yapılacak | Design |
|---|---|---|---|---|
| 1 | **Kapasite Analizi** | yok (modül/menü/route yok) | yeni modül | **yeni prompt** |
| 2 | **Stok** | eski tasarım (`stok.js` = v78 viewStok: sipariş-seçmeli WIP) | tümden yeniden yaz | **yeni prompt** |
| 3 | **Satış Raporları — Pano (TV)** | sadece liste var (`salesReports.js`) | liste/pano görünüm anahtarı + pano | **yeni prompt** |
| 4 | **Giriş Kalite** | `incomingInspections.js` (Excel/kapsama yok) | Excel'e aktar + "kapsadığı girişler" + adet uyarısı | mevcut ekrana delta |
| 5 | **Satınalma isteği modalı** | `purchaseRequests.js` | malzeme kodu `<select>` + otomatik doldurma | mevcut ekrana delta |

Ek olarak **hesap/veri** işleri (ekran değil, design gerektirmez):

| Konu | Staging | Yapılacak |
|---|---|---|
| `ensure*` veri düzeltmeleri (kaynak-ürün rota birleştirme, sipariş birleştirme/dönüştürme — `221121…221182`) | `src`/`tools`/migration'da iz yok | CLAUDE.md gereği **migration** (açılışta düzeltme kodu yasak); §1 |
| Hammadde tüketim hesabı: `operasyon==='Cutting'` → **rotanın en düşük sıralı adımı** | eski mantık olası | hesap hizalaması (Stok #2 ile birlikte) |

> Not: `ensure*` düzeltmeleri prototipin localStorage verisini onarıyor. v2'de veri, 10-13
> yedeğinin ETL ile import'undan geliyor. **Açık soru (step 3 öncesi):** 10-13 yedeği bu
> düzeltmeler çalıştıktan *sonra* mı export edildi (veri hazır → re-import yeterli) yoksa
> ham mı (migration şart)? `data/qfw_konsol_yedek_2026-10-13.json` içeriğinden doğrulanacak.

---

## 1. Kapasite Analizi (yeni modül)

Gerçekleşen üretimden makine/ürün/operasyon başına günlük kapasite tahmini çıkarıp tanımlı
`capacity` ile karşılaştırır, öneri üretir, tek tıkla `capacity`'ye yazar. Tamamen mevcut
`production`/`capacity`/`workorders`/`routes`/çalışma saatleri üzerinden hesaplar — **yeni BE
ucu gerekmez** (listAll'lar yeterli).

Referans fonksiyonları: `viewKapasiteAnalizi` (132L), `kapasiteAnalizKayitlari`,
`kapasiteAnalizGrupla`, `kapasiteMetrik`, `kapasiteOneri`/`kapasiteOneriRozeti`,
`kapasiteAnalizUygula`, `kapasiteTanimli`, `kapAnFiltre/DonemEtiketi/HaftaAnahtari`,
`kapSayi/kapYuvarla`, `kapasiteHaricEkle/Kaldir`. State: `KAP_AN_MOD/OLCU/MAKINE/ARA/NOT_DISLA`;
sabitler `KAP_AN_MIN_GUN=3`, `KAP_AN_NOT_IFADELERI`, `KAP_AN_AYLAR`.

Yeni tablo: **`kapasiteHaricTarihler`** (analizden hariç günler) — v2'de migration + repo/DTO.
`core/capacity.js` (mola düşülmüş süre) ve `core/report.js` (dönem şeridi/eşik) yeniden
kullanılmalı (CLAUDE.md).

## 2. Stok — yeniden tasarım (`viewStok` 91L → 12L)

v78'de Stok = Hammadde tablosu + **sipariş-seçmeli WIP zaman çizgisi**. Bizim `stok.js` bunu
port etti → **artık eski**. v81 bunu söküp **kategori sekmeli** sade ekranla değiştirdi:

- Sekmeler: **Hammadde / Satınalınan Malzeme / Yarı Mamül** (`tumMalzemeKodlariKategoriye`,
  `malzemeKategorisi` — ürün ağacından kategori)
- Hammadde/Satınalınan: Kod · Açıklama · Mevcut Stok · **Açık Siparişler İçin Gerekli** · Kalan;
  satır açılınca sipariş kırılımı (`viewStokHammaddeSade`, `acikSiparislerIcinGerekliKalan` —
  yeni çekirdek hesap)
- Yarı Mamül: son aşamada üretilen − diğer ürünlerin ihtiyacı = kalan (`viewStokYariMamul`)
- Global WIP özeti siparişten bağımsız (`wipOzetHesapla`); state `STOK_TAB/STOK_ACIK_SATIR/WIP_ACIK_SATIR`
- Hesap farkı: `hammaddeStokBilgisiByKod` tüketimi artık ilk-sıra adımdan (TR/EN operasyon adı bağımsız)

## 3. Satış Raporları — Pano (TV) görünümü

`viewSatisRaporlari` artık **liste/pano anahtarı**; liste tarafı bizdeki ekranla aynı
(`viewSatisRaporListe`). Yeni olan **`viewSatisRaporPano`** (58L): koyu temalı TV panosu —
tamamlanmamış siparişler teslim tarihine göre, genel ilerleme çubuğu + açılınca adım adım.
`panoTamEkran(elId)` artık parametreli (üretim panosu ile paylaşımlı). State `SATIS_RAPOR_GORUNUM`,
`SATIS_PANO_ACIK`; `siparisGenelYuzde`/`siparisTamamlandiMi`. (Ayrıca `satis-raporlari-brief.md`.)

## 4. Giriş Kalite — Excel + kapsadığı girişler + adet uyarısı

- **Excel'e aktar**: ExcelJS tembel yükleme (`exceljsYukle`) + form üretimi
  (`girisKaliteExcelOlustur` 213L) + indirme (`excelDosyaIndir`, `excelSatirYuksekligi`,
  `excelSutunHarfi`). Tek kayıt dışa aktarımı `girisKaliteTekKayitExcelAktar`.
- **Kapsadığı girişler**: bir kalite kaydı birden çok satınalma girişini kapsayabilir;
  tabloda yeni kolon + toplam tutarsızsa ⚠ (`girisKaliteGirisToplami`, `girisKaliteKapsananOzet`,
  `girisKaliteAdetUyariMetni/Guncelle`).
- Satınalma girişlerinde düz kalite rozeti → tıklanınca kalite kaydına giden bağlantı
  (`girisKaliteRozetBaglantili`, `girisKaliteKaydinaGit`).

## 5. Satınalma isteği modalı

`openSatinalmaModal`: "Malzeme / Ürün Kodu" serbest `datalist` → `DB.kodTanimlari`'ndan
`tip==='Hammadde'` `<select>`; seçilince `satinalmaKoduSecildi` Malzeme Adı + Birim'i doldurur.

---

## Fonksiyon kanıtı (v78 → v81)

- **48 yeni üst-seviye fonksiyon** + 9 iç içe yardımcı (`girisKaliteExcelOlustur`/`exceljsYukle`
  içinde: `yaz, bosSatir, bilgi, satirDurum, limitler, olcuMetni, satirToplami, sayfaKontrol, dene`).
  Ham sayım 57; bağımsız fonksiyon 48.
- **0 silinen.** **14 gövdesi değişen**: `boot` (7 ensure çağrısı), `escapeHtml`(sözlük+NAV),
  `renderModule` (yeni case), `handleImportFile`, `hammaddeStokBilgisiByKod` (hesap),
  `viewStok`, `viewSatisRaporlari`, `panoTamEkran`, `viewGirisKaliteTab`, `viewGirisKaliteEdit`,
  `girisKaliteGirislerListesiHTML`, `girisKaliteOrnekGuncelle`, `openSatinalmaModal`,
  `viewSatinalmaGirisleri`.
- Doğrulama: yeni/değişen kodun çağırdığı tüm yardımcılar (`girisKaliteKapsananGirisIdleri`,
  `urunHammaddeIhtiyaciHesapla`, `csOzet`, `durusDakikaHesapla`, `haftaBaslangici`, `opGoster`,
  `routeSiraGruplari`, `asamaUretilen`, `bomYapraklariTopla`, …) v78'de **zaten vardı** → eksik
  fonksiyon yok. `function` anahtarı 334→382 (+48) ile tutarlı. Nesne-metodu biçimli tanım yok.
