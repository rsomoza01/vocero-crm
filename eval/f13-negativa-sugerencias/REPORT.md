# FASE 13 — Ajustes post-prueba real: negativa respetada + sugerencias directas

Spec: `agentNEA/docs/SPEC-F13-ajustes-prueba-real.md` (hallazgos de producción reportados por el cliente).

## Cambios (agentNEA, rama agent-qa)

1. **Negativa con carrito respetada** (`turn.py`): nueva flag `es_negativa_con_carrito`
   (farmacia + carrito activo + `_quiere_ver_resumen` casando el "no" suelto).
   G1-ext/G5/G6 no se aplican en ese turno y, si algún guard pisó el texto,
   se restaura el resumen canónico del carrito. El agente ya no responde al
   "NO" con "¿Cuál es el medicamento que buscas?".
2. **Sugerencias directas sin pedir permiso** (`prompt.py` línea 75): cuando el
   medicamento exacto no está, PROHIBIDO preguntar "¿quieres que busque
   alternativas?" — se presentan directamente las alternativas (principio
   activo/genérico) que ya devolvió `buscar_medicamento`.
   - `guards.py` NO se tocó (G1-G12 intactos).

## Contexto de ejecución

- Agente: `meituan/longcat-2.0` vía proxy Nous (:11500) — la GPU local cayó
  del bus a mitad de la sesión ("GPU is lost"); Ollama descartado para QA.
- Juez: LongCat (v2.4). Estado fresco (TRUNCATE nea-db) en cada corrida.

## Resultados

| Corrida | Config | Score | Detalle |
|---|---|---|---|
| `run_kqwu8v66m6hajjb83s86` (A) | prompt suave ("presenta directamente…") | 73 | 7 verde, 2 rojo (alucinación en comprador_decidido/pregunton_precios), 2 amarillo. LongCat burló la redacción suave y siguió pidiendo permiso. |
| `run_pbujqnvwslsu1bjq96v6` (B) | prompt reforzado (PROHIBIDO pedir permiso) | **95** | 10 verde, 1 amarillo (tono, plantilla G1 en pregunton_precios). **comprador_decidido rojo→verde**. 0 alucinaciones, 0 judge_failed. |

Delta vs histórico del agente LongCat (91): +4 → **PASS**. El refuerzo explícito
del prompt fue la pieza que corrigió el comportamiento de pedir permiso.

## Pendiente

- Commit agentNEA (turn.py + prompt.py) → push `gentefarma` → ff a `desarrollo`
  → push `rsomoza01/nea-agent` `desarrollo`.
- Verificar en producción real (pruebas del cliente) ambos casos corregidos.
