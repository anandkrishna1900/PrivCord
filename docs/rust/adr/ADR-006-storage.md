# ADR-006: One SQLite storage behind an atomic batch
**Decision.** `Storage::apply(&[StorageOp])` is the only write path and is atomic; SQLite in WAL mode with `synchronous=FULL`, foreign keys on, `integrity_check` on open, versioned with `user_version`, one transaction per migration, a copy of an existing database before its first migration, and refusal of a database from a newer version. The platform supplies only the file path.
**Consequences.** A message never exists without its outbox entry. Existing desktop and Android databases are **not** read yet: an importer is required before any legacy persistence code is removed.
**Revisit if** encryption at rest moves into the database (SQLCipher) instead of the current column-level and file-level encryption in the apps.
