import { withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Proxy a nea-agent: pacientes con condición crónica detectada.
 * GET /api/analytics/chronic-patients?consentidos=1
 */
export const GET = withAuth(async (session, req: Request) => {
  const env = getEnv();
  // nea-agent registra los perfiles con el providerId del catálogo Firebase
  // (multi-tenant: cada farmacia = un provider), NO con el id de la org del
  // CRM. Resolverlo de la organización, igual que /api/bot/context.
  const db = getDb();
  const orgRows = await db
    .select({ providerId: schema.organization.providerId })
    .from(schema.organization)
    .where(eq(schema.organization.id, session.organizationId))
    .limit(1);
  const providerId = orgRows[0]?.providerId ?? "";
  if (!providerId) {
    return Response.json({ provider_id: "", pacientes: [] }, { status: 200 });
  }

  const url = new URL(`${env.NEA_AGENT_URL}/analytics/chronic-patients`);
  url.searchParams.set("provider_id", providerId);
  const q = new URL(req.url).searchParams;
  const consentidos = q.get("consentidos");
  if (consentidos) url.searchParams.set("consentidos", consentidos);

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": env.BOT_API_KEY ?? "" },
  }).catch(() => null);
  if (!res) return Response.json({ error: "agente no disponible" }, { status: 502 });
  const data = await res.json().catch(() => null);
  return Response.json(data ?? { error: "respuesta inválida" }, { status: res.status });
});
