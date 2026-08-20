import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import { getContactById } from "@/server/contacts";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { sendText, SendError } from "@/server/inbox/send";
import { isWindowOpen } from "@/server/inbox/window";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("kind", [
  // Canal Meta: plantilla aprobada obligatoria para iniciar.
  z.object({
    kind: z.literal("template"),
    templateId: z.string().min(1),
    variables: z.array(z.string().trim().max(500)).max(10).optional(),
  }),
  // Canal Evolution: texto libre (WhatsApp Web no restringe).
  z.object({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(4096),
  }),
]);

/**
 * Abre la conversación con un contacto que NUNCA ha escrito (capturado
 * a mano). En el canal Meta solo se puede iniciar con plantilla aprobada;
 * en el canal Evolution (WhatsApp Web) se envía texto libre directamente.
 *
 * La conversación se crea AQUÍ y no al capturar el contacto: un hilo vacío
 * ensuciaría la Bandeja y rompería su orden por último mensaje.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  if (!contact.phone && !contact.waIdentity) {
    return apiError(422, "no_identity", "Este contacto no tiene a dónde escribir");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const channel = getEnv().CHANNEL_PROVIDER;

  const db = getDb();
  const existing = await db
    .select({ id: schema.conversation.id, lastInboundAt: schema.conversation.lastInboundAt })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        session.organizationId,
        eq(schema.conversation.contactId, id),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);

  // Gastar una plantilla teniendo la ventana abierta es tirar dinero y
  // reputación de plantilla (solo aplica al canal Meta).
  if (
    channel !== "evolution" &&
    existing[0] &&
    isWindowOpen(existing[0].lastInboundAt)
  ) {
    return apiError(
      409,
      "window_open",
      "Esta persona te escribió hace menos de 24 h: puedes responderle directo desde la Bandeja, sin plantilla"
    );
  }

  const conversation =
    existing[0] ?? (await getOrCreateConversation(session.organizationId, id));

  try {
    if (body.data.kind === "text") {
      const result = await sendText({
        conversationId: conversation.id,
        organizationId: session.organizationId,
        text: body.data.text,
      });
      return Response.json({
        messageId: result.messageId,
        conversationId: conversation.id,
      });
    }
    const result = await sendTemplate({
      organizationId: session.organizationId,
      conversationId: conversation.id,
      templateId: body.data.templateId,
      variables: body.data.variables,
    });
    return Response.json({
      messageId: result.messageId,
      conversationId: conversation.id,
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(409, err.code, err.message);
    }
    throw err;
  }
});
