# Quickstart — Validación del agente farmacéutico (lado CRM)

> Guía de validación E2E del catálogo en el CRM. Los detalles de implementación viven en `tasks.md` / `plan.md`.

## Prerequisitos

- `.env` del CRM con:
  - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (service account de solo lectura)
  - `FIREBASE_COLLECTION_PRODUCTS=products-providers`, `FIREBASE_COLLECTION_PROVIDERS=provider`
  - `BOT_API_KEY` (para `/api/bot/*`)
- PostgreSQL con migración `organization.provider_id` aplicada.
- Firebase con la collection `products-providers` (docs con `providerId`) y `provider`.

## Setup

```bash
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm dev  # o railway up
```

## Validación

### 1. Asociar providerId a un tenant

Configurar `organization.provider_id` = `<providerId>` de la farmacia (via SQL o UI admin).

### 2. Consulta de catálogo (bot)

```bash
curl -H "X-API-Key: $BOT_API_KEY" \
  "https://<crm>/api/bot/products?q=losartan&providerId=<id>"
```

**Esperado**: 200 con `products[]` conteniendo el medicamento y su precio/disponibilidad.

### 3. Aislamiento por tenant

- Con `providerId` de farmacia A → solo productos de A.
- Con `providerId` de farmacia B → solo productos de B.
- **Esperado**: nunca se cruzan.

### 4. Info del proveedor

```bash
curl -H "X-API-Key: $BOT_API_KEY" "https://<host>/api/bot/providers?providerId=<id>"
```
**Esperado**: 200 con datos de la farmacia (dirección/horario).

## E2E de la consola (si aplica)

- Navegar a Settings → WhatsApp → editar `providerId` del tenant.
- Guardar y verificar que persiste en BD.

## Resultado esperado (Success Criteria)

- **SC-001/SC-002**: consulta de medicamento del catálogo responde disponibilidad y precio; medicamento ausente → no alucina.
- **SC-003**: cada tenant consulta solo su `providerId`.
