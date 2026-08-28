import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

export type EvolutionCredentials = {
  id: string;
  organizationId: string;
  instanceName: string;
  instanceToken: string;
  instanceId: string | null;
  jid: string | null;
  status: "connected" | "reconnect_required";
};

type Row = typeof schema.evolutionCredentials.$inferSelect;

function toCredentials(row: Row): EvolutionCredentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    instanceName: row.instanceName,
    instanceToken: decryptSecret({
      cipher: row.instanceTokenCipher,
      iv: row.instanceTokenIv,
      tag: row.instanceTokenTag,
    }),
    instanceId: row.instanceId,
    jid: row.jid,
    status: row.status,
  };
}

/** Hash sha256 del token (para comparar sin descifrar). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resuelve las credenciales de Evolution de una organización. */
export async function getEvolutionCredentialsByOrg(
  organizationId: string
): Promise<EvolutionCredentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.evolutionCredentials)
    .where(scoped(schema.evolutionCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Resuelve la organización por el hash del token de instancia (webhook). */
export async function getOrgByEvolutionTokenHash(
  tokenHash: string
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ organizationId: schema.evolutionCredentials.organizationId })
    .from(schema.evolutionCredentials)
    .where(eq(schema.evolutionCredentials.instanceTokenHash, tokenHash))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}

/** Guarda (o actualiza) las credenciales de Evolution de una organización. */
export async function saveEvolutionCredentials(input: {
  organizationId: string;
  instanceName: string;
  instanceToken: string;
  instanceId?: string | null;
  jid?: string | null;
}): Promise<void> {
  const db = getDb();
  const enc = encryptSecret(input.instanceToken);
  await db
    .insert(schema.evolutionCredentials)
    .values({
      id: newId("credentials"),
      organizationId: input.organizationId,
      instanceName: input.instanceName,
      instanceTokenHash: hashToken(input.instanceToken),
      instanceTokenCipher: enc.cipher,
      instanceTokenIv: enc.iv,
      instanceTokenTag: enc.tag,
      instanceId: input.instanceId ?? null,
      jid: input.jid ?? null,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: [schema.evolutionCredentials.organizationId],
      set: {
        instanceName: input.instanceName,
        instanceTokenHash: hashToken(input.instanceToken),
        instanceTokenCipher: enc.cipher,
        instanceTokenIv: enc.iv,
        instanceTokenTag: enc.tag,
        instanceId: input.instanceId ?? null,
        jid: input.jid ?? null,
        status: "connected",
        updatedAt: new Date(),
      },
    });
}

/** Marca la instancia como vencida (token inválido detectado en runtime). */
export async function markEvolutionReconnectRequired(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.evolutionCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(scoped(schema.evolutionCredentials.organizationId, organizationId));
}

/** Últimos 4 caracteres del token para mostrar en UI (jamás el token). */
export function tokenLast4(token: string): string {
  return token.slice(-4);
}
