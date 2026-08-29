import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { serializeFicha } from "@/server/bot/ficha";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";

export const dynamic = "force-dynamic";

/**
 * Contexto conversacional para un cerebro externo (solo lectura).
 * GET /api/bot/context?waIdentity=... | ?conversationId=...
 *
 * NO devuelve el historial de mensajes: el bot lleva su propia memoria de la
 * conversación. Lo que aquí sale es lo que solo el CRM sabe — quién es la
 * persona, si un humano tomó el control y si la ventana de 24 h sigue abierta.
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const waIdentity = url.searchParams.get("waIdentity");
  const conversationId = url.searchParams.get("conversationId");
  if (!waIdentity && !conversationId) {
    return apiError(422, "invalid", "Falta waIdentity o conversationId");
  }

  const db = getDb();

  let contact: typeof schema.contact.$inferSelect | undefined;
  let conversation: typeof schema.conversation.$inferSelect | undefined;

  if (conversationId) {
    const rows = await db
      .select({ conversation: schema.conversation, contact: schema.contact })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        eq(schema.conversation.contactId, schema.contact.id)
      )
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.id, conversationId)
        )
      )
      .limit(1);
    contact = rows[0]?.contact;
    conversation = rows[0]?.conversation;
  } else if (waIdentity) {
    const contacts = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.waIdentity, waIdentity)
        )
      )
      .limit(1);
    contact = contacts[0];
    if (contact) {
      // La conversación del Laboratorio jamás se resuelve por identidad: ese
      // camino es para el bot de producción, que nunca debe hablarle a un
      // cliente simulado.
      const convs = await db
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.organizationId, organizationId),
            eq(schema.conversation.contactId, contact.id),
            eq(schema.conversation.isTest, false)
          )
        )
        .limit(1);
      conversation = convs[0];
    }
  }

  if (!contact || !conversation) {
    return apiError(404, "not_found", "Conversación no encontrada");
  }

  const leadRows = await db
    .select({ lead: schema.lead, stage: schema.pipelineStage })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.lead.stageId, schema.pipelineStage.id)
    )
    .where(
      and(
        eq(schema.lead.organizationId, organizationId),
        eq(schema.lead.contactId, contact.id)
      )
    )
    .limit(1);

  // providerId del catálogo Firebase (multi-tenant: cada farmacia = un
  // provider). El cerebro externo (nea-agent) lo necesita para activar el
  // modo farmacia y exponer las tools de catálogo.
  const orgRows = await db
    .select({ providerId: schema.organization.providerId })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);

  return Response.json({
    providerId: orgRows[0]?.providerId ?? null,
    contact: {
      id: contact.id,
      name: contact.name,
      waIdentity: contact.waIdentity,
      phone: contact.phone,
      ficha: serializeFicha(contact),
    },
    conversation: {
      id: conversation.id,
      // Una sola verdad para el bot: si hay handoff, la IA está apagada
      // aunque el flag siga en true.
      aiEnabled: conversation.aiEnabled && !conversation.handoffAt,
      handoffAt: conversation.handoffAt?.toISOString() ?? null,
      windowOpen: isWindowOpen(conversation.lastInboundAt),
      windowRemainingMs: windowRemainingMs(conversation.lastInboundAt),
    },
    lead: leadRows[0]
      ? { id: leadRows[0].lead.id, stageName: leadRows[0].stage.name }
      : null,
  });
}
