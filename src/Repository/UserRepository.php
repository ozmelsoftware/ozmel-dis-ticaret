<?php
declare(strict_types=1);

namespace App\Repository;

use App\Core\Context;
use App\Core\Db;
use PDO;
use RuntimeException;

/**
 * Paylasilan v1 `users` tablosu uzerinde hesap yonetimi. BaseRepository'yi
 * GENISLETMEZ (o tablo created_by/legacy_id gibi v2 sutunlarini tutmaz); tenant
 * filtresini her sorguda ELLE uygular — Dashboard repo'suyla ayni desen.
 *
 * password_hash hicbir okuma sorgusunda SELECT edilmez; yalnizca yazilir.
 */
final class UserRepository
{
    // Okunan sutunlar — password_hash BILEREK yok.
    private const COLS = 'id, tenant_id, username, display_name, role, is_active, created_at, updated_at';

    public function __construct(private Context $ctx) {}

    private function pdo(): PDO
    {
        return Db::pdo();
    }

    /** @return array<array> Tenant kapsamli tum kullanicilar (ada gore). */
    public function all(): array
    {
        $stmt = $this->pdo()->prepare(
            'SELECT ' . self::COLS . ' FROM users WHERE tenant_id = :t ORDER BY display_name ASC, id ASC'
        );
        $stmt->execute(['t' => $this->ctx->tenantId]);
        return $stmt->fetchAll();
    }

    public function find(int $id): ?array
    {
        $stmt = $this->pdo()->prepare(
            'SELECT ' . self::COLS . ' FROM users WHERE id = :id AND tenant_id = :t'
        );
        $stmt->execute(['id' => $id, 't' => $this->ctx->tenantId]);
        return $stmt->fetch() ?: null;
    }

    /**
     * username GLOBAL benzersizdir (v1 login yalnizca username ile arar; DB'de
     * uniq_username global). Cakismayi net mesajla yakalamak icin once sorulur.
     */
    public function usernameExists(string $username, ?int $exceptId = null): bool
    {
        $sql = 'SELECT COUNT(*) FROM users WHERE username = :u';
        $params = ['u' => $username];
        if ($exceptId !== null) {
            $sql .= ' AND id <> :id';
            $params['id'] = $exceptId;
        }
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn() > 0;
    }

    public function create(string $username, string $passwordHash, string $displayName, string $role): int
    {
        $stmt = $this->pdo()->prepare(
            'INSERT INTO users (tenant_id, username, password_hash, display_name, role, is_active)
             VALUES (:t, :u, :ph, :dn, :r, 1)'
        );
        $stmt->execute([
            't'  => $this->ctx->tenantId,
            'u'  => $username,
            'ph' => $passwordHash,
            'dn' => $displayName,
            'r'  => $role,
        ]);
        return (int) $this->pdo()->lastInsertId();
    }

    /**
     * @param array<string,mixed> $cols DTO::toColumns ciktisi (display_name / is_active)
     * @throws RuntimeException NOT_FOUND | STALE
     */
    public function updateProfile(int $id, array $cols, ?string $expectedUpdatedAt): void
    {
        $current = $this->find($id);
        if ($current === null) {
            throw new RuntimeException('NOT_FOUND');
        }
        if ($expectedUpdatedAt !== null && ($current['updated_at'] ?? null) !== $expectedUpdatedAt) {
            throw new RuntimeException('STALE');
        }
        if ($cols === []) {
            return;
        }

        $sets = implode(', ', array_map(fn($c) => "`$c` = :$c", array_keys($cols)));
        $this->pdo()->prepare("UPDATE users SET $sets WHERE id = :_id AND tenant_id = :_t")
            ->execute($cols + ['_id' => $id, '_t' => $this->ctx->tenantId]);

        // Pasife alindiysa acik oturumlari kapat — kullanici aninda dusar.
        if (array_key_exists('is_active', $cols) && (int) $cols['is_active'] === 0) {
            $this->killSessions($id);
        }
    }

    /** @return bool kullanici bulundu mu */
    public function resetPassword(int $id, string $passwordHash): bool
    {
        if ($this->find($id) === null) {
            return false;
        }
        $this->pdo()->prepare('UPDATE users SET password_hash = :ph WHERE id = :id AND tenant_id = :t')
            ->execute(['ph' => $passwordHash, 'id' => $id, 't' => $this->ctx->tenantId]);
        return true;
    }

    private function killSessions(int $userId): void
    {
        $this->pdo()->prepare('DELETE FROM sessions WHERE user_id = :u AND tenant_id = :t')
            ->execute(['u' => $userId, 't' => $this->ctx->tenantId]);
    }
}
