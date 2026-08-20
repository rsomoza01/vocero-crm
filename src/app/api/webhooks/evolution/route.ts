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
  // Campos comunes: sender, Sender, key.remoteJid, chat, etc.
  const sender = path(data, "sender") ?? path(data, "Sender") ?? path(data, "key", "remoteJid");
  if (typeof sender !== "string" || !sender) return null;
  // Evolution manda "584128840350@s.whatsapp.net" o "5215512345678@s.whatsapp.net"
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
        const sender = extractSender(data);
        if (!sender) return;
        const messageId =
          path(data, "key", "id") ??
          path(data, "id") ??
          path(data, "message", "key", "id") ??
          `evo-${Date.now()}`;
        const text = extractText(data.message);

        // Buscar la organización por instanceToken. En modo "evolution" no hay
        // tabla de credenciales de Meta; resolvemos por el token de instancia.
        const orgId = await resolveOrgFromInstanceToken(payload.instanceToken);
        if (!orgId) return;

        // Construir identidad resiliente a partir del número de WhatsApp.
        const phone = normalizeMx(sender);
        const identity: ResolvedIdentity = {
          identity: phone,
          phone,
          waUserId: null,
          profileName: null,
        };

        await ingestInboundMessage({
          organizationId: orgId,
          identity,
          waMessageId: String(messageId),
          type: "text",
          text,
          timestamp: String(data.messageTimestamp ?? Math.floor(Date.now() / 1000)),
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
