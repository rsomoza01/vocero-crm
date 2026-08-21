# Feature Specification: Agente farmacéutico multi-tenant con datos de Firebase

**Feature Branch**: `005-agente-farma-firebase`

**Created**: 2026-08-20

**Status**: Draft

**Carril**: Ciclo completo (obligatorio: toca modelo de datos y contrato `/api/bot/*`)

**Input**: Plan de integración `nea-agent ↔ vocero-crm` aprobado por el usuario: transformar `nea-agent` en un farmacéutico virtual por cada cliente contratante, con datos de Firebase (collections `provider` y `products-providers`), un solo `providerId` por farmacia, una service account de solo-lectura compartida, y las reglas de negocio del bot Gentefarma convertidas a Markdown como conocimiento del agente.

---

## Resumen

El CRM se vuelve farmacéutico y multi-tenant: cada negocio contratante es una organización con su propio agente. La fuente de verdad de precios y disponibilidad NO vive en el CRM sino en **Firebase**, con dos collections: `provider` (datos de la farmacia) y `products-providers` (productos con precio/disponibilidad por `providerId`). El agente externo (`nea-agent`) consulta estos datos **filtrado por el `providerId`** del tenant al que sirve, y responde a los clientes por WhatsApp con disponibilidad y mejor precio **sin inventar precios** (regla anti-alucinación: la fuente es `products-providers`).

Cada farmacia contratada tiene **un solo `providerId`** (solo su propio catálogo) y el CRM usa **una sola service account de solo-lectura** compartida para acceder a Firebase.

## Clarifications

### Session 2026-08-20

- Q: ¿Cuáles son los nombres exactos de las collections de Firebase? → A: `products-providers` y `provider` (nombres reales del bot Gentefarma).
- Q: ¿El agente se despliega por farmacia o en una sola instancia? → A: Una instancia de `nea-agent` por cada farmacia (aislada).
- Q: ¿Cómo se resuelve el `providerId` del tenant? → A: Variable de entorno de la instancia (`PROVIDER_ID`), fija y explícita.
- Q: ¿Se incluye OCR de recetas en el MVP? → A: Sí, OCR de recetas está en el MVP (User Story 3, FR-8).
- Q: ¿Cómo se maneja el precio y el fee? → A: Se muestra USD y Bs (precio base convertido con tasa BCV), **sin aplicar fee comercial**.

---

## User Scenarios & Testing

### User Story 1 - Consulta de disponibilidad y precio (Priority: P1)

Un cliente escribe a la farmacia por WhatsApp preguntando por un medicamento (ej. "¿tienen losartán 50 mg?"). El agente identifica la intención `medicine_search`, consulta el catálogo del tenant y responde con la disponibilidad y el mejor precio del medicamento.

**Why this priority**: Es el flujo principal que da valor al producto — atender consultas reales de clientes. Sin esto no hay producto.

**Independent Test**: Puede probarse enviando por WhatsApp una consulta de un medicamento que SÍ está en el catálogo del tenant y verificando que el agente responde disponibilidad y precio.

**Acceptance Scenarios**:
1. **Given** el catálogo del tenant tiene "losartán 50 mg" con stock, **When** el cliente pregunta "¿tienen losartán 50 mg?", **Then** el agente responde que está disponible e indica su precio (USD y Bs).
2. **Given** el cliente pregunta por un medicamento que NO está en el catálogo, **When** el agente busca, **Then** responde honestamente que no está disponible o escala a un humano (no inventa precio).

---

### User Story 2 - Consulta de precio con comparativa y genérico (P2)

El cliente pregunta el precio de un medicamento. El agente muestra el precio por droguería si el tenant tuviera varios proveedores, y ofrece alternativas genéricas cuando el catálogo las tiene.

**Why this priority**: Es el segundo flujo de valor más frecuente y aprovecha el comparador de precios existente.

**Independent Test**: Consulta por precio de un medicamento que tiene genéricos en el catálogo → el agente responde el precio y ofrece el genérico.

**Acceptance Scenarios**:
1. **Given** el medicamento tiene alternativas genéricas en el catálogo del tenant, **When** el cliente pregunta el precio, **Then** el agente responde el precio del medicamento y ofrece el genérico con su precio.
2. **Given** el tenant tiene un solo `providerId`, **When** el cliente pregunta por varias droguerías, **Then** el agente solo responde el precio de la droguería del tenant (no inventa comparación).

---

### User Story 3 - Consulta de disponibilidad por receta (OCR) (P2)

El cliente envía una foto de su receta médica. El agente extrae los medicamentos de la imagen y responde la disponibilidad de cada uno.

**Why this priority**: Es un flujo valioso y frecuente en farmacias; agrega valor al atender recetas sin tipeo manual.

**Independent Test**: Enviar por WhatsApp una foto de receta y verificar que el agente extrae y responde los medicamentos de la receta.

**Acceptance Scenarios**:
1. **Given** el cliente envía una foto de receta con medicamentos, **When** el agente procesa la imagen (OCR), **Then** responde disponibilidad y precio de cada medicamento de la receta.
2. **Given** la receta contiene un medicamento fuera del catálogo, **When** el agente responde, **Then** lo dice con honestidad y no lo inventa.

---

### Edge Cases

- Qué pasa cuando el cliente pregunta por un medicamento que no está en el catálogo → el agente no inventa precio; dice que lo confirmará o escala.
- Cómo maneja el sistema un medicamento con múltiples presentaciones → mostrar cada presentación con su precio.
- Qué pasa si el `providerId` del tenant no tiene datos en Firebase → el agente indica que no hay catálogo disponible y escala a humano.
- Cómo afecta la ventana de 24h de WhatsApp → el canal Evolution (WhatsApp Web) no restringe, así que el agente puede responder libremente (ya gestionado).

---

## Requirements

### Functional Requirements

- **FR-1**: El CRM MUST exponer un endpoint `/api/bot/products` que consulte Firebase (collection `products-providers`) filtrando por el `providerId` del tenant y devuelva disponibilidad y precio.
- **FR-2**: El CRM MUST asociar cada organización (tenant) con un `providerId` de Firebase (migración de la tabla `organization`).
- **FR-3**: El CRM MUST consultar Firebase usando una service account de solo-lectura compartida (no por tenant).
- **FR-4**: El agente externo (`nea-agent`) MUST tener un rol farmacéutico cuyo system prompt responda consultas de disponibilidad y mejor precio, consultando el catálogo por tool y NUNCA inventando precios.
- **FR-5**: El agente MUST tener herramientas de consulta de medicamento: buscar por nombre, comparar precios (si el tenant tiene varios provider), sugerir genéricos, y devolver info del proveedor (dirección/horario).
- **FR-6**: El agente MUST incorporar las reglas de negocio del bot Gentefarma convertidas a Markdown como conocimiento (intención, carrito, OCR, mensajes, precio USD/Bs con conversión por tasa BCV).
- **FR-9**: El agente MUST mostrar el precio en USD (precio base del catálogo) y en Bs convertido con la tasa BCV, **sin aplicar ningún cargo/fee adicional** (el precio mostrado es el precio base del catálogo).
- **FR-7**: El agente MUST escalar a humano (`handoff`) cuando la consulta sea médica seria, requiera receta nueva, o el medicamento no esté en el catálogo y no se pueda confirmar.
- **FR-8**: El agente MUST procesar recetas médicas por foto (OCR) en el MVP: extraer los medicamentos de la imagen, buscar cada uno en el catálogo y responder disponibilidad/precio.

### Key Entities

- **Organization (tenant)**: negocio que contrata el CRM; tiene un `providerId` de Firebase.
- **provider**: collection en Firebase con info de la farmacia (id/nombre/dirección/horario/ciudad).
- **products-providers**: collection en Firebase con producto × provider (providerId, nombre, presentación, laboratorio, precio, disponibilidad, requiereReceta). Nombre real confirmado del bot Gentefarma.
- **AgentProfile**: perfil del agente farmacéutico configurable por organización.

## Success Criteria

### Measurable Outcomes

- **SC-001**: El cliente obtiene disponibilidad y precio de un medicamento del catálogo en la misma conversación de WhatsApp, en menos de 30 segundos tras enviar la consulta.
- **SC-002**: El agente responde honestamente "no disponible" o escala a humano cuando el medicamento no está en el catálogo — 100% de los casos (no alucina precio).
- **SC-003**: Cada farmacia contratante solo consulta su propio catálogo (aislamiento por `providerId`); nunca se muestran datos de otra farmacia.
- **SC-004**: El agente responde con reglas de negocio de Gentefarma (fee, horario, pago, OCR) sin inventar datos.

## Assumptions

- La collection Firebase se llama `products-providers` y `provider` (nombres reales del bot Gentefarma). El precio se muestra en USD y Bs convertido con tasa BCV, **sin cargo comercial (fee)**: se muestra el precio base del catálogo.
- Cada farmacia tiene un solo `providerId` (MVP; no se compara entre varias droguerías en v1).
- Una service account de solo-lectura compartida basta para el acceso a Firebase.
- El agente se implementa en `nea-agent` (rol farmacéutico) y el CRM en `vocero-crm`; el catálogo y la reglas de negocio (Gentefarma) se cargan como conocimiento del agente.
