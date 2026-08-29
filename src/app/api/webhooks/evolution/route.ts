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

/**
 * Extrae el número real (JID de usuario) del payload, si viene.
 */
function extractRealNumber(data: Record<string, unknown> | undefined): string | null {
  const candidates = [
    path(data, "Info", "SenderAlt"),
    path(data, "Info", "Sender"),
    path(data, "Info", "Chat"),
    path(data, "Sender"),
    path(data, "sender"),
    path(data, "key", "remoteJid"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c && jidType(c) === "user") {
      return (c.split("@")[0] ?? c).trim() || null;
    }
  }
  return null;
}

/**
 * Extrae el LID (identificador anónimo de privacidad de WhatsApp Business)
 * del payload, si viene. El LID y el número real son la MISMA persona: el
 * LID se guarda como waUserId para que getOrCreateContactByIdentity los
 * reconcilie en un solo contacto.
 */
function extractLid(data: Record<string, unknown> | undefined): string | null {
  const candidates = [
    path(data, "Info", "SenderAlt"),
    path(data, "Info", "Sender"),
    path(data, "Info", "Chat"),
    path(data, "Sender"),
    path(data, "sender"),
    path(data, "key", "remoteJid"),
  ];
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

/**
 * Extrae la imagen de un mensaje de Evolution GO, si viene.
 * Evolution envía la imagen en `message.imageMessage` con `url` (base64 o
 * URL) y `mimetype`. Devuelve { base64, mime, caption } o null.
 */
function extractImage(
  message: unknown
): { base64: string; mime: string; caption: string | null } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const image = m.imageMessage as Record<string, unknown> | undefined;
  if (!image) return null;
  // Evolution GO puede mandar la imagen ya decodificada en el campo raíz
  // `base64` (nivel superior del mensaje), o como URL en imageMessage.URL.
  // El campo raíz `base64` es preferible: la URL de imageMessage devuelve el
  // blob CIFRADO de WhatsApp (mediaKey), no la imagen decodificada.
  const rootBase64 = typeof m.base64 === "string" && m.base64 ? m.base64 : null;
  const url = (image.URL ?? image.url) as string | undefined;
  let base64: string | null = null;
  if (rootBase64) {
    base64 = rootBase64.startsWith("data:")
      ? rootBase64.slice(rootBase64.indexOf(",") + 1)
      : rootBase64;
  } else if (typeof url === "string" && url) {
    base64 = url.startsWith("data:") ? url.slice(url.indexOf(",") + 1) : url;
  }
  if (!base64) return null;
  const mime =
    typeof image.mimetype === "string" && image.mimetype
      ? image.mimetype
      : "image/jpeg";
  const caption = typeof image.caption === "string" ? image.caption : null;
  return { base64, mime, caption };
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
          .select({
            botPaused: schema.organization.botPaused,
            providerId: schema.organization.providerId,
          })
          .from(schema.organization)
          .where(eq(schema.organization.id, orgId))
          .limit(1);
        const botPaused = orgRows[0]?.botPaused ?? false;
        // Farmacia = org con catálogo (providerId). En farmacia, nea-agent es
        // el ÚNICO cerebro: TODOS los mensajes (texto e imagen) se delegan a
        // él, porque el pipeline interno del CRM no tiene el contexto de la
        // receta (last_options) que nea-agent generó. Sin esto, un texto de
        // seguimiento ("quiero 1 caja de 1,2,3...") iría al cerebro equivocado.
        const esFarmacia = Boolean(orgRows[0]?.providerId);

        // Construir identidad resiliente. El LID y el número real son la MISMA
        // persona: si viene el número real, se usa como identity/phone y el LID
        // como waUserId (getOrCreateContactByIdentity los reconcilia). Si solo
        // viene el LID, se usa bsuid:<LID> como identity (estable).
        const realNumber = extractRealNumber(data);
        const lid = extractLid(data);
        const profileName = path(data, "Info", "PushName");
        const profileNameStr =
          typeof profileName === "string" && profileName.trim() ? profileName.trim() : null;
        let identity: ResolvedIdentity;
        if (realNumber) {
          const phone = normalizeMx(realNumber);
          identity = {
            identity: phone,
            phone,
            waUserId: lid,
            profileName: profileNameStr,
          };
        } else if (lid) {
          identity = {
            identity: `bsuid:${lid}`,
            phone: null,
            waUserId: lid,
            profileName: profileNameStr,
          };
        } else {
          console.warn(`[evolution-webhook] sin identidad utilizable (sender=${sender})`);
          return;
        }

        console.log(
          `[evolution-webhook] ingest ${sender} msg=${messageId} text=${text ? JSON.stringify(text.slice(0, 60)) : "null"} paused=${botPaused}`
        );

        // Detectar imagen (receta/medicamento). Si viene, se delega a
        // nea-agent (que hace el OCR con visión y consulta el catálogo) en
        // vez de ingestar como texto plano (que no tiene la imagen).
        const rawMessage = path(data, "Message") ?? path(data, "message");
        const image = extractImage(rawMessage);
        if (image) {
          // Diagnóstico: magic number del base64 que se va a enviar a nea-agent.
          try {
            const buf = Buffer.from(image.base64, "base64");
            const magic = buf.subarray(0, 8).toString("hex");
            console.log(
              `[evolution-webhook] imagen detectada: base64Len=${image.base64.length} bytes=${buf.length} magic=${magic}`
            );
          } catch {
            console.log(`[evolution-webhook] imagen detectada: base64Len=${image.base64.length}`);
          }
        }
        if (!image && rawMessage) {
          // Debug: qué tiene el mensaje para entender por qué no se detectó
          const msgKeys = typeof rawMessage === "object" && rawMessage !== null
            ? Object.keys(rawMessage as Record<string, unknown>)
            : [];
          // Ver el contenido de imageMessage si existe
          const imgMsg = (rawMessage as Record<string, unknown>)?.imageMessage;
          let imgMsgDebug = "N/A";
          if (imgMsg && typeof imgMsg === "object") {
            const imgKeys = Object.keys(imgMsg as Record<string, unknown>);
            const imgUrl = (imgMsg as Record<string, unknown>)?.url;
            const imgMime = (imgMsg as Record<string, unknown>)?.mimetype;
            imgMsgDebug = `imageMessage(url=${typeof imgUrl}, mime=${imgMime}, keys=${imgKeys.join(",")})`;
          }
          console.warn(
            `[evolution-webhook] NO detectó imagen, keys=${msgKeys.join(",")}, ${imgMsgDebug}`
          );
        }
        if (image && !botPaused) {
          await delegateToNea({
            organizationId: orgId,
            identity,
            waMessageId: String(messageId),
            text: text ?? image.caption ?? "",
            imageBase64: image.base64,
            imageMime: image.mime,
            timestamp: extractTimestamp(data),
          });
          return;
        }

        // Farmacia: delegar TAMBIÉN los textos a nea-agent (es el único
        // cerebro con el contexto de la receta). El pipeline interno del CRM
        // no sabe resolver "quiero 1 caja de 1,2,3..." contra last_options.
        if (esFarmacia && !botPaused) {
          await delegateToNea({
            organizationId: orgId,
            identity,
            waMessageId: String(messageId),
            text: text ?? "",
            imageBase64: "",
            imageMime: "",
            timestamp: extractTimestamp(data),
          });
          return;
        }

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
 * Resuelve la organización de un instanceToken. Multi-tenant: busca el hash
 * del token en evolution_credentials (cada farmacia = una instancia). Si no
 * está, cae al token global del env (legacy).
 */
async function resolveOrgFromInstanceToken(
  instanceToken: string | undefined,
): Promise<string | null> {
  if (!instanceToken) return null;
  const { getOrgByEvolutionTokenHash } = await import("@/server/whatsapp/evolution-credentials");
  const orgId = await getOrgByEvolutionTokenHash(instanceToken);
  if (orgId) return orgId;
  // Legacy: token global del env.
  const env = getEnv();
  if (instanceToken === env.EVOLUTION_INSTANCE_TOKEN) {
    const { getDb, schema } = await import("@/lib/db");
    const db = getDb();
    const rows = await db.select({ id: schema.organization.id }).from(schema.organization).limit(1);
    return rows[0]?.id ?? null;
  }
  console.warn(
    `[evolution-webhook] instanceToken no coincide con ninguna instancia configurada`
  );
  return null;
}

/**
 * Delega una imagen (receta/medicamento) a nea-agent para que haga el OCR
 * con visión y consulte el catálogo. nea-agent responde vía /api/bot/messages
 * (el CRM envía por Evolution). El CRM solo ingesta el mensaje a la bandeja
 * para que quede en el hilo; la respuesta la genera nea-agent.
 */
async function delegateToNea(input: {
  organizationId: string;
  identity: ResolvedIdentity;
  waMessageId: string;
  text: string;
  imageBase64?: string;
  imageMime?: string;
  timestamp: string;
}): Promise<void> {
  const env = getEnv();
  const baseUrl = env.NEA_AGENT_URL;
  const apiKey = env.BOT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.warn("[evolution-webhook] nea-agent sin NEA_AGENT_URL/BOT_API_KEY — mensaje a bandeja");
    await ingestInboundMessage({
      organizationId: input.organizationId,
      identity: input.identity,
      waMessageId: input.waMessageId,
      type: "text",
      text: input.text,
      timestamp: input.timestamp,
      skipAgent: true,
    });
    return;
  }
  // Ingestar a la bandeja (para que el mensaje quede en el hilo) sin reenviar
  // al agente interno (nea-agent lo procesa).
  await ingestInboundMessage({
    organizationId: input.organizationId,
    identity: input.identity,
    waMessageId: input.waMessageId,
    type: "text",
    text: input.text,
    timestamp: input.timestamp,
    skipAgent: true,
  });
  // La imagen puede venir como base64 (data:...) o como URL http de Evolution.
  // Si es URL, descargarla con el header apikey y convertirla a base64.
  let imageBase64 = input.imageBase64 ?? "";
  if (imageBase64 && !imageBase64.startsWith("data:") && !/^[A-Za-z0-9+/=]+$/.test(imageBase64.slice(0, 100))) {
    try {
      const evoBase = env.EVOLUTION_BASE_URL?.replace(/\/$/, "");
      const token = await getInstanceToken(input.organizationId);
      if (evoBase && token) {
        const mediaRes = await fetch(imageBase64, {
          headers: { apikey: token },
          signal: AbortSignal.timeout(30000),
        });
        if (mediaRes.ok) {
          const buf = Buffer.from(await mediaRes.arrayBuffer());
          imageBase64 = buf.toString("base64");
          // Diagnóstico: magic number de la imagen descargada.
          const magic = buf.subarray(0, 16).toString("hex");
          const head = buf.subarray(0, 40).toString("utf8").replace(/[^\x20-\x7E]/g, ".");
          console.log(
            `[evolution-webhook] imagen descargada (${buf.length} bytes) magic=${magic} head="${head}"`
          );
        } else {
          console.warn(`[evolution-webhook] no se pudo descargar imagen: HTTP ${mediaRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[evolution-webhook] error descargando imagen: ${err}`);
    }
  }
  // Llamar a nea-agent /chat con la imagen base64 (modo producción: send=true,
  // nea-agent resuelve la conversación por identidad y envía la respuesta vía
  // /api/bot/messages → el CRM la manda por Evolution).
  try {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        text: input.text,
        waIdentity: input.identity.identity,
        waMessageId: input.waMessageId,
        imageBase64,
        imageMime: input.imageMime,
        send: true,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[evolution-webhook] nea-agent /chat devolvió ${res.status}`);
    }
  } catch (err) {
    console.warn(`[evolution-webhook] nea-agent /chat falló: ${err}`);
  }
}

/** Obtiene el token de instancia de Evolution de una organización (para descargar media). */
async function getInstanceToken(organizationId: string): Promise<string | null> {
  try {
    const { getEvolutionCredentialsByOrg } = await import(
      "@/server/whatsapp/evolution-credentials"
    );
    const creds = await getEvolutionCredentialsByOrg(organizationId);
    return creds?.instanceToken ?? null;
  } catch {
    return null;
  }
}
