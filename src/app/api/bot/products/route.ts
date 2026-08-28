import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { searchProducts, getProviderInfo } from "@/server/catalog/firebase";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/products?q=...&providerId=...&limit=...
 * Busca medicamentos en el catálogo Firebase del provider (multi-tenant).
 * Autenticado con X-API-Key (el agente externo).
 */
export async function GET(req: Request) {
  const env = getEnv();
  if (!env.BOT_API_KEY) {
    return Response.json({ error: "bot_disabled" }, { status: 401 });
  }
  const key = req.headers.get("x-api-key");
  if (!key || key.length < 16 || !env.BOT_API_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const a = Buffer.from(env.BOT_API_KEY);
  const b = Buffer.from(key);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
  let providerId = url.searchParams.get("providerId") ?? "";

  // Si no viene providerId, resolver el de la organización de la instancia.
  if (!providerId) {
    const db = getDb();
    const rows = await db
      .select({ pid: schema.organization.providerId })
      .from(schema.organization)
      .limit(1);
    providerId = rows[0]?.pid ?? "";
  }

  if (!providerId) {
    return Response.json({ products: [], provider: null }, { status: 200 });
  }

  const [products, provider] = await Promise.all([
    searchProducts(providerId, q, limit),
    getProviderInfo(providerId),
  ]);

  return Response.json({
    provider: provider?.name ?? null,
    products,
  });
}
