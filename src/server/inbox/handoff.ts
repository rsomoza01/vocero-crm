import { and, eq, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * HANDOFF POR RESPUESTA MANUAL: liberación automática.
 *
 * Cuando el dueño contesta desde la app del teléfono, `ingest` pausa la IA con
 * `handoff_reason = 'manual_reply'`. Antes esa pausa era INDEFINIDA: si el
 * cliente volvía a escribir días después, el mensaje entraba a la bandeja y el
 * agente se quedaba mudo para siempre (providerId 05 llegó a tener 28
 * conversaciones así, y 47 en handoff en total).
 *
 * Ahora, pasado `HANDOFF_MANUAL_TTL_HOURS`, el siguiente mensaje del cliente
 * devuelve la conversación al agente. Los otros motivos (`cliente`,
 * `hostilidad`, `medicamento_no_disponible`, `modelo`, `error`) NO se tocan:
 * esos son decisiones que un humano tiene que revisar.
 */

/** Horas tras las que un handoff por respuesta manual se libera solo. */
export function handoffManualTtlHoras(): number {
  const n = Number(process.env.HANDOFF_MANUAL_TTL_HOURS ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HANDOFF_MANUAL_TTL_HORAS;
}

export const DEFAULT_HANDOFF_MANUAL_TTL_HORAS = 24;

/** Fecha de corte: un handoff anterior a esto ya expiró. */
export function corteHandoffManual(ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() - handoffManualTtlHoras() * 3600_000);
}

type ConversacionPausada = {
  id: string;
  aiEnabled: boolean;
  handoffAt: Date | null;
  handoffReason: string | null;
};

/**
 * ¿Esta conversación se puede liberar sola? Solo si está pausada por
 * respuesta manual y el handoff ya pasó el TTL.
 */
export function handoffManualExpirado(
  conversation: ConversacionPausada,
  ahora: Date = new Date()
): boolean {
  if (conversation.aiEnabled && !conversation.handoffAt) return false;
  if (conversation.handoffReason !== "manual_reply") return false;
  if (!conversation.handoffAt) return false;
  return conversation.handoffAt.getTime() <= corteHandoffManual(ahora).getTime();
}

/**
 * Libera el handoff si expiró. Devuelve `true` si la conversación quedó
 * reactivada (el llamador ya puede tratarla como si tuviera la IA encendida).
 *
 * El UPDATE va condicionado en SQL para que sea atómico: dos mensajes seguidos
 * del cliente no liberan dos veces ni pisan un handoff nuevo que un humano
 * acabe de crear.
 */
export async function liberarHandoffManualExpirado(
  conversation: ConversacionPausada,
  ahora: Date = new Date()
): Promise<boolean> {
  if (!handoffManualExpirado(conversation, ahora)) return false;

  const db = getDb();
  const liberadas = await db
    .update(schema.conversation)
    .set({
      aiEnabled: true,
      handoffAt: null,
      handoffReason: null,
      updatedAt: ahora,
    })
    .where(
      and(
        eq(schema.conversation.id, conversation.id),
        eq(schema.conversation.handoffReason, "manual_reply"),
        lte(schema.conversation.handoffAt, corteHandoffManual(ahora))
      )
    )
    .returning({ id: schema.conversation.id });

  if (!liberadas.length) return false;

  console.log(
    `[handoff] liberación automática en ${conversation.id}: respuesta manual de hace más de ` +
      `${handoffManualTtlHoras()} h — la IA retoma la conversación`
  );
  return true;
}
