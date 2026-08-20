/**
 * Webhook de entrada de Evolution GO/API.
 *
 * Evolution envía eventos a una URL configurada en la instancia. El payload
 * llega con la forma:
 *   {
 *     "event": "Message" | "Connected" | ...,
 *     "data": { "key": {...}, "message": {...}, "sender": "...", ... },
 *     "instanceToken": "...",
 *     "instanceId": "...",
 *     "instanceName": "..."
 *   }
 *
 * Este módulo traduce el evento `message` al modelo interno del CRM
 * (ingestInboundMessage) y responde 200 siempre.
 */
import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { normalizeMx } from "@/lib/meta/client";
import { ingestInboundMessage } from "@/server/inbox/ingest";
import type { ResolvedIdentity } from "@/server/inbox/identity";

export const dynamic = "force-dynamic";

type EvolutionWebhook = {
  event?: string;
  data?: Record<string, unknown>;
  instanceToken?: string;
  instanceId?: string;
};

/** Lee un valor anidado de forma tolerante. */
function path(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in cur) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return null;
    }
  }
  return cur;
}

/** Extrae el número (wa_id) del remitente desde el payload de Evolution. */
function extractSender(data: Record<string, unknown> | undefined): string | null {
  // whatsmeow serializa events.Message con estructura anidada:
  //   data.Info.Sender / data.Info.Chat  (JID: "584128009482@s.whatsapp.net")
  // Otras variantes: data.Sender, data.sender, data.key.remoteJid.
  const sender =
    path(data, "Info", "Sender") ??
    path(data, "Info", "Chat") ??
    path(data, "Sender") ??
    path(data, "sender") ??
    path(data, "key", "remoteJid");
  if (typeof sender !== "string" || !sender) return null;
  // "584128009482@s.whatsapp.net" o LID "278541530865777@lid"
  const number = (sender.split("@")[0] ?? sender).trim();
  return number || null;
}

/** Extrae el texto de un mensaje de WhatsApp (varios formatos). */
function extractText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (typeof m.conversation === "string" && m.conversation) return m.conversation;
  const extended = m.extendedTextMessage as Record<string, unknown> | undefined;
  if (extended && typeof extended.text === "string") return extended.text;
  const image = m.imageMessage as Record<string, unknown> | undefined;
  if (image && typeof image.caption === "string") return image.caption;
  const video = m.videoMessage as Record<string, unknown> | undefined;
  if (video && typeof video.caption === "string") return video.caption;
  return null;
}

/** Extrae el ID del mensaje. */
function extractMessageId(data: Record<string, unknown> | undefined): string | null {
  const id =
    path(data, "Info", "ID") ??
    path(data, "key", "id") ??
    path(data, "id") ??
    path(data, "message", "key", "id");
  return typeof id === "string" && id ? id : null;
}

/** Extrae el timestamp (segundos epoch) del mensaje. */
function extractTimestamp(data: Record<string, unknown> | undefined): string {
  const ts = path(data, "Info", "Timestamp") ?? path(data, "messageTimestamp");
  if (typeof ts === "number" && ts > 0) return String(ts);
  return String(Math.floor(Date.now() / 1000));
}

export async function POST(req: Request) {
  const env = getEnv();
  if (env.CHANNEL_PROVIDER !== "evolution") {
    return new Response(null, { status: 404 });
  }

  let payload: EvolutionWebhook;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ received: true });
  }

  const eventName = String(payload.event ?? "").toLowerCase();
  const data = payload.data ?? {};

  if (eventName === "message") {
    after(async () => {
      try {
        // whatsmeow serializa events.Message con: data.Info (MessageInfo),
        // data.Message (el contenido waE2E.Message), data.MessageTimestamp.
        const sender = extractSender(data);
        if (!sender) {
          console.warn(
            `[evolution-webhook] sin remitente en el payload (event=${eventName}), data keys: ${Object.keys(data).join(",")}`
          );
          return;
        }
        const messageId = extractMessageId(data) ?? `evo-${Date.now()}`;
        const text = extractText(path(data, "Message") ?? path(data, "message"));

        // Buscar la organización por instanceToken.
        const orgId = await resolveOrgFromInstanceToken(payload.instanceToken);
        if (!orgId) {
          console.warn(
            `[evolution-webhook] no se pudo resolver la organización (instanceToken=${payload.instanceToken})`
          );
          return;
        }

        // Construir identidad resiliente a partir del número de WhatsApp.
        const phone = normalizeMx(sender);
        const identity: ResolvedIdentity = {
          identity: phone,
          phone,
          waUserId: null,
          profileName: null,
        };

        console.log(
          `[evolution-webhook] ingest ${sender} msg=${messageId} text=${text ? JSON.stringify(text.slice(0, 60)) : "null"}`
        );

        await ingestInboundMessage({
          organizationId: orgId,
          identity,
          waMessageId: String(messageId),
          type: "text",
          text,
          timestamp: extractTimestamp(data),
        });
      } catch (err) {
        console.error("[evolution-webhook] error procesando mensaje:", err);
      }
    });
  }

  return Response.json({ received: true });
}

/**
 * Resuelve la organización de un instanceToken. En el modo Evolution usamos
 * el token de instancia global; si no coincide, devolvemos null.
 */
async function resolveOrgFromInstanceToken(
  instanceToken: string | undefined,
): Promise<string | null> {
  const env = getEnv();
  if (!instanceToken) return null;
  if (instanceToken !== env.EVOLUTION_INSTANCE_TOKEN) {
    console.warn(
      `[evolution-webhook] instanceToken no coincide con EVOLUTION_INSTANCE_TOKEN`
    );
    return null;
  }
  // En este CRM de una sola organización, la org se resuelve del tenant actual.
  // Usamos la primera organización de la BD.
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  const rows = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return rows[0]?.id ?? null;
}
