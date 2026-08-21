import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import {
  getProductsByProvider,
  getProviderInfo,
  isFirebaseConfigured,
  type CatalogProduct,
} from "@/server/catalog/firebase";

export const dynamic = "force-dynamic";

/**
 * Consulta el catálogo de medicamentos de un tenant.
 * GET /api/bot/products?q=<nombre>&providerId=<id>&limit=<n>
 *
 * Soporta multi-consulta para recetas: q puede venir repetido (q=a&q=b) o
 * separado por comas. Devuelve `products` (los encontrados) y `missing` (los
 * que no están en el catálogo) para que el agente sea honesto.
 *
 * Auth: X-API-Key (BOT_API_KEY). providerId se toma del query o de la org.
 * SOLO lectura de Firebase (Constitución I). Aislamiento por providerId (III).
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
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw && Number(limitRaw) > 0 ? Number(limitRaw) : 10;

  // Multi-consulta: todos los `q` (repetidos o separados por coma).
  const rawQueries = url.searchParams.getAll("q").flatMap((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const queries = rawQueries.length > 0 ? rawQueries : [undefined];

  // Resolver providerId: si no viene, usar el de la organización.
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
    const providerBrief = provider
      ? { providerId: provider.providerId, nombre: provider.nombre }
      : null;

    // Buscar por cada consulta (recetas = varias). Dedupe por productId.
    const all = new Map<string, CatalogProduct>();
    const missing: string[] = [];
    for (const q of queries) {
      const products = await getProductsByProvider(providerId, q, limit);
      if (q && products.length === 0) missing.push(q);
      for (const p of products) {
        if (!all.has(p.productId)) all.set(p.productId, p);
      }
    }

    return Response.json({
      products: [...all.values()].slice(0, limit),
      missing,
      provider: providerBrief,
    });
  } catch (err) {
    console.error("[bot/products] error consultando Firebase:", err);
    return apiError(503, "firebase_unavailable", "No se pudo consultar el catálogo");
  }
}
