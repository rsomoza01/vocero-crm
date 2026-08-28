import { withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Proxy a nea-agent: top de medicamentos consultados (Analítica).
 * GET /api/analytics/top-meds?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&top=N
 */
export const GET = withAuth(async (session, req: Request) => {
  const env = getEnv();
  const url = new URL(`${env.NEA_AGENT_URL}/analytics/top-meds`);
  url.searchParams.set("provider_id", session.organizationId);
  const q = new URL(req.url).searchParams;
  const desde = q.get("desde");
  const hasta = q.get("hasta");
  const top = q.get("top");
  if (desde) url.searchParams.set("desde", desde);
  if (hasta) url.searchParams.set("hasta", hasta);
  if (top) url.searchParams.set("top", top);

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": env.BOT_API_KEY ?? "" },
  }).catch(() => null);
  if (!res) return Response.json({ error: "agente no disponible" }, { status: 502 });
  const data = await res.json().catch(() => null);
  return Response.json(data ?? { error: "respuesta inválida" }, { status: res.status });
});
