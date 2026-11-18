/**
 * POST /api/bot/notify — mandar un texto a un teléfono EN NOMBRE DE UNA FARMACIA.
 *
 * POR QUÉ EXISTE
 *   Los recordatorios de dosis los dispara una Cloud Function programada (Cloud
 *   Tasks → n8n). Antes n8n enviaba por su cuenta con un nodo de Evolution y una
 *   credencial fija apuntando a la Evolution API v2, cuya única instancia
 *   (`Gentefarma`) llevaba tiempo en estado `connecting`: todo envío devolvía
 *   `500 Connection Closed` y ningún paciente recibía su recordatorio.
 *
 *   La otra salida era meter el token de cada instancia en el payload de la tarea
 *   (o duplicar credenciales en n8n, una por farmacia). Aquí el token NO sale del
 *   CRM: se reutiliza la misma resolución de credenciales multi-tenant que el
 *   resto de la bandeja (`getEvolutionCredentialsByOrg` dentro de `sendText`), así
 *   que el recordatorio sale del WhatsApp de la farmacia que atiende al paciente.
 *
 *   Efecto secundario buscado: el paciente queda con contacto y conversación en la
 *   bandeja, de modo que si responde al recordatorio entra al flujo normal (y el
 *   agente le puede contestar).
 *
 * Contrato:
 *   POST { providerId, phone, text, name? }
 *   → 200 { messageId, conversationId, phone }
 *   → 400 invalid_phone | invalid_body
 *   → 404 provider_not_found
 *   → 409 not_connected | reconnect_required | sandbox_violation | window_closed
 *   → 502 (resto de fallos del canal)
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey } from "@/server/bot/auth";
import { getOrCreateContactByIdentity } from "@/server/inbox/identity";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { SendError, sendText } from "@/server/inbox/send";
import { normalizarTelefonoVE } from "@/lib/telefono-ve";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  providerId: z.string().min(1),
  phone: z.string().min(6),
  text: z.string().min(1).max(4000),
  name: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const phone = normalizarTelefonoVE(body.data.phone);
  if (!phone) {
    return apiError(400, "invalid_phone", "El teléfono no es un número venezolano válido");
  }

  const db = getDb();
  const orgs = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.providerId, body.data.providerId))
    .limit(1);
  const org = orgs[0];
  if (!org) {
    return apiError(404, "provider_not_found", "No hay organización con ese providerId");
  }

  try {
    const { contact } = await getOrCreateContactByIdentity(org.id, {
      identity: phone,
      phone,
      waUserId: null,
      profileName: body.data.name ?? null,
    });
    const conversacion = await getOrCreateConversation(org.id, contact.id);
    const result = await sendText({
      conversationId: conversacion.id,
      organizationId: org.id,
      text: body.data.text,
      aiGenerated: false,
    });
    return Response.json({
      messageId: result.messageId,
      conversationId: conversacion.id,
      phone,
    });
  } catch (err) {
    if (err instanceof SendError) {
      if (
        err.code === "not_connected" ||
        err.code === "reconnect_required" ||
        err.code === "sandbox_violation" ||
        err.code === "window_closed"
      ) {
        return apiError(409, err.code, err.message);
      }
      return apiError(502, err.code, err.message);
    }
    console.error("[bot/notify] error:", err);
    return apiError(500, "internal", "No se pudo enviar el aviso");
  }
}
