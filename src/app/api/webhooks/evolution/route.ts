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
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { normalizeMx } from "@/lib/meta/client";
import { getDb, schema } from "@/lib/db";
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

/** Clasifica un JID: group / lid / user / unknown. */
function jidType(a: string): "group" | "lid" | "user" | "unknown" {
  if (!a) return "unknown";
  if (a.endsWith("@g.us")) return "group";
  if (a.endsWith("@lid")) return "lid";
  if (a.endsWith("@s.whatsapp.net") || /^\d{7,15}$/.test(a)) return "user";
  return "unknown";
}

/**
 * Resuelve el remitente REAL: prefiere el JID de usuario (@s.whatsapp.net /
 * SenderAlt) sobre el LID (@lid), y descarta grupos (@g.us) y desconocidos.
 * Devuelve el número (sin @suffix) o null.
 */
function resolveRealSender(data: Record<string, unknown> | undefined): string | null {
  const candidates = [
    path(data, "Info", "SenderAlt"),
    path(data, "Info", "Sender"),
    path(data, "Info", "Chat"),
    path(data, "Sender"),
    path(data, "sender"),
    path(data, "key", "remoteJid"),
  ];
  // Primero un JID de usuario real.
  for (const c of candidates) {
    if (typeof c === "string" && c && jidType(c) === "user") {
      return (c.split("@")[0] ?? c).trim() || null;
    }
  }
  // Luego un LID (cuenta Business sin número expuesto).
  for (const c of candidates) {
    if (typeof c === "string" && c && jidType(c) === "lid") {
      return (c.split("@")[0] ?? c).trim() || null;
    }
  }
  return null;
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

/** ¿El remitente es el dueño de la organización (puede pausar el agente)? */
async function isOrgOwner(orgId: string, phone: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ metadata: schema.organization.metadata })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  const org = rows[0];
  if (!org?.metadata) return false;
  try {
    const meta = JSON.parse(org.metadata) as { ownerPhone?: string };
    return meta.ownerPhone === phone;
  } catch {
    return false;
  }
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
        const sender = resolveRealSender(data);
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

        // Comando global AGENTE OFF/ON (solo el dueño).
        const upper = (text ?? "").trim().toUpperCase();
        if (upper === "AGENTE OFF" || upper === "AGENTE ON") {
          if (await isOrgOwner(orgId, sender)) {
            const pause = upper === "AGENTE OFF";
            const db = getDb();
            await db
              .update(schema.organization)
              .set({ botPaused: pause })
              .where(eq(schema.organization.id, orgId));
            const reply = pause
              ? "🤖⏸️ Agente pausado. El asistente deja de responder; los mensajes entran a la bandeja. Escribe AGENTE ON para reactivarlo."
              : "🤖✅ Agente activado. El asistente vuelve a atender los mensajes.";
            await sendText(orgId, sender, reply);
          } else {
            console.log(`[evolution-webhook] comando ${upper} de ${sender} ignorado (no es owner)`);
          }
          return;
        }

        // Pausa global: no reenviar al agente, solo ingestar a la bandeja.
        const db = getDb();
        const orgRows = await db
          .select({ botPaused: schema.organization.botPaused })
          .from(schema.organization)
          .where(eq(schema.organization.id, orgId))
          .limit(1);
        const botPaused = orgRows[0]?.botPaused ?? false;

        // Construir identidad resiliente a partir del número de WhatsApp.
        const phone = normalizeMx(sender);
        const profileName = path(data, "Info", "PushName");
        const identity: ResolvedIdentity = {
          identity: phone,
          phone,
          waUserId: null,
          profileName: typeof profileName === "string" && profileName.trim() ? profileName.trim() : null,
        };

        console.log(
          `[evolution-webhook] ingest ${sender} msg=${messageId} text=${text ? JSON.stringify(text.slice(0, 60)) : "null"} paused=${botPaused}`
        );

        await ingestInboundMessage({
          organizationId: orgId,
          identity,
          waMessageId: String(messageId),
          type: "text",
          text,
          timestamp: extractTimestamp(data),
          skipAgent: botPaused,
        });
        if (botPaused) {
          console.log(
            `[evolution-webhook] agente pausado globalmente (org=${orgId}) — mensaje NO reenviado a nea-agent`
          );
        }
      } catch (err) {
        console.error("[evolution-webhook] error procesando mensaje:", err);
      }
    });
  }

  return Response.json({ received: true });
}

/** Envía un texto vía el CRM (para confirmaciones del comando). */
async function sendText(orgId: string, to: string, text: string): Promise<void> {
  try {
    const { sendText } = await import("@/server/inbox/send");
    const db = getDb();
    const rows = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .innerJoin(schema.contact, eq(schema.conversation.contactId, schema.contact.id))
      .where(
        and(
          eq(schema.conversation.organizationId, orgId),
          eq(schema.contact.waIdentity, to)
        )
      )
      .limit(1);
    const convId = rows[0]?.id;
    if (!convId) return;
    await sendText({ conversationId: convId, organizationId: orgId, text });
  } catch (err) {
    console.error("[evolution-webhook] no se pudo enviar confirmación:", err);
  }
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
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  const rows = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
  return rows[0]?.id ?? null;
}
