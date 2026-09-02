import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Autenticación de la API de servicio `/api/bot/*`.
 *
 * Esta superficie NO la consume el navegador: la consume un cerebro externo
 * (un microservicio propio del operador, en su mismo servidor) que quiere
 * conducir la conversación sin que el token de WhatsApp salga del CRM.
 * Header `X-API-Key` contra `BOT_API_KEY` (env), comparación en tiempo
 * constante. Sin `BOT_API_KEY` configurada, toda la superficie responde 401.
 */

export function requireBotKey(req: Request): Response | null {
  const rl = checkRateLimit("bot-api", { windowMs: 60_000, max: 600 });
  if (!rl.allowed) return apiError(429, "rate_limited", "Demasiadas solicitudes");

  const expected = process.env.BOT_API_KEY;
  const provided = req.headers.get("x-api-key");
  if (!expected || expected.length < 16 || !provided) {
    return apiError(401, "unauthorized", "No autorizado");
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return apiError(401, "unauthorized", "No autorizado");
  }
  return null;
}

/**
 * Organización de la instancia. En un CRM self-hosted multi-tenant, la instancia
 * Evolution define la organización: cada instancia está ligada a exactamente una
 * organización vía evolution_credentials. Resolver por esa tabla es DETERMINISTA.
 *
 * El viejo `SELECT id FROM organization LIMIT 1` (sin ORDER BY) devolvía una org
 * casi arbitraria según el orden físico de las filas, y en la práctica agarraba la
 * org de prueba (provider 99) en vez de la del negocio real → el agente buscaba en
 * el catálogo equivocado ("No encontré ibutan" aunque existe en provider 05).
 */
let cachedOrgId: string | null = null;

export async function resolveInstanceOrg(): Promise<string | null> {
  if (cachedOrgId) return cachedOrgId;
  const db = getDb();
  // 1) Determino la org por la instancia Evolution conectada (la que recibe los
  //    mensajes de WhatsApp). Es la identidad real del tenant.
  const byInstance = await db
    .select({ organizationId: schema.evolutionCredentials.organizationId })
    .from(schema.evolutionCredentials)
    .where(eq(schema.evolutionCredentials.status, "connected"))
    .limit(1);
  if (byInstance[0]?.organizationId) {
    cachedOrgId = byInstance[0].organizationId;
    return cachedOrgId;
  }
  // 2) Respaldo: la primera org del negocio con catálogo (provider_id no nulo),
  //    nunca test sin provider.
  const fallback = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(sql`${schema.organization.providerId} is not null`)
    .orderBy(schema.organization.createdAt)
    .limit(1);
  cachedOrgId = fallback[0]?.id ?? null;
  return cachedOrgId;
}

/** Solo para tests. */
export function resetInstanceOrgCache(): void {
  cachedOrgId = null;
}
