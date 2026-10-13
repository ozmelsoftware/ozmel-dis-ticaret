-- 045_capacity_exclusions.sql — Kapasite Analizi'nde hesaba katilmayacak gunler.
--
-- Kapasite Analizi makine kapasitesini GERCEK uretim kayitlarindan hesaplar. Bazi gunler
-- gercek uretim degildir (or. stok girisi icin is emirlerini toplu kapatma: operatorsuz,
-- durussuz, cok sayida kayit). Bu gunler hesaba girerse kapasite yanlis YUKSEK cikar.
-- Bu tablo, analizden haric tutulacak tarihleri tutar (referans: kapasiteHaricTarihler).
--
-- Dogal anahtar (tenant_id, date) tekildir — ayni tarih iki kez eklenmez. 'kayit'/'adet'
-- SAYILARI burada saklanmaz; ekranda o tarihin production kayitlarindan CANLI hesaplanir.
--
-- Ortak sutun deseni (id, tenant_id, legacy_id, created_at, updated_at, created_by, updated_by).
-- legacy_id: prototipteki kapasiteHaricTarihler kayitlari ileride ETL ile aktarilabilsin diye.

CREATE TABLE IF NOT EXISTS capacity_exclusions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   INT UNSIGNED    NOT NULL DEFAULT 1,
  legacy_id   VARCHAR(190)    NULL,
  `date`      DATE            NOT NULL,
  note        VARCHAR(255)    NULL,
  created_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by  INT UNSIGNED    NULL,
  updated_by  INT UNSIGNED    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_capexc_tenant_date (tenant_id, `date`),
  UNIQUE KEY uniq_capexc_tenant_legacy (tenant_id, legacy_id),
  KEY idx_capexc_tenant (tenant_id),
  CONSTRAINT fk_capexc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO schema_migrations (version) VALUES ('045_capacity_exclusions');
