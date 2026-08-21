# Contracts — Agente farmacéutico multi-tenant (lado CRM)

## GET /api/bot/products

Consulta el catálogo de medicamentos de un tenant en Firebase.

**Auth**: Header `X-API-Key: <BOT_API_KEY>` (misma que el resto de `/api/bot/*`).

**Query params**:
| Param | Tipo | Descripción |
|-------|------|-------------|
| `q` | string | Término de búsqueda (nombre de medicamento, opcional) |
| `providerId` | string | `providerId` del tenant. Si se omite, usa el de la organización (`organization.provider_id`). |
| `limit` | number | Máx. resultados (default 10) |

**Response 200**:
```json
{
  "products": [
    {
      "productId": "string",
      "producto": "Losartán",
      "generico": "Losartán Potásico",
      "presentacion": "Tabletas 50 mg",
      "laboratorio": "Genfar",
      "precio": 12.5,
      "disponible": true,
      "requiereReceta": false
    }
  ],
  "provider": { "providerId": "xxx", "nombre": "Farmacia X" }
}
```

**Errores**:
- 401 `unauthorized` — falta/wrong BOT_API_KEY.
- 409 `no_org` — sin organización.
- 422 `no_catalogo` — el tenant no tiene `providerId` configurado.
- 404 `not_found` — sin resultados.
- 503 `firebase_unavailable` — no se pudo contactar Firebase.

---

## GET /api/bot/providers

Info básica de la farmacia del tenant.

**Auth**: `X-API-Key`.

**Query**: `providerId` (opcional; usa el de la org si se omite).

**Response 200**:
```json
{
  "provider": {
    "providerId": "xxx",
    "nombre": "Farmacia",
    "direccion": "...",
    "horario": "...",
    "ciudad": "..."
  }
}
```

**Errores**: igual que products (401/409/404/503).
