<?php
declare(strict_types=1);

namespace App\Core;

use PDO;
use RuntimeException;

/**
 * Tum SQL burada. Iki seyi merkezi olarak garanti eder:
 *
 *  1. TENANT FILTRESI — her sorguya WHERE tenant_id eklenir. Modul yazan
 *     kisi unutamaz, cunku sorguyu kendi yazmaz.
 *  2. ESZAMANLILIK — guncellemede istemcinin okudugu updated_at karsilastirilir.
 *     Baskasi araya girdiyse yazma reddedilir; v1'de sessizce eziliyordu.
 */
abstract class BaseRepository
{
    abstract protected function table(): string;

    /** @return string[] Istemciden kabul edilen sutunlar. Whitelist. */
    abstract protected function columns(): array;

    public function __construct(protected Context $ctx) {}

    protected function pdo(): PDO
    {
        return Db::pdo();
    }

    /** @return array{rows: array, total: int} */
    public function paginate(int $page = 1, int $limit = 50): array
    {
        $page  = max(1, $page);
        $limit = min(200, max(1, $limit));
        $table = $this->table();

        $count = $this->pdo()->prepare("SELECT COUNT(*) FROM `$table` WHERE tenant_id = :t");
        $count->execute(['t' => $this->ctx->tenantId]);
        $total = (int) $count->fetchColumn();

        $stmt = $this->pdo()->prepare(
            "SELECT * FROM `$table` WHERE tenant_id = :t ORDER BY id DESC LIMIT :lim OFFSET :off"
        );
        $stmt->bindValue('t', $this->ctx->tenantId, PDO::PARAM_INT);
        $stmt->bindValue('lim', $limit, PDO::PARAM_INT);
        $stmt->bindValue('off', ($page - 1) * $limit, PDO::PARAM_INT);
        $stmt->execute();

        return ['rows' => $stmt->fetchAll(), 'total' => $total];
    }

    public function find(int $id): ?array
    {
        $table = $this->table();
        $stmt  = $this->pdo()->prepare("SELECT * FROM `$table` WHERE id = :id AND tenant_id = :t");
        $stmt->execute(['id' => $id, 't' => $this->ctx->tenantId]);
        return $stmt->fetch() ?: null;
    }

    public function create(array $data): int
    {
        $data = $this->onlyAllowed($data);
        $data['tenant_id']  = $this->ctx->tenantId;
        $data['created_by'] = $this->ctx->userId;
        $data['updated_by'] = $this->ctx->userId;

        $cols = array_keys($data);
        $sql  = sprintf(
            'INSERT INTO `%s` (%s) VALUES (%s)',
            $this->table(),
            implode(',', array_map(fn($c) => "`$c`", $cols)),
            implode(',', array_map(fn($c) => ":$c", $cols))
        );

        $this->pdo()->prepare($sql)->execute($data);
        return (int) $this->pdo()->lastInsertId();
    }

    /**
     * @param string|null $expectedUpdatedAt Istemcinin okudugu deger.
     *        Null gecilirse eszamanlilik kontrolu yapilmaz (toplu islemler icin).
     * @throws RuntimeException STALE — kayit araya girip degismis
     */
    public function update(int $id, array $data, ?string $expectedUpdatedAt): void
    {
        $current = $this->find($id);
        if ($current === null) {
            throw new RuntimeException('NOT_FOUND');
        }
        if ($expectedUpdatedAt !== null && $current['updated_at'] !== $expectedUpdatedAt) {
            throw new RuntimeException('STALE');
        }

        $data = $this->onlyAllowed($data);
        if ($data === []) {
            return;
        }
        $data['updated_by'] = $this->ctx->userId;

        $sets = implode(',', array_map(fn($c) => "`$c` = :$c", array_keys($data)));
        $sql  = "UPDATE `{$this->table()}` SET $sets WHERE id = :_id AND tenant_id = :_t";

        $this->pdo()->prepare($sql)->execute($data + ['_id' => $id, '_t' => $this->ctx->tenantId]);
    }

    /**
     * @throws RuntimeException IN_USE — kayit baska tablolarca referans veriliyor (FK)
     */
    public function delete(int $id): bool
    {
        try {
            $stmt = $this->pdo()->prepare(
                "DELETE FROM `{$this->table()}` WHERE id = :id AND tenant_id = :t"
            );
            $stmt->execute(['id' => $id, 't' => $this->ctx->tenantId]);
            return $stmt->rowCount() > 0;
        } catch (\PDOException $e) {
            // MySQL 1451 = "parent row: FK constraint fails" (SQLSTATE 23000).
            // Kayit hala kullanimda — 500 yerine anlamli IN_USE.
            if (($e->errorInfo[1] ?? null) === 1451 || (string) $e->getCode() === '23000') {
                throw new RuntimeException('IN_USE');
            }
            throw $e;
        }
    }
        /** updated_at'i ilerletir. Cocuk tablo degisikliklerinde cagrilir. */
       /** updated_at'i ilerletir. Cocuk tablo degisikliklerinde cagrilir. */
    protected function touch(int $id): void
    {
        $this->pdo()->prepare(
            "UPDATE `{$this->table()}`
                SET updated_at = CURRENT_TIMESTAMP(6), updated_by = :u
              WHERE id = :id AND tenant_id = :t"
        )->execute(['u' => $this->ctx->userId, 'id' => $id, 't' => $this->ctx->tenantId]);
    }

    /** Istemci fazladan alan gonderirse (tenant_id gibi) sessizce atilir. */
    private function onlyAllowed(array $data): array
    {
        return array_intersect_key($data, array_flip($this->columns()));
    }

    // --- ETL destegi ---------------------------------------------------------
    // Yalnizca v1 -> v2 tasima araci (tools/etl.php) icindir. Normal API akisi bunlari
    // KULLANMAZ: legacy_id whitelist disidir, API'den yazilmaz. Buradaki metotlar
    // legacy_id'yi bilerek yazar (kimlik esleme) ve eszamanlilik kontrolu yapmaz.

    /** legacy_id'ye gore satiri getirir (tenant kapsamli). ETL yeniden-calistirilabilirlik icin. */
    public function etlFindByLegacy(string $legacyId): ?array
    {
        $stmt = $this->pdo()->prepare(
            "SELECT * FROM `{$this->table()}` WHERE tenant_id = :t AND legacy_id = :l"
        );
        $stmt->execute(['t' => $this->ctx->tenantId, 'l' => $legacyId]);
        return $stmt->fetch() ?: null;
    }

    /**
     * legacy_id'ye gore ekle-ya-da-guncelle. Kayit varsa alanlari gunceller, yoksa
     * legacy_id ile ekler. Ikinci calistirmada veri ikilenmez.
     *
     * @return array{id:int, action:string} action: 'created' | 'updated'
     */
    public function etlUpsert(?string $legacyId, array $data): array
    {
        $data = $this->onlyAllowed($data);

        if ($legacyId !== null && ($existing = $this->etlFindByLegacy($legacyId)) !== null) {
            if ($data !== []) {
                $data['updated_by'] = $this->ctx->userId;
                $sets = implode(',', array_map(fn($c) => "`$c` = :$c", array_keys($data)));
                $this->pdo()->prepare(
                    "UPDATE `{$this->table()}` SET $sets WHERE id = :_id AND tenant_id = :_t"
                )->execute($data + ['_id' => (int) $existing['id'], '_t' => $this->ctx->tenantId]);
            }
            return ['id' => (int) $existing['id'], 'action' => 'updated'];
        }

        $data['tenant_id']  = $this->ctx->tenantId;
        $data['created_by'] = $this->ctx->userId;
        $data['updated_by'] = $this->ctx->userId;
        if ($legacyId !== null) {
            $data['legacy_id'] = $legacyId;
        }
        $cols = array_keys($data);
        $this->pdo()->prepare(sprintf(
            'INSERT INTO `%s` (%s) VALUES (%s)',
            $this->table(),
            implode(',', array_map(fn($c) => "`$c`", $cols)),
            implode(',', array_map(fn($c) => ":$c", $cols))
        ))->execute($data);

        return ['id' => (int) $this->pdo()->lastInsertId(), 'action' => 'created'];
    }

    /**
     * Bir sutunun degeri -> id haritasi (tenant kapsamli). ETL kimlik cozumlemesi icin
     * (or. legacy_id -> yeni id, ya da name -> id). $keyColumn kod-kontrollu (kullanici girdisi degil).
     *
     * @return array<string,int>
     */
    public function etlMapBy(string $keyColumn): array
    {
        $stmt = $this->pdo()->prepare(
            "SELECT `$keyColumn` AS k, id FROM `{$this->table()}` WHERE tenant_id = :t AND `$keyColumn` IS NOT NULL"
        );
        $stmt->execute(['t' => $this->ctx->tenantId]);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $out[(string) $r['k']] = (int) $r['id'];
        }
        return $out;
    }

    /**
     * Silinen-kayit denetimi (SALT OKUMA). DB'deki legacy_id'leri yedektekiyle
     * karsilastirir. ETL silme yapmaz; bu yalniz raporlar.
     *  - deletedInBackup: DB'de legacy_id dolu ama yedekte bu id yok -> v1'de silinmis.
     *  - nullLegacy: legacy_id IS NULL -> v2'de dogrudan acilmis (ya da oto-olusturulmus ref).
     *
     * @param array<string,bool> $backupLegacyIds yedekte gecen eski id'ler (anahtar = id)
     * @return array{deletedInBackup: list<string>, nullLegacy: int}
     */
    public function etlLegacyAudit(array $backupLegacyIds): array
    {
        $stmt = $this->pdo()->prepare(
            "SELECT legacy_id FROM `{$this->table()}` WHERE tenant_id = :t AND legacy_id IS NOT NULL"
        );
        $stmt->execute(['t' => $this->ctx->tenantId]);
        $deleted = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $lid) {
            if (!isset($backupLegacyIds[(string) $lid])) {
                $deleted[] = (string) $lid;
            }
        }

        $n = $this->pdo()->prepare(
            "SELECT COUNT(*) FROM `{$this->table()}` WHERE tenant_id = :t AND legacy_id IS NULL"
        );
        $n->execute(['t' => $this->ctx->tenantId]);

        return ['deletedInBackup' => $deleted, 'nullLegacy' => (int) $n->fetchColumn()];
    }

    /**
     * Bu tabloya ISARET EDEN (gelen) yabanci anahtarlari dondurur — reconcile oncesi
     * guvenlik kontrolu. CASCADE disi bir bag varsa silme engellenir (yetim/ihlal riski).
     *
     * @return list<array{table:string, column:string, constraint:string, deleteRule:string}>
     */
    public function etlReferencingForeignKeys(): array
    {
        $stmt = $this->pdo()->prepare(
            "SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, k.CONSTRAINT_NAME AS cn, r.DELETE_RULE AS dr
               FROM information_schema.KEY_COLUMN_USAGE k
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                 ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              WHERE k.REFERENCED_TABLE_SCHEMA = DATABASE()
                AND k.REFERENCED_TABLE_NAME = :tbl"
        );
        $stmt->execute(['tbl' => $this->table()]);
        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $out[] = [
                'table'      => (string) $row['t'],
                'column'     => (string) $row['c'],
                'constraint' => (string) $row['cn'],
                'deleteRule' => (string) $row['dr'],
            ];
        }
        return $out;
    }

    /**
     * legacy_id'si verilen listede olan satirlari SERT siler (tenant kapsamli). NULL
     * legacy satirlara ASLA dokunmaz (IN listesi somut id'lerden olusur + IS NOT NULL
     * kosulu). Uzlastirma (reconcile) icin; transaction icinde cagrilir.
     *
     * @param list<string> $legacyIds
     * @return int silinen satir sayisi
     */
    public function etlDeleteByLegacyIds(array $legacyIds): int
    {
        if ($legacyIds === []) {
            return 0;
        }
        $ph = implode(',', array_fill(0, count($legacyIds), '?'));
        $stmt = $this->pdo()->prepare(
            "DELETE FROM `{$this->table()}` WHERE tenant_id = ? AND legacy_id IS NOT NULL AND legacy_id IN ($ph)"
        );
        $stmt->execute([$this->ctx->tenantId, ...$legacyIds]);
        return $stmt->rowCount();
    }

    /**
     * Bir ad sutununa gore bul-ya-da-olustur (referans tablolar icin: work_centers,
     * operations, task_people). ETL'de serbest metin bir ada rastlanip karsiligi yoksa
     * otomatik olusturulur. $nameColumn kod-kontrollu.
     *
     * @return array{id:int, created:bool}
     */
    public function etlEnsureByName(string $nameColumn, string $name, array $extra = []): array
    {
        $stmt = $this->pdo()->prepare(
            "SELECT id FROM `{$this->table()}` WHERE tenant_id = :t AND `$nameColumn` = :n"
        );
        $stmt->execute(['t' => $this->ctx->tenantId, 'n' => $name]);
        $id = $stmt->fetchColumn();
        if ($id !== false) {
            return ['id' => (int) $id, 'created' => false];
        }

        $data = $this->onlyAllowed($extra);
        $data[$nameColumn]  = $name;
        $data['tenant_id']  = $this->ctx->tenantId;
        $data['created_by'] = $this->ctx->userId;
        $data['updated_by'] = $this->ctx->userId;
        $cols = array_keys($data);
        $this->pdo()->prepare(sprintf(
            'INSERT INTO `%s` (%s) VALUES (%s)',
            $this->table(),
            implode(',', array_map(fn($c) => "`$c`", $cols)),
            implode(',', array_map(fn($c) => ":$c", $cols))
        ))->execute($data);

        return ['id' => (int) $this->pdo()->lastInsertId(), 'created' => true];
    }
}
