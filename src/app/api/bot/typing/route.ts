import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { getEnv } from "@/lib/env";
import { evolutionRecipient } from "@/server/whatsapp/evolution";
import { getEvolutionCredentialsByOrg } from "@/server/whatsapp/evolution-credentials";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { graphRequest } from "@/lib/meta/client";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  // Estado opcional del indicador: "composing" (default) o "paused".
  // Nea lo usa para apagar explícitamente los puntitos justo cuando entrega
  // la respuesta final, evitando que el composing con delay (que Evolution
  // re-envía internamente) siga vivo y re-aparezca DESPUÉS de las opciones.
  state: z.enum(["composing", "recording", "paused"]).optional().default("composing"),
  // delay en ms para state="composing". Por defecto mantiene vivo el
  // indicador; Nea manda 0 (single-fire) en el último composing previo al
  // envío para no dejar un timer que re-avive los puntitos post-respuesta.
  delay: z.number().int().min(0).max(30000).optional(),
});

/**
 * Indicador "escribiendo…" (los 3 puntitos de WhatsApp) + marcar leído el
 * último inbound.
 * POST /api/bot/typing {conversationId}
 *
 * Best-effort por contrato: al bot JAMÁS le vale reintentar esto — si el
 * canal falla se responde 200 {ok:false} y la conversación sigue. El
 * indicador dura hasta ~25 s o hasta que llegue la respuesta real.
 *
 * Multi-canal:
 * - Evolution GO (canal real): POST /chat/sendPresence con composing=true al
 *   número del contacto, usando el token multi-tenant de la org.
 * - Meta Cloud API: status read + typing_indicator (canal Meta).
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const convs = await db
    .select()
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
  if (conv.isTest) {
    // Sandbox: jamás toca la API real (guardrail del Laboratorio).
    return Response.json({ ok: false, reason: "sandbox" });
  }
  if (!conv.aiEnabled || conv.handoffAt) {
    // Handoff/IA pausada: un humano atiende — "escribiendo…" aquí sería
    // mentirle al cliente. Se omite sin tocar el canal.
    return Response.json({ ok: false, reason: "ai_paused" });
  }

  // Resolver el número del destinatario (teléfono o identidad de WhatsApp).
  const ctRows = await db
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, conv.contactId))
    .limit(1);
  const contact = ctRows[0];
  const recipient = contact?.phone
    ? contact.phone
    : contact?.waUserId;
  if (!recipient) {
    return Response.json({ ok: false, reason: "no_recipient" });
  }

  const channel = getEnv().CHANNEL_PROVIDER;

  // ---- Canal Evolution GO: /message/presence (composing) ------------------
  if (channel === "evolution") {
    const creds = await getEvolutionCredentialsByOrg(organizationId);
    const base = getEnv().EVOLUTION_BASE_URL?.replace(/\/$/, "");
    if (!creds?.instanceToken || !base) {
      return apiError(409, "no_connection", "WhatsApp no está conectado");
    }
    try {
      // Este fork de Evolution (evolution-foundation/evolution-go) expone la
      // presencia en POST /message/presence con {number, state, delay} — NO en
      // /chat/sendPresence (404). El `delay` (ms) mantiene el indicador
      // "composing" vivo con re-envíos internos y luego manda "paused".
      const res = await fetch(`${base}/message/presence`, {
        method: "POST",
        headers: {
          apikey: creds.instanceToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          number: evolutionRecipient(recipient),
          state: body.data.state,
          isAudio: false,
          // delay solo aplica a "composing". Para "paused" Evolution lo ignora
          // (el struct lo marca solo cuando State es "composing").
          delay: body.data.delay ?? (body.data.state === "composing" ? 15000 : 0),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.warn(
          `[bot/typing] Evolution /message/presence devolvió ${res.status} (${await res.text().catch(() => "")})`
        );
        return Response.json({ ok: false, reason: "evolution_error" });
      }
      return Response.json({ ok: true });
    } catch {
      return Response.json({ ok: false, reason: "evolution_error" });
    }
  }

  // ---- Canal Meta Cloud API: read + typing_indicator ----------------------
  const msgs = await db
    .select({ waMessageId: schema.message.waMessageId })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.conversationId, conv.id),
        eq(schema.message.direction, "in"),
        isNotNull(schema.message.waMessageId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const wamid = msgs[0]?.waMessageId;
  if (!wamid) return Response.json({ ok: false, reason: "no_inbound" });

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    return apiError(409, "no_connection", "WhatsApp no está conectado");
  }

  try {
    await graphRequest(`${creds.phoneNumberId}/messages`, {
      method: "POST",
      token: creds.token,
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
        typing_indicator: { type: "text" },
      },
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, reason: "meta_error" });
  }
}
