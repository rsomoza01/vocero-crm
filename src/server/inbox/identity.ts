import { and, eq, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { normalizeMx } from "@/lib/meta/client";
import type { WebhookMessage, WebhookValue } from "@/server/inbox/webhook";

/**
 * Identidad resiliente de contacto (003).
 *
 * Meta está migrando la identidad de WhatsApp de teléfono a Business-Scoped
 * User IDs (BSUID): `wa_id`/`from` pasan a ser opcionales y aparecen
 * `from_user_id` (mensaje) y `user_id` (contacts[]). Este módulo resuelve la
 * identidad del remitente sin asumir teléfono, y reconcilia para que un mismo
 * humano no genere dos contactos.
 */

export const BSUID_PREFIX = "bsuid:";

export type ResolvedIdentity = {
  /** Llave estable de resolución: teléfono normalizado o `bsuid:<id>`. */
  identity: string;
  phone: string | null;
  waUserId: string | null;
  profileName: string | null;
};

/**
 * Extrae la identidad utilizable de un mensaje del webhook.
 * Devuelve null si el mensaje no trae NINGUNA identidad (se descarta con log,
 * jamás se revienta el webhook).
 */
export function resolveIdentity(
  msg: WebhookMessage,
  contacts: WebhookValue["contacts"]
): ResolvedIdentity | null {
  const waUserId =
    msg.from_user_id ??
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.user_id ??
    contacts?.find((c) => c.user_id != null)?.user_id ??
    null;

  const profileName =
    contacts?.find((c) => c.wa_id != null && c.wa_id === msg.from)?.profile
      ?.name ??
    (waUserId
      ? contacts?.find((c) => c.user_id === waUserId)?.profile?.name
      : undefined) ??
    null;

  if (msg.from) {
    const phone = normalizeMx(msg.from);
    return { identity: phone, phone, waUserId, profileName };
  }
  if (waUserId) {
    return {
      identity: `${BSUID_PREFIX}${waUserId}`,
      phone: null,
      waUserId,
      profileName,
    };
  }
  return null;
}

/**
 * Resuelve o crea el contacto para una identidad, reconciliando:
 * - Si llegan teléfono Y BSUID, encuentra al contacto por cualquiera de los
 *   dos y adquiere la señal que le faltaba (el `wa_identity` NO cambia:
 *   es estable de por vida).
 * - Reactiva contactos archivados (el nombre editado por el operador se
 *   respeta).
 */
export async function getOrCreateContactByIdentity(
  organizationId: string,
  resolved: ResolvedIdentity
) {
  const db = getDb();

  const matchers = [eq(schema.contact.waIdentity, resolved.identity)];
  if (resolved.waUserId) {
    matchers.push(eq(schema.contact.waUserId, resolved.waUserId));
    matchers.push(
      eq(schema.contact.waIdentity, `${BSUID_PREFIX}${resolved.waUserId}`)
    );
  }
  if (resolved.phone) {
    matchers.push(eq(schema.contact.phone, resolved.phone));
  }

  const rows = await db
    .select()
    .from(schema.contact)
    .where(and(eq(schema.contact.organizationId, organizationId), or(...matchers)))
    .orderBy(schema.contact.createdAt)
    .limit(1);

  let existing = rows[0];

  // Reconciliación de LID sin número (003): cuando el mensaje llega SOLO con
  // un LID (sin número real) y el contacto que matchea por ese LID NO tiene
  // phone, pero existe OTRO contacto en la misma org con ese mismo wa_user_id
  // que SÍ tiene phone, usamos el contacto con phone. Esto evita que un mismo
  // humano quede partido en dos contactos (uno sin teléfono, invisible en la
  // bandeja) cuando Evolution alterna entre mandar el número y mandar solo el
  // LID. El contacto sin phone se fusiona en el que tiene número.
  if (
    existing &&
    !existing.phone &&
    resolved.waUserId &&
    !resolved.phone
  ) {
    const withPhone = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.waUserId, resolved.waUserId),
          sql`${schema.contact.phone} is not null`
        )
      )
      .orderBy(schema.contact.createdAt)
      .limit(1);
    if (withPhone[0]) {
      // Fusionar: mover conversaciones/leads del contacto sin phone al que
      // tiene número, y borrar el huérfano.
      await mergeContacts(organizationId, existing.id, withPhone[0].id);
      existing = withPhone[0];
    }
  }

  if (existing) {
    const patch: Partial<typeof schema.contact.$inferInsert> = {};
    if (resolved.waUserId && !existing.waUserId)
      patch.waUserId = resolved.waUserId;
    if (resolved.phone && !existing.phone) patch.phone = resolved.phone;
    if (existing.archivedAt) patch.archivedAt = null;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await db
        .update(schema.contact)
        .set(patch)
        .where(eq(schema.contact.id, existing.id));
      Object.assign(existing, patch);
    }
    return { contact: existing, isNew: false };
  }

  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      waIdentity: resolved.identity,
      phone: resolved.phone,
      waUserId: resolved.waUserId,
      name: resolved.profileName?.trim() || displayFallback(resolved),
    })
    .onConflictDoNothing({
      target: [schema.contact.organizationId, schema.contact.waIdentity],
    })
    .returning();
  if (inserted[0]) return { contact: inserted[0], isNew: true };

  // Carrera: otro request lo creó entre el SELECT y el INSERT.
  const raced = await db
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.waIdentity, resolved.identity)
      )
    )
    .limit(1);
  const contact = raced[0];
  if (!contact) throw new Error("contacto no encontrado tras upsert");
  return { contact, isNew: false };
}

/** Nombre de respaldo cuando no hay nombre de perfil: nunca el BSUID crudo. */
function displayFallback(resolved: ResolvedIdentity): string {
  if (resolved.phone) return resolved.phone;
  return "Contacto de WhatsApp";
}

/**
 * Fusiona un contacto huérfano (sin phone) dentro de otro que tiene número.
 * Mueve sus conversaciones y leads al contacto destino y borra el huérfano.
 * Se usa en la reconciliación de LID sin número (003).
 */
async function mergeContacts(
  organizationId: string,
  fromContactId: string,
  toContactId: string
): Promise<void> {
  if (fromContactId === toContactId) return;
  const db = getDb();

  // Mover conversaciones del huérfano al destino. Si el destino ya tiene una
  // conversación real, se reasignan los mensajes de la del huérfano a esa y
  // se borra la conversación huérfana (evita duplicar hilos).
  const orphanConvs = await db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.contactId, fromContactId)
      )
    );

  const destConv = await db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.contactId, toContactId),
        eq(schema.conversation.isTest, false)
      )
    )
    .limit(1);

  for (const conv of orphanConvs) {
    if (destConv[0]) {
      // Reasignar mensajes del hilo huérfano al hilo destino.
      await db
        .update(schema.message)
        .set({ conversationId: destConv[0].id })
        .where(eq(schema.message.conversationId, conv.id));
      // Recalcular contadores del destino con los mensajes movidos.
      const agg = await db
        .select({
          lastInboundAt: sql<Date>`max(${schema.message.waTimestamp})`,
          lastMessageAt: sql<Date>`max(${schema.message.waTimestamp})`,
          unread: sql<number>`count(*) filter (where ${schema.message.direction} = 'in' and ${schema.message.status} = 'delivered')`,
        })
        .from(schema.message)
        .where(eq(schema.message.conversationId, destConv[0].id));
      const a = agg[0] ?? {
        lastInboundAt: null,
        lastMessageAt: null,
        unread: 0,
      };
      await db
        .update(schema.conversation)
        .set({
          lastInboundAt: a.lastInboundAt ?? destConv[0].lastInboundAt,
          lastMessageAt: a.lastMessageAt ?? destConv[0].lastMessageAt,
          unreadCount: Number(a.unread ?? 0),
          updatedAt: new Date(),
        })
        .where(eq(schema.conversation.id, destConv[0].id));
      // Borrar el hilo huérfano (sus mensajes ya se movieron).
      await db
        .delete(schema.conversation)
        .where(eq(schema.conversation.id, conv.id));
    } else {
      // No hay hilo destino: reasignar el hilo huérfano al contacto destino.
      await db
        .update(schema.conversation)
        .set({ contactId: toContactId, updatedAt: new Date() })
        .where(eq(schema.conversation.id, conv.id));
    }
  }

  // Mover leads del huérfano al destino.
  await db
    .update(schema.lead)
    .set({ contactId: toContactId })
    .where(
      and(
        eq(schema.lead.organizationId, organizationId),
        eq(schema.lead.contactId, fromContactId)
      )
    );
  await db
    .update(schema.leadStageEvent)
    .set({ contactId: toContactId })
    .where(
      and(
        eq(schema.leadStageEvent.organizationId, organizationId),
        eq(schema.leadStageEvent.contactId, fromContactId)
      )
    );

  // Borrar el contacto huérfano (cascade limpia lo que quede).
  await db
    .delete(schema.contact)
    .where(eq(schema.contact.id, fromContactId));

  console.log(
    `[identity] contacto huérfano ${fromContactId} fusionado en ${toContactId} (LID sin número reconciliado)`
  );
}
