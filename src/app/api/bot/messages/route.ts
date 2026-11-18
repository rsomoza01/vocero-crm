import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveOrgFromConversation } from "@/server/bot/auth";
import { SendError, sendText } from "@/server/inbox/send";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4096),
});

/**
 * Envío del cerebro externo A TRAVÉS del CRM: el token de WhatsApp nunca sale
 * de aquí. Usa el mismo camino que el composer de la bandeja (`sendText`), así
 * que el mensaje queda en el hilo marcado como IA, respeta la ventana de 24 h
 * y hereda el guard de sandbox del Laboratorio.
 *
 * 409 tipados: ai_paused (un humano tomó la conversación) · window_closed ·
 * sandbox_violation.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  // MULTI-TENANT: la org se resuelve del CONVERSATION ID de la conversación a la
  // que se responde (cada instancia Evolution = una org). No de una org global:
  // con varias farmacias conectadas, usar una org única haría que la respuesta
  // saliera por la instancia equivocada (p.ej. Gentefarma en vez de FarmaTocToc).
  const organizationId = await resolveOrgFromConversation(body.data.conversationId);
  if (!organizationId) {
    return apiError(409, "no_org", "La conversación no tiene organización");
  }

  // Gate de handoff: el bot JAMÁS habla sobre una conversación pausada. Se
  // relee aquí porque entre que el bot pidió el contexto y armó su respuesta
  // (segundos de un LLM) el dueño pudo haber tomado la conversación.
  const db = getDb();
  const convs = await db
    .select({
      aiEnabled: schema.conversation.aiEnabled,
      handoffAt: schema.conversation.handoffAt,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  const conv = convs[0];
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");
  if (!conv.aiEnabled || conv.handoffAt) {
    return apiError(409, "ai_paused", "La IA está en pausa en esta conversación");
  }

  try {
    const result = await sendText({
      conversationId: body.data.conversationId,
      organizationId,
      text: body.data.text,
      aiGenerated: true,
    });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SendError) {
      if (err.code === "window_closed") {
        return apiError(409, "window_closed", err.message);
      }
      if (err.code === "sandbox_violation") {
        return apiError(409, "sandbox_violation", err.message);
      }
      // Fallos PERMANENTES: la instancia de la farmacia no está conectada o su
      // token ya no vale. Se devuelven como 409 (conflicto, no se arregla
      // reintentando) para que el agente NO reintente 4 veces ni encole en
      // pending_send: antes llegaban como 502, el agente los trataba como
      // transitorios, reintentaba y encolaba mensajes que nunca podían salir.
      if (err.code === "reconnect_required" || err.code === "not_connected") {
        return apiError(409, err.code, err.message);
      }
      return apiError(502, err.code, err.message);
    }
    throw err;
  }
}
