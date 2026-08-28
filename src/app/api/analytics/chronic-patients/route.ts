import { withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Proxy a nea-agent: pacientes con condición crónica detectada.
 * GET /api/analytics/chronic-patients?consentidos=1
 */
export const GET = withAuth(async (session, req: Request) => {
  const env = getEnv();
  const url = new URL(`${env.NEA_AGENT_URL}/analytics/chronic-patients`);
  url.searchParams.set("provider_id", session.organizationId);
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
