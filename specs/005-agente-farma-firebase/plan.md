# Implementation Plan: Agente farmacéutico multi-tenant con datos de Firebase

**Branch**: `005-agente-farma-firebase` | **Date**: 2026-08-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-agente-farma-firebase/spec.md`

## Summary

El CRM se vuelve farmacéutico y multi-tenant: cada negocio contratante es una organización con su propio agente. La fuente de verdad de precios y disponibilidad vive en **Firebase** (collections `provider` y `products-providers`). Este plan (lado CRM) implementa:

1. **Migración** `organization.provider_id` (asociar cada tenant a un `providerId` de Firebase).
2. **Cliente Firebase** (service account de solo-lectura) para leer `provider` y `products-providers`.
3. **Endpoints de bot** `/api/bot/products` (consulta de catálogo por `providerId`) y `/api/bot/providers` (info de la farmacia).
4. **UI de administración** (settings) para editar el `providerId` del tenant.

## Technical Context

**Language/Version**: TypeScript 5.7, Node >= 20, Next.js 15.1

**Primary Dependencies**: `firebase-admin` (Firestore), `drizzle-orm` + `postgres`, `zod`, `better-auth`

**Storage**: PostgreSQL (multi-tenant, `organization.provider_id`), Firebase Firestore (catálogo, solo lectura)

**Testing**: `vitest` (unit), `scripts/e2e-selftest.mjs` (E2E), Playwright (UI)

**Target Platform**: Railway (contenedor Next.js standalone, puerto 8080)

**Project Type**: Web service (Next.js app router + API routes)

**Performance Goals**: Consulta de catálogo devuelve en < 1s (Firestore query con índice por `providerId`).

**Constraints**: Servir catálogo filtrado por `providerId`; aislamiento multi-tenant (Principio I y III de la constitución). Firebase solo lectura.

**Scale/Scope**: Multi-tenant real; cada instancia = un negocio. MVP: un `providerId` por tenant.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Status | Notas |
|------|--------|-------|
| **I. Seguridad de Datos** | ✅ | La service account de Firebase es de solo-lectura; las credenciales viven en env y nunca se exponen al cliente. |
| **II. Soberanía/Self-Hosted** | ⚠️ VIOLACIÓN | La constitución prohíbe "servicios de Google" en v1. Firebase (Google) es una dependencia externa nueva. Ver **Complexity Tracking**. |
| **III. Multi-Tenancy Real** | ✅ | `organization_id` ya es primer nivel; `provider_id` se añade a `organization` (org-first). |
| **IV. Idempotencia** | ✅ | El endpoint de consulta es de solo lectura; no introduce efectos no idempotentes. |
| **V. Calidad Verificable** | ✅ | Tests unit + E2E. |
| **VI. Specs Antes de Código** | ✅ | Este es el flujo ciclo completo. |
| **VIII. Foco Vertical** | ✅ | Sirve al CRM de WhatsApp (disponibilidad/precio de medicamentos). |
| **IX. Verificación en Vivo** | ✅ | Quickstart + E2E real por canal. |

### Research.md (Phase 0)

- **Firebase Admin SDK**: usar `firebase-admin` v12+. La service account (JSON) se carga desde env como variables `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
- **Búsqueda por nombre en Firestore**: `products-providers` filtrado por `providerId` (campo exacto) + búsqueda de nombre por tokens en el cliente (descargar docs del provider y filtrar en memoria, ya que el catálogo por tenant es acotado). Alternativa: índice compuesto y `array-contains` si el documento tiene un campo de tokens de búsqueda.
- **Índices Firestore**: se requiere índice compuesto en `products-providers` por `providerId` + (nombre/tokens) si se usa query de rango; si se filtra en memoria no hace falta índice extra.

### data-model.md (Phase 1)

**`organization`** (migración):
- `provider_id`: `text`, nullable (no todos los tenants son farmacias).

### contracts/ (Phase 1)

- `GET /api/bot/products?q=<nombre>&providerId=<id>&limit=<n>` (auth `X-API-Key` BOT_API_KEY)
- `GET /api/bot/providers?providerId=<id>` (auth `X-API-Key` BOT_API_KEY)
- Ver detalle en `contracts/README.md`.

### quickstart.md (Phase 1)

Ver validación E2E.

---

## Complexity Tracking

| Violación | Por qué | Alternativa rechazada |
|-----------|---------|------------------------|
| **II: Firebase (Google) como dependencia** | El usuario ya tiene el catálogo de precios/disponibilidad en Firebase; reutilizarlo es el requisito explícito y evita re-construir el comparador. | Migrar el catálogo a PostgreSQL del CRM: rompería el comparador existente y duplicaría datos. **Decisión del dueño: usar Firebase.** |

## Project Structure

### Documentation (this feature)

```text
specs/005-agente-farma-firebase/
├── plan.md              # Este archivo
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── README.md
└── tasks.md             # generado por /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── db/
│   │   └── schema.ts          # MODIFICAR: organization.provider_id
│   └── env.ts                 # MODIFICAR: FIREBASE_* creds
├── server/
│   ├── bot/
│   │   └── auth.ts            # reutilizar requireBotKey/resolveInstanceOrg
│   └── catalog/
│       ├── firebase.ts        # NUEVO: cliente Firestore (solo lectura)
│       └── query.ts           # NUEVO: consulta products/providers por providerId
├── app/api/
│   ├── bot/
│   │   ├── products/route.ts  # NUEVO: GET /api/bot/products
│   │   └── providers/route.ts # NUEVO: GET /api/bot/providers
│   └── settings/
│       └── whatsapp/route.ts  # +providerId en GET (channel config)
drizzle/                       # migración generada
```

**Structure Decision**: single Next.js project, patrón existente (server + app/api). Se sigue la estructura actual sin introducir layout nuevo.

## Complexity Tracking

| Violación | Por Qué | Alternativa Rechazada |
|---|---|---|
| (ninguna adicional) | | |

---

## Spec ref

- `spec.md` define FR-1 a FR-3 (endpoints y asociación providerId), Key Entities (provider, products-providers), SC (aislamiento por tenant).
