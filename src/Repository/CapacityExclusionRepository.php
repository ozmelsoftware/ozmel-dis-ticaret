<?php
declare(strict_types=1);

namespace App\Repository;

use App\Core\BaseRepository;

final class CapacityExclusionRepository extends BaseRepository
{
    protected function table(): string
    {
        return 'capacity_exclusions';
    }

    protected function columns(): array
    {
        return ['date', 'note'];
    }

    /** UNIQUE(tenant_id, date) — cakismayi 1062 yerine net mesajla once sorar. */
    public function dateExists(string $date, ?int $exceptId = null): bool
    {
        $sql = "SELECT COUNT(*) FROM `{$this->table()}` WHERE tenant_id = :t AND `date` = :d";
        $params = ['t' => $this->ctx->tenantId, 'd' => $date];
        if ($exceptId !== null) {
            $sql .= ' AND id <> :id';
            $params['id'] = $exceptId;
        }
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn() > 0;
    }
}
