# FORGE PostgreSQL Schema 0.1.3

Implementación genérica del esquema físico FORGE para PostgreSQL 14+. No contiene nombres, seeds ni contratos acoplados a proyectos o agentes concretos.

## Contenido

- `database/migrations/0001_forge_core.sql` — núcleo relacional; funciona sin pgvector.
- `database/migrations/0002_forge_vector.sql` — activa pgvector y crea perfiles/embeddings.
- `database/migrations/0003_forge_indexes.sql` — índices operativos e idempotencia.
- `database/migrations/0004_forge_guards.sql` — versionado, historial y append-only.
- `database/migrations/0005_forge_schema_0_1_1.sql` — correcciones SQL-02/06/07/08.
- `database/migrations/0006_forge_schema_0_1_2.sql` — validación dimensional segura para el rol limitado.
- `database/migrations/0007_forge_schema_0_1_3.sql` — historial inmutable por versión de fuente.
- `src/migrations.mjs` — runner transaccional con checksums e historial.
- `tests/schema.test.mjs` — suite compartida para PostgreSQL embebido y servidor real.
- `compose.yaml` — PostgreSQL 14 + pgvector 0.8.2 para validación reproducible.

## Ejecución rápida

Requiere Node.js 20+.

```powershell
npm install
npm test
```

La prueba por defecto utiliza PostgreSQL embebido persistente (PGlite), ejecuta la ruta `0.1 → 0.1.3`, cierra el runtime, lo abre de nuevo y comprueba los datos.

Con Docker disponible:

```powershell
npm run test:docker
```

Esta variante usa la imagen `pgvector/pgvector:0.8.2-pg14`, ejecuta la misma batería, añade la prueba de concurrencia de dimensiones, reinicia PostgreSQL y verifica la persistencia.

## Aplicar migraciones a un servidor

```powershell
$env:FORGE_DATABASE_URL = 'postgresql://user:password@host:5432/database'
npm run migrate
```

El runner crea `forge.schema_migrations`, guarda el SHA-256 de cada archivo y:

- omite migraciones ya aplicadas con el mismo checksum;
- aborta si un archivo aplicado fue modificado;
- aplica cada nueva migración y su registro en una transacción.

Para instalar solo el núcleo relacional durante una prueba:

```powershell
npm run migrate -- --up-to=1
```

## Usuario de ejecución con mínimo privilegio

Después de aplicar las migraciones, configura el usuario dedicado:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-and-test-runtime-role.ps1
```

El proceso es interactivo: solicita la contraseña administrativa directamente a
`psql`, permite elegir la contraseña de `forge_test_runner` sin mostrarla y
ejecuta automáticamente:

- el contrato negativo y positivo de permisos;
- la batería completa del Persistence Gateway;
- el smoke de continuidad con el usuario limitado.

Las credenciales solo existen en memoria durante la validación. No se escriben en
el proyecto ni en el informe de estado.

Para otros entornos PostgreSQL 14+, puede aplicarse
`scripts/setup-runtime-role.sql` con `psql` y ejecutar después
`npm run test:runtime-role` con `FORGE_DATABASE_URL` configurada.

En una instalación 0.1.2 existente, `scripts/apply-schema-0.1.3.ps1` aplica la
migración checksum-aware con contraseña administrativa oculta. Si solo faltan
los grants vectoriales, `scripts/apply-vector-runtime-grants.ps1` los añade sin
persistir credenciales.

## Semántica importante

- `version` es el token de optimistic locking. Los writers deben usar `WHERE id = ? AND version = ?`; una actualización obsoleta afecta cero filas.
- `context_packages`, `context_package_items`, `events`, `audit_log` y `document_paths` bloquean `UPDATE`/`DELETE` mediante triggers. Un propietario/DBA conserva autoridad DDL y `TRUNCATE`; append-only es una garantía para DML de aplicación, no una barrera contra el administrador.
- Los metadatos JSONB se validan estructuralmente. La validación semántica/versionado del payload pertenece al Gateway.
- No se crea índice ANN en 0.1.3: el tipo `vector` sin dimensión fija admite perfiles heterogéneos y la búsqueda inicial es exacta.
- `forge_test_runner` no puede crear objetos, alterar migraciones, borrar filas ni acceder a tablas fuera del slice operativo del Gateway.
- El rol puede leer las fuentes vectoriales e insertar perfiles/embeddings, pero no actualizarlos ni borrarlos.
- Cada embedding declara `source_version`; distintas versiones de una fuente se conservan como filas append-only, mientras una versión obsoleta no puede insertarse como si fuera actual.

Consulta [VALIDATION.md](docs/VALIDATION.md) para los resultados de esta implementación.
