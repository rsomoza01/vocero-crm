# Data Model — Agente farmacéutico multi-tenant con Firebase (lado CRM)

## Entity: organization (tabla Postgres `organization`)

**Migración**: añadir columna `provider_id`.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | text PK | Identificador de la organización |
| `name` | text NOT NULL | Nombre del negocio |
| `slug` | text UNIQUE | Slug |
| `logo` | text | Logo |
| `metadata` | text | Metadata JSON |
| `provider_id` | text NULL (NUEVO) | `providerId` de Firebase asociado a la farmacia (tenían un solo provider). Null si el tenant no es farmacia. |

## Collections Firebase (lectura, no se persiste en CRM)

### provider
Info básica de la farmacia/droguería.

| Campo | Tipo | Descripción |
|-------|-----|-------------|
| `providerId` | string | Identificador del provider |
| `nombre` | string | Nombre de la farmacia |
| `direccion` | string | Dirección |
| `horario` | string | Horario de atención |
| `ciudad` | string | Ciudad |
| `location` | {lat, lng}? | Coordenadas (para distancia) |

### products-providers
- Un documento por (producto × provider).
- `providerId` filtra el catálogo del tenant.

| Campo | Tipo | Descripción |
|-------|-----|-------------|
| `providerId` | string | Identificador del provider |
| `nombreProducto` | string | Nombre del medicamento |
| `nombreGenerico` | string | Nombre genérico |
| `presentacion` | string | Presentación (tableta, cápsula, etc.) |
| `laboratorio` | string | Laboratorio |
| `precio` | number | Precio base (USD) |
| `disponibilidad` | number/string | Stock o disponibilidad |
| `requiereReceta` | boolean | Si requiere receta |

## Relaciones

- `organization.provider_id` → `provider.providerId` (uno a uno en MVP; cada farmacia tiene un solo provider).
- `products-providers.providerId` → `provider.providerId`.

## Validación

- `provider_id` opcional; si está vacío, el endpoint `/api/bot/products` no tiene catálogo que servir (responde "sin catálogo").
- Solo lectura: nunca escribir a Firebase.
