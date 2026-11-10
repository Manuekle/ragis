# Restauración consistente (RPO ≤ 24 h, RTO ≤ 8 h en MVP)

Los snapshots de RDS no reconstruyen S3 ni el estado de jobs de forma transaccional.

1. Restaurar RDS a un punto en el tiempo (PITR) en una instancia nueva; apuntar servicios en modo mantenimiento.
2. S3 está versionado: los objetos originales son la fuente de verdad; no se requiere restauración salvo borrado.
3. Reconciliar: versiones `indexed` cuyo objeto no exista en S3 → marcar `failed` (`error_code='restore_missing_object'`).
4. Chunks/embeddings son derivados: si hay dudas de consistencia, reindexar (runbook `reindex.md`) desde los originales.
5. Jobs `queued/running` posteriores al punto de restauración: reencolar.
6. Ensayo obligatorio trimestral (gate de "Continuidad" en la checklist de producción).
