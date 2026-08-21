# Tasks: Agente farmacéutico multi-tenant con datos de Firebase

**Input**: Design documents from `/specs/005-agente-farma-firebase/`

**Prerequisites**: plan.md, spec.md, data-model.md, contracts/, research.md, quickstart.md

**Tests**: Se incluyen tests unit de las queries de catálogo y del endpoint, y validación E2E en quickstart (Constitución IX del proyecto: verificación en vivo).

**Organization**: Tasks grouped by user story.

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

- Single project (Next.js app router): `src/` en raíz.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Config de Firebase Admin SDK y variables de entorno.

- [ ] T001 Añadir dependencia `firebase-admin` en `package.json` (pnpm add firebase-admin)
- [ ] T002 [P] Añadir vars Firebase a `src/lib/env.ts`: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_COLLECTION_PRODUCTS`, `FIREBASE_COLLECTION_PROVIDERS`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Sin el cliente Firebase y la migración de `provider_id`, ninguna user story funciona.

- [ ] T003 Crear `src/server/catalog/firebase.ts` — cliente Firestore (firebase-admin) con inicialización lazy y credenciales desde env, SOLO lectura.
- [ ] T004 [P] Añadir columna `provider_id` (text, nullable) a `organization` en `src/lib/db/schema.ts`
- [ ] T005 [P] Generar y aplicar migración: `pnpm db:generate && pnpm db:migrate`
- [ ] T006 Crear `src/server/catalog/query.ts` — consultas: `getProductsByProvider(providerId, q, limit)` y `getProviderInfo(providerId)` filtrando por `providerId` en Firestore.

**Checkpoint**: Fundación lista — usuario stories pueden comenzar.

---

## Phase 3: User Story 1 — Consulta de disponibilidad y precio (Priority: P1) 🎯 MVP

**Goal**: El cliente pregunta por un medicamento y el agente responde disponibilidad y precio, consultando el catálogo del tenant.

**Independent Test**: curl a `GET /api/bot/products?q=losartan&providerId=<id>` devuelve 200 con `products[]`.

### Tests for User Story 1

- [ ] T007 [P] [US1] Test unit de `getProductsByProvider` en `tests/catalog/query.test.ts` (mock de Firestore)

### Implementation for User Story 1

- [ ] T008 [US1] Crear `src/app/api/bot/products/route.ts` — `GET /api/bot/products?q=&providerId=&limit=` con `requireBotKey`, resuelve providerId por org si falta, responde `{products, provider}` o error tipado (401/409/422/404/503).
- [ ] T009 [US1] Resolver `providerId` por org: modificar `resolveInstanceOrg` (o helper) para leer `organization.provider_id` en `src/server/bot/auth.ts`
- [ ] T010 [US1] Manejar 422 `no_catalogo` cuando el tenant no tiene providerId configurado.

**Checkpoint**: User Story 1 funcional — el bot puede consultar disponibilidad/precio.

---

## Phase 4: User Story 2 — Comparativa y genérico (Priority: P2)

**Goal**: El agente ofrece el genérico con su precio si el catálogo lo tiene.

### Implementation for User Story 2

- [ ] T011 [P] [US2] Enriquecer `getProductsByProvider` para incluir `nombreGenerico` y permitir filtrar por genérico (`q` sobre `nombreGenerico`) en `src/server/catalog/query.ts`
- [ ] T012 [US2] Documentar en `contracts/README.md` que `products[]` incluye `generico` (ya definido) y que la búsqueda también cubre genéricos.

**Checkpoint**: US1 + US2 funcionan — el agente responde precio y genérico.

---

## Phase 5: User Story 3 — Consulta por receta OCR (Priority: P2)

**Goal**: El agente responde disponibilidad de varios medicamentos de una foto de receta.

**Nota**: La extracción OCR vive en el agente (`nea-agent`, spec 001-agente-farmacia-rol). En el CRM solo se necesita que `/api/bot/products` acepte **múltiples `q`** (una por medicamento extraído).

### Implementation for User Story 3

- [ ] T013 [P] [US3] Permitir `q` múltiple (coma separado o `q[]`) en `src/app/api/bot/products/route.ts` para consultar varios medicamentos de una receta.
- [ ] T014 [US3] Devolver `missing[]` para los medicamentos que no están en el catálogo (para que el agente sea honesto).

**Checkpoint**: US3 funcional — el agente responde varios medicamentos de una receta.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Aislamiento, errores y validación en vivo.

- [ ] T015 [P] Verificar aislamiento multi-tenant: `GET /api/bot/products` solo devuelve el `providerId` del tenant (test manual con dos orgs).
- [ ] T016 [P] Añadir logging de consultas de catálogo (providerId, q, resultados) para observabilidad.
- [ ] T017 Correr `pnpm typecheck && pnpm lint && pnpm build`
- [ ] T018 Correr `quickstart.md` validación E2E (curl a products/providers, aislamiento, info provider).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: sin dependencias — puede empezar.
- **Foundational (P2)**: depende de Setup — BLOQUEA todas las stories.
- **US1/P1 (P3)**: depende de Fundacional. Es el MVP.
- **US2 (P4)**: depende de Fundacional; integra con US1.
- **US3 (P5)**: depende de Fundacional; amplía US1 (multi-q).
- **Polish (P6)**: depende de todas.

### User Story Dependencies

- **US1**: MVP, primero.
- **US2**: después de US1.
- **US3**: después de US1 (reusa el endpoint).

### Parallel Opportunities

- Setup (T001, T002) paralelo.
- Fundacional (T003-T006) parcialmente paralelo.
- Tras Fundacional, US1 es el MVP único; US2 y US3 pueden ir en paralelo si hay equipo.

---

## Implementation Strategy

### MVP First (User Story 1)

1. Setup + Fundacional (T001-T006)
2. User Story 1 (T007-T010) → **VALIDAD con curl**
3. Deploy/demo del MVP (consulta de disponibilidad/precio)

### Incremental Delivery

1. Foundation → consulta de catálogo básica (MVP).
2. +US2 → genérico.
3. +US3 → multi-medicamento receta.

---

## Notes

- [P] = archivos distintos, sin dependencias.
- [Story] = traza a user story.
- Cada user story debe completarse y validarse independientemente.
- Commit después de cada tarea o grupo lógico.
