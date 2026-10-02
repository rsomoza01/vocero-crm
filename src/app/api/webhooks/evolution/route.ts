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
import { and, eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { normalizeMx } from "@/lib/meta/client";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import {
  getOrCreateConversation,
  ingestInboundMessage,
  serializeMessage,
  type MediaInput,
} from "@/server/inbox/ingest";
import {
  getOrCreateContactByIdentity,
  type ResolvedIdentity,
} from "@/server/inbox/identity";

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

/**
 * ¿Es un mensaje de ESTADO / BROADCAST (la franja de "Mi estado" de WhatsApp)?
 * Cuando el DUEÑO publica un estado, Evolution manda `Info.Chat = "status@broadcast"`.
 * NUNCA debe generar un contacto ni ingestar a la bandeja: no es un cliente ni
 * una conversación real. Detectar el sufijo `@broadcast` en cualquiera de los
 * campos JID relevantes del payload.
 */
function isBroadcast(data: Record<string, unknown> | undefined): boolean {
  const candidates = [
    path(data, "Info", "Chat"),
    path(data, "Info", "Sender"),
    path(data, "Info", "SenderAlt"),
    path(data, "key", "remoteJid"),
    path(data, "sender"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.toLowerCase().endsWith("@broadcast")) {
      return true;
    }
  }
  return false;
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
 * ¿Es un ECHO (mensaje que el DUEÑO envió a mano desde su WhatsApp)?
 * Evolution marca los mensajes salientes del dueño con `key.fromMe === true`.
 * En ese caso el remitente detectado es el LID del dueño, pero el DESTINATARIO
 * real está en `key.remoteJid`. Sin esto, la respuesta del dueño se ingesta
 * como un mensaje entrante de un contacto fantasma (sin teléfono, invisible en
 * la bandeja) en vez de como saliente en la conversación del cliente.
 */
function isEcho(data: Record<string, unknown> | undefined): boolean {
  const fromMe = path(data, "key", "fromMe");
  if (fromMe === true) return true;
  // evolution-go serializa *events.Message de whatsmeow: el flag de "mensaje
  // saliente del dueño" vive en Info.IsFromMe (no en key.fromMe). Además el
  // destinatario real del echo (el cliente) es Info.Chat, distinto del
  // remitente detectado (el LID del dueño).
  const infoFromMe = path(data, "Info", "IsFromMe");
  if (infoFromMe === true) return true;
  // Fallback: el remitente detectado es el LID del dueño y el payload trae un
  // destinatario distinto en key.remoteJid (formato classic) o Info.Chat
  // (formato evolution-go).
  const remoteJid =
    path(data, "key", "remoteJid") ?? path(data, "Info", "Chat");
  const sender = resolveRealSender(data);
  if (typeof remoteJid === "string" && remoteJid && sender) {
    const remoteNum = (remoteJid.split("@")[0] ?? "").trim();
    if (remoteNum && remoteNum !== sender) return true;
  }
  return false;
}

/** Extrae el DESTINATARIO real de un echo (el cliente al que el dueño respondió). */
function extractEchoRecipient(data: Record<string, unknown> | undefined): string | null {
  // evolution-go: Info.Chat es el destinatario real (el cliente al que el
  // dueño respondió), mientras que el remitente detectado es el LID del dueño.
  const remoteJid =
    path(data, "key", "remoteJid") ?? path(data, "Info", "Chat");
  if (typeof remoteJid === "string" && remoteJid) {
    const num = (remoteJid.split("@")[0] ?? "").trim();
    if (num) return num;
  }
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

/**
 * Extrae el AUDIO de un mensaje de Evolution GO, si viene (nota de voz).
 * Igual que extractImage: el campo raíz `base64` (decodificado) o la URL de
 * `audioMessage.URL`. Devuelve { base64, mime } o null.
 */
function extractAudio(
  message: unknown
): { base64: string; mime: string } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const audio = m.audioMessage as Record<string, unknown> | undefined;
  if (!audio) return null;
  const rootBase64 = typeof m.base64 === "string" && m.base64 ? m.base64 : null;
  const url = (audio.URL ?? audio.url) as string | undefined;
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
    typeof audio.mimetype === "string" && audio.mimetype
      ? audio.mimetype
      : "audio/ogg";
  return { base64, mime };
}

/** ¿El evento `message` trae contenido REAL (texto o algún tipo de adjunto)? */
function hasRealContent(
  message: unknown,
  text: string | null
): boolean {
  if (typeof text === "string" && text.trim()) return true;
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  // Tipos de mensaje de WhatsApp que SÍ representan contenido del cliente.
  for (const key of [
    "imageMessage",
    "audioMessage",
    "videoMessage",
    "documentMessage",
    "stickerMessage",
    "contactMessage",
    "locationMessage",
    "liveLocationMessage",
    "documentWithCaptionMessage",
    "listMessage",
    "buttonsMessage",
    "templateMessage",
    "pollCreationMessage",
  ]) {
    if (m[key]) return true;
  }
  return false;
}

/**
 * Extrae el ID del mensaje. */
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

        // Guard anti-ruido: los eventos `message` SIN contenido real (presencia
        // de tipeo/lectura, reacciones, heartbeats de Evolution GO o mensajes
        // vacíos) llegan como event:"message" y antes se ingerían como texto
        // vacío (in/operator con text="") y disparaban una respuesta AI
        // inventada por cada uno. Se descartan para no contaminar la bandeja ni
        // generar respuestas falsas. Un mensaje legítimo siempre tiene texto o
        // un adjunto (imagen/audio/video/doc/sticker...).
        const rawMsgEarly = path(data, "Message") ?? path(data, "message");
        if (!hasRealContent(rawMsgEarly, text)) {
          console.log(
            `[evolution-webhook] evento message sin contenido real descartado (sender=${sender}, msg=${messageId})`
          );
          return;
        }

        // Buscar la organización por instanceToken.
        const orgId = await resolveOrgFromInstanceToken(payload.instanceToken);
        if (!orgId) {
          console.warn(
            `[evolution-webhook] no se pudo resolver la organización (instanceToken=${payload.instanceToken})`
          );
          return;
        }

        // ESTADO / BROADCAST ("Mi estado" de WhatsApp): el dueño publicó un
        // estado (Info.Chat = "status@broadcast"). NO es un cliente ni una
        // conversación: descartarlo ANTES de crear contacto/conversación. Sin
        // esto se creaba un contacto fantasma "status" (phone/wa_identity =
        // "status") en la bandeja acumulando todos los estados del negocio.
        if (isBroadcast(data)) {
          const bj = String(path(data, "Info", "Chat") ?? path(data, "key", "remoteJid") ?? "?");
          console.log(
            `[evolution-webhook] estado/broadcast del dueño descartado (${bj}) msg=${messageId}`
          );
          return;
        }

        // ECHO: mensaje que el DUEÑO envió a mano desde su WhatsApp. Se registra
        // como SALIENTE en la conversación del DESTINATARIO (el cliente), no como
        // entrante de un contacto fantasma (el LID del dueño, sin teléfono,
        // invisible en la bandeja). Sin esto, la respuesta del dueño se pierde.
        if (isEcho(data)) {
          const recipient = extractEchoRecipient(data);
          if (!recipient) {
            console.warn(
              `[evolution-webhook] echo sin destinatario (key.remoteJid) — descartado`
            );
            return;
          }
          console.log(
            `[evolution-webhook] echo del dueño → ${recipient} msg=${messageId} text=${text ? JSON.stringify(text.slice(0, 60)) : "null"}`
          );
          await ingestManualEcho({
            organizationId: orgId,
            recipient,
            waMessageId: messageId,
            text,
            timestamp: extractTimestamp(data),
          });
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

        // Audio (nota de voz): delegar a nea-agent para que lo transcriba
        // (Groq) y lo procese como consulta. Evolution lo manda en el campo
        // raíz base64 / audioMessage.
        const audio = extractAudio(rawMessage);
        if (audio && !botPaused) {
          console.log(
            `[evolution-webhook] audio detectado: base64Len=${audio.base64.length} mime=${audio.mime}`
          );
          await delegateToNea({
            organizationId: orgId,
            identity,
            waMessageId: String(messageId),
            text: text ?? "",
            audioBase64: audio.base64,
            audioMime: audio.mime,
            timestamp: extractTimestamp(data),
          });
          return;
        }

        // Farmacia: delegar TAMBIÉN los textos a nea-agent (es el único
        // cerebro con el contexto de la receta). El pipeline interno del CRM
        // no sabe resolver "quiero 1 caja de 1,2,3..." contra last_options.
        // OJO: DEBE respetar el toggle "IA" de la Bandeja (aiEnabled) y los
        // handoffs. Antes delegaba sin verificar la conversación: si un humano
        // apagaba la IA o la IA pausaba (p.ej. medicamento_no_disponible),
        // nea-agent seguía respondiendo solo. Con este guard, si la IA está
        // off en la conversación o hay handoff activo, NO se delega: el mensaje
        // cae al pipeline/bandeja para el humano.
        const { contact: convContact } = await getOrCreateContactByIdentity(
          orgId,
          identity
        );
        const farmConv = await db
          .select({
            aiEnabled: schema.conversation.aiEnabled,
            handoffAt: schema.conversation.handoffAt,
          })
          .from(schema.conversation)
          .where(
            and(
              eq(schema.conversation.organizationId, orgId),
              eq(schema.conversation.contactId, convContact.id)
            )
          )
          .limit(1);
        const convAiOff =
          farmConv[0] && (farmConv[0].aiEnabled === false || farmConv[0].handoffAt !== null);
        if (esFarmacia && !botPaused && !convAiOff) {
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
          skipAgent: botPaused || convAiOff,
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
  const {
    getOrgByEvolutionTokenHash,
    hashToken,
  } = await import("@/server/whatsapp/evolution-credentials");
  // El hash del token (sha256) es lo que se guarda en evolution_credentials
  // (instance_token_hash). getOrgByEvolutionTokenHash compara en igualdad, así
  // que hay que hashear el instanceToken del payload ANTES de buscarlo; sin
  // esto la comparación jamás encaja con la instancia correcta (multi-tenant),
  // el webhook caía al fallback legacy y enrutaba al azar a otra organización.
  const orgId = await getOrgByEvolutionTokenHash(hashToken(instanceToken));
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
 * Registra un ECHO (mensaje que el DUEÑO envió a mano desde su WhatsApp) como
 * SALIENTE en la conversación del DESTINATARIO (el cliente). Sin esto, la
 * respuesta del dueño se ingesta como un mensaje entrante de un contacto
 * fantasma (el LID del dueño, sin teléfono, invisible en la bandeja) en vez de
 * como saliente en el hilo del cliente. Idempotente por wa_message_id.
 */
async function ingestManualEcho(input: {
  organizationId: string;
  recipient: string; // número del cliente (destinatario)
  waMessageId: string;
  text: string | null;
  timestamp: string;
}): Promise<void> {
  const db = getDb();
  const rawRecipient = input.recipient;
  // El destinatario del echo puede ser un NÚMERO real (584146141685) o un LID
  // de cuenta Business (150289596285032, sin número expuesto). Si es un LID,
  // NO tratarlo como teléfono: buscar el contacto existente por wa_user_id
  // (que ya quedó ligado al número real cuando el cliente escribió). Tratar el
  // LID como phone crea un contacto duplicado fantasma (phone=LID) que aparece
  // como entrada separada en la Bandeja.
  const esLid = /^\d{10,20}$/.test(rawRecipient) && !/^5\d{10}$/.test(rawRecipient) && rawRecipient.length > 12;
  const phone = esLid ? null : normalizeMx(rawRecipient);

  const { contact } = await getOrCreateContactByIdentity(input.organizationId, {
    identity: esLid ? `bsuid:${rawRecipient}` : phone!,
    phone,
    waUserId: esLid ? rawRecipient : null,
    profileName: null,
  });
  const conversation = await getOrCreateConversation(input.organizationId, contact.id);

  const waTimestamp = toDate(input.timestamp);

  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: conversation.id,
      waMessageId: input.waMessageId,
      direction: "out",
      type: "text",
      text: input.text,
      status: "sent",
      origin: "manual",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return; // duplicado

  // Solo lastMessageAt: un mensaje del negocio NUNCA abre la ventana de 24 h.
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: waTimestamp, updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));

  // Pausa automática de la IA, idempotente y atómica (solo si no hay handoff).
  const paused = await db
    .update(schema.conversation)
    .set({
      aiEnabled: false,
      handoffAt: new Date(),
      handoffReason: "manual_reply",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.conversation.id, conversation.id),
        sql`${schema.conversation.handoffAt} is null`
      )
    )
    .returning();
  if (paused[0]) {
    console.log(
      `[evolution-webhook] respuesta manual del dueño en ${conversation.id} — IA pausada (manual_reply)`
    );
  }

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: conversation.id,
      message: serializeMessage(message, null),
    },
  });
  publish(input.organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });
}

/** Convierte un timestamp epoch (segundos) a Date. */
function toDate(timestamp: string): Date {
  const n = Number(timestamp);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  return new Date();
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
  audioBase64?: string;
  audioMime?: string;
  timestamp: string;
}): Promise<void> {
  const env = getEnv();
  const baseUrl = env.NEA_AGENT_URL;
  const apiKey = env.BOT_API_KEY;

  // La imagen puede venir como base64 (data:...) o como URL http de Evolution.
  // Si es URL, descargarla con el header apikey y convertirla a base64.
  // Se normaliza ANTES de persistir el adjunto: si llega como URL, el binario
  // no está disponible hasta aquí.
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
  // Igual para el audio: si viene como URL http de Evolution, descargarlo y
  // convertirlo a base64 (los mensajes nuevos de evolución los recibe ya en
  // el campo raíz base64, pero defendemos el caso URL).
  let audioBase64 = input.audioBase64 ?? "";
  if (audioBase64 && !audioBase64.startsWith("data:") && !/^[A-Za-z0-9+/=]+$/.test(audioBase64.slice(0, 100))) {
    try {
      const evoBase = env.EVOLUTION_BASE_URL?.replace(/\/$/, "");
      const token = await getInstanceToken(input.organizationId);
      if (evoBase && token) {
        const mediaRes = await fetch(audioBase64, {
          headers: { apikey: token },
          signal: AbortSignal.timeout(30000),
        });
        if (mediaRes.ok) {
          const buf = Buffer.from(await mediaRes.arrayBuffer());
          audioBase64 = buf.toString("base64");
          console.log(`[evolution-webhook] audio descargado (${buf.length} bytes)`);
        } else {
          console.warn(`[evolution-webhook] no se pudo descargar audio: HTTP ${mediaRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[evolution-webhook] error descargando audio: ${err}`);
    }
  }
  // Persistir el adjunto y ingestarlo a la Bandeja ANTES de llamar a nea-agent.
  // La Bandeja previsualiza desde `/api/media/{assetId}` y la ingesta solo crea
  // el `media_asset` si recibe `media`. Antes esta rama ingestaba SIEMPRE
  // `type:"text"` sin media, así que las imágenes/audios de TODOS los tenants de
  // Evolution GO no se veían en la Bandeja aunque el agente sí las procesara.
  // El binario llega ya decodificado por Evolution (campo raíz `base64`) o se
  // descargó arriba: no se toca Graph/Meta.
  const attachment = await persistInboundAttachment({
    organizationId: input.organizationId,
    waMessageId: input.waMessageId,
    imageBase64,
    imageMime: input.imageMime,
    audioBase64,
    audioMime: input.audioMime,
  });
  await ingestInboundMessage({
    organizationId: input.organizationId,
    identity: input.identity,
    waMessageId: input.waMessageId,
    type: attachment?.type ?? "text",
    text: input.text,
    timestamp: input.timestamp,
    media: attachment?.media ?? null,
    skipAgent: true,
  });
  if (!baseUrl || !apiKey) {
    console.warn("[evolution-webhook] nea-agent sin NEA_AGENT_URL/BOT_API_KEY — mensaje a bandeja");
    return;
  }
  // Llamar a nea-agent /chat con la imagen base64 (modo producción: send=true,
  // nea-agent resuelve la conversación por identidad y envía la respuesta vía
  // /api/bot/messages → el CRM la manda por Evolution).
  //
  // MULTI-TENANT: se le pasa el conversationId de la ORGANIZACIÓN correcta
  // (la que llegó por instanceToken en el webhook). Sin él, nea-agent resuelve
  // el contexto por waIdentity, que es AMBIGUO cuando el mismo número existe en
  // varias farmacias (p.ej. Roberto 584128009482 en Gentefarma y FarmaTocToc):
  // agarraría la primera org y la respuesta saldría por la instancia equivocada.
  // nea-agent ya usa conversationId como hint preferente (conv_id_hint en run_turn).
  let conversationId: string | null = null;
  try {
    const { contact: c } = await getOrCreateContactByIdentity(
      input.organizationId,
      input.identity
    );
    const conv = await getOrCreateConversation(input.organizationId, c.id);
    conversationId = conv.id;
  } catch (err) {
    console.warn(`[evolution-webhook] no se pudo resolver conversationId para nea-agent: ${err}`);
  }

  try {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        text: input.text,
        waIdentity: input.identity.identity,
        waMessageId: input.waMessageId,
        conversationId,
        imageBase64,
        imageMime: input.imageMime,
        audioBase64,
        audioMime: input.audioMime,
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

/**
 * Persiste el adjunto entrante en el volumen y devuelve el `media` que la
 * ingesta necesita para crear el `media_asset`.
 *
 * Por qué existe: la rama de farmacia (Evolution GO) delegaba a nea-agent
 * ingestando SIEMPRE `type:"text"` y sin `media`, así que la Bandeja mostraba
 * el mensaje como texto vacío y el adjunto no existía en `media_asset` — la UI
 * solo previsualiza desde `/api/media/{assetId}` (message-thread.tsx). El
 * binario YA viene decodificado por Evolution (campo raíz `base64`), por lo que
 * no se toca Graph/Meta: se escribe directo con `saveMediaFile`.
 *
 * Devuelve null cuando no hay adjunto (texto puro) — la ingesta sigue igual.
 */
async function persistInboundAttachment(input: {
  organizationId: string;
  waMessageId: string;
  imageBase64?: string;
  imageMime?: string;
  audioBase64?: string;
  audioMime?: string;
}): Promise<{ type: string; media: MediaInput } | null> {
  const imageB64 = (input.imageBase64 ?? "").trim();
  const audioB64 = (input.audioBase64 ?? "").trim();
  if (!imageB64 && !audioB64) return null;

  const isImage = Boolean(imageB64);
  const raw = isImage ? imageB64 : audioB64;
  // Acepta data:URI o base64 puro; una URL http NO es base64 (se descarta:
  // el binario real ya viene en el campo raíz `base64` de Evolution).
  const b64 = raw.startsWith("data:")
    ? raw.slice(raw.indexOf(",") + 1)
    : raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 200))) {
    console.warn("[evolution-webhook] adjunto no es base64 — no se persiste en la Bandeja");
    return null;
  }

  let data: Buffer;
  try {
    data = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (!data.length) return null;

  const kind = isImage ? "image" : "audio";
  const mime = isImage
    ? (input.imageMime || "image/jpeg")
    : (input.audioMime || "audio/ogg");

  try {
    const { newId } = await import("@/lib/db/ids");
    const assetId = newId("mediaAsset");
    const { saveMediaFile } = await import("@/server/whatsapp/media");
    // El archivo se guarda con el MISMO id que la fila de media_asset: la ruta
    // /api/media/{assetId} hace readMediaFile(org, assetId) y busca exactamente
    // ese segmento en el volumen. Guardarlo con otro id deja la fila apuntando a
    // un archivo inexistente (410 al previsualizar).
    await saveMediaFile(input.organizationId, assetId, data);
    console.log(
      `[evolution-webhook] adjunto persistido en la Bandeja: ${kind} ${data.length} bytes asset=${assetId}`
    );
    return {
      type: kind,
      // fetchStatus "available" + storagePath ya escrito: la ruta
      // /api/media/{assetId} sirve el archivo del volumen sin tocar Graph;
      // ensureAssetAvailable sale temprano porque el status es available.
      media: {
        kind,
        waMediaId: input.waMessageId,
        mimeType: mime,
        fileName: null,
        caption: null,
        payload: null,
        fetchStatus: "available",
        storagePath: `${input.organizationId}/${assetId}`,
        assetId,
        fileSize: data.length,
      },
    };
  } catch (err) {
    console.warn(`[evolution-webhook] no se pudo persistir el adjunto: ${err}`);
    return null;
  }
}
