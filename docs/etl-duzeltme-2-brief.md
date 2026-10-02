# Claude Code brief — ETL düzeltme 2: tarih + uzlaştırma

Staging dry-run (2 Ekim) iki sorun gösterdi.

---

## 1. `product_trees` patlıyor

```
SQLSTATE[22007]: Incorrect date value: '-' for column product_trees.revision_date
```

Melih ürün ağacını yeniden kurmuş. 162 kaydın hepsinin id'si yeni (`mig…`) ve `revTarihi` iki yeni biçimde geliyor:

| Değer | Adet |
|---|---|
| `'-'` | 81 |
| `'2007-10-08T00:00:00'` | 81 |

`etl.php` ~428 satırında `revision_date` `$str()` ile geçiyor.

**Düzeltme:** Bir `$date` yardımcısı yaz ve iki `revision_date` eşlemesinde kullan (ürün ağacı ~428, ürün kodları ~295):

- `YYYY-MM-DD` → olduğu gibi
- `YYYY-MM-DDT…` → ilk 10 karakter
- `'-'`, boş, null → null
- Başka bir biçim → null + rapora uyarı (koleksiyon, id, değer)

Yedekteki diğer tarih alanlarını taradım, hepsi `YYYY-MM-DD`. Sorun yalnız bu alanda.

---

## 2. Uzlaştırma (`reconcile`) — artık gerekli

Silinen kayıt denetiminin sonucu:

| Tablo | v2'de olup yedekte olmayan |
|---|---|
| `product_trees` | 90 — eski ağacın tamamı |
| `routes` | 20 |
| `capacities` | 3 |
| `machine_plans` | 9 |

Bu adım olmadan ETL sonrası v2'de **iki ağaç birden** olur: 90 eski + 162 yeni. Malzeme ihtiyacı ve ağaç ekranı çift sayar. Silinmiş rotalar ve kapasiteler de darboğaz ve tahmini bitiş hesabını bozar. Spesifikasyon "index.html'deki gibi çalışsın" olduğu için bu kayıtlar gitmeli.

**Düzeltme:** `reconcile` modu.

- Açma: CLI `--reconcile`, web `&reconcile=1`. Varsayılan **kapalı**.
- Sadece bütün koleksiyonlar hatasız bittiyse (`$stoppedAt === null`) çalışır. Durduysa atla, raporla.
- Kapsam: `$auditSpec`'teki tablolar, `$refTables` hariç.
- Silinecek satır: `legacy_id IS NOT NULL` **ve** yedekte o id yok. `legacy_id IS NULL` satırlara **asla** dokunma.
- Dry-run'da da çalışır, tablo bazında "silinecek: N" + ilk 10 id yazar. Dış transaction geri alındığı için hiçbir şey silinmez.
- Canlıda tek transaction. Bir silme patlarsa hepsi geri alınır.

**FK durumu (kontrol ettim):**
- `product_trees.parent_id` → kendisine, `ON DELETE CASCADE`
- `route_variants.route_id` → `routes`, `ON DELETE CASCADE`
- Bu dört tabloya başka FK yok.

Yine de silmeden önce `information_schema` ile bu tablolara işaret eden FK'ları say, beklenmeyen bir şey çıkarsa dur ve raporla.

Sert silme yapılıyor, yumuşak silme yok. Geri dönüş yolu veritabanı yedeği.

---

## Doğrulama

`php -l` → commit → push.

Staging dry-run (`&reconcile=1`) beklenenleri:

- `İŞLEME DURDU` yok
- `product_trees`: 162 kayıt işlendi, atlanan yok
- Tarih uyarısı: 0. `'-'` ve `T` biçimleri beklenen biçimler, uyarı değil.
- Silinecek: `product_trees` 90 · `routes` 20 · `capacities` 3 · `machine_plans` 9
- `machine_plans`'taki 1 adet NULL legacy kayıt silinecekler listesinde **yok**

Rapor ver, dur. Canlı çalıştırmayı ben yapacağım.
