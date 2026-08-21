# Research — Agente farmacéutico multi-tenant con Firebase (lado CRM)

**Decision**: Usar `firebase-admin` (Firestore) con una service account de solo-lectura, configurada por env, para consultar las collections `provider` y `products-providers`.

**Rationale**:
- El catálogo de precios/disponibilidad YA vive en Firebase (el comparador existente). Reutilizarlo evita duplicar datos y es el requisito explícito del dueño.
- Una única service account compartida (env del CRM) da acceso de solo lectura a todas las collections, respetando el aislamiento por `providerId` (cada query filtra por el provider del tenant).
- La búsqueda por nombre se hace en el cliente (in-memory) tras filtrar por `providerId`: el catálogo de un tenant es acotado y evita índices compuestos extra de Firestore.

**Alternatives considered**:
- Migrar el catálogo a PostgreSQL del CRM → rechazado (duplicaría datos y rompería el comparador externo).
- Acceso por tenant con credenciales separadas → rechazado (el dueño pidió una sola service account compartida).

## Configuración Firebase

- **Env del CRM**: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_COLLECTION_PRODUCTS=products-providers`, `FIREBASE_COLLECTION_PROVIDERS=provider`.
- **Firebase Admin SDK**: `initializeApp` con `credential.cert({projectId, clientEmail, privateKey})`. Lazy init (solo cuando se necesita).
- **Solo lectura**: usar Firestore `get()` / `where()`, nunca `set/update/delete`.

## Búsqueda de medicamentos

- Query: `collection('products-providers').where('providerId', '==', <id>)`.
- Luego filtrado en memoria por nombre (substring case-insensitive sobre el nombre/producto).
- Devolver: producto, presentación, laboratorio, precio (USD), disponibilidad, requiereReceta.

## Índices de Firestore

- Si se usa `where('providerId','==',...)` sin rango en el mismo campo, NO requiere índice compuesto extra (índice por campo por defecto). Si en el futuro se filtra por precio con rango, se creará índice compuesto. MVP: filtrado por providerId + filtro nombre en memoria → sin índice extra.

## Riesgos

- Service account con permisos de lectura en ambas collections. Asegurar que el documento tenga `providerId` en los products.
- Latencia de Firestore: <1s en query acotada por providerId.
