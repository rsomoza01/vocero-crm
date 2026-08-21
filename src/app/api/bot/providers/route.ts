import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import {
  getProviderInfo,
  isFirebaseConfigured,
} from "@/server/catalog/firebase";

export const dynamic = "force-dynamic";

/**
 * Info de la farmacia del tenant.
 * GET /api/bot/providers?providerId=<id>
 *
 * Auth: X-API-Key (BOT_API_KEY). providerId del query o de la org.
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  if (!isFirebaseConfigured()) {
    return apiError(503, "firebase_unavailable", "Firebase no está configurado");
  }

  const url = new URL(req.url);
  let providerId = url.searchParams.get("providerId") ?? undefined;
  if (!providerId) {
    const orgs = await getDb()
      .select({ providerId: schema.organization.providerId })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    providerId = orgs[0]?.providerId ?? undefined;
  }

  if (!providerId) {
    return apiError(422, "no_catalogo", "El tenant no tiene providerId configurado");
  }

  try {
    const provider = await getProviderInfo(providerId);
    if (!provider) {
      return apiError(404, "not_found", "Provider no encontrado");
    }
    return Response.json({ provider });
  } catch (err) {
    console.error("[bot/providers] error consultando Firebase:", err);
    return apiError(503, "firebase_unavailable", "No se pudo consultar el catálogo");
  }
}
