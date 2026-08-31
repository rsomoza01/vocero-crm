import { withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { and, eq, ilike, not, or, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Proxy a nea-agent: pacientes con condición crónica detectada, con
 * paginación y filtros (nombre, condición, teléfono).
 * GET /api/analytics/chronic-patients?q=...&condicion=...&consentidos=1&page=1&limit=20
 *
 * El filtro por nombre/teléfono se resuelve en la tabla `contact` del CRM
 * (que tiene name/phone), y las identidades resultantes se pasan a nea-agent
 * para que filtre los perfiles. La condición y la paginación van a nea-agent.
 */
export const GET = withAuth(async (session, req: Request) => {
  const env = getEnv();
  const db = getDb();

  // providerId del catálogo Firebase (multi-tenant: cada farmacia = un
  // provider), NO el id de la org del CRM.
  const orgRows = await db
    .select({ providerId: schema.organization.providerId })
    .from(schema.organization)
    .where(eq(schema.organization.id, session.organizationId))
    .limit(1);
  const providerId = orgRows[0]?.providerId ?? "";
  if (!providerId) {
    return Response.json({ provider_id: "", pacientes: [], total: 0 }, { status: 200 });
  }

  const q = new URL(req.url).searchParams;
  const query = q.get("q")?.trim() ?? "";
  const condicion = q.get("condicion")?.trim() ?? "";
  const consentidos = q.get("consentidos");
  const page = Math.max(1, Number(q.get("page") ?? "1") || 1);
  const limit = Math.max(1, Math.min(Number(q.get("limit") ?? "20") || 20, 100));

  // Filtro por nombre/teléfono: resolver las wa_identity de los contactos de
  // la org que coinciden, y pasarlas a nea-agent.
  let waIdentitys: string[] | null = null;
  if (query) {
    const qLike = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const contacts = await db
      .select({ waIdentity: schema.contact.waIdentity })
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, session.organizationId),
          not(ilike(schema.contact.name, "[Prueba]%")),
          or(
            ilike(schema.contact.name, qLike),
            ilike(sql`coalesce(${schema.contact.phone}, '')`, qLike)
          )
        )
      )
      .limit(500);
    waIdentitys = contacts.map((c) => c.waIdentity);
    // Si el filtro no matchea ningún contacto, no hay pacientes que mostrar.
    if (waIdentitys.length === 0) {
      return Response.json({ provider_id: providerId, pacientes: [], total: 0 }, { status: 200 });
    }
  }

  const url = new URL(`${env.NEA_AGENT_URL}/analytics/chronic-patients`);
  url.searchParams.set("provider_id", providerId);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  if (condicion) url.searchParams.set("condicion", condicion);
  if (consentidos) url.searchParams.set("consentidos", consentidos);
  if (waIdentitys) url.searchParams.set("wa_identitys", waIdentitys.join(","));

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": env.BOT_API_KEY ?? "" },
  }).catch(() => null);
  if (!res) return Response.json({ error: "agente no disponible" }, { status: 502 });
  const data = (await res.json().catch(() => null)) as {
    pacientes?: { wa_identity: string }[];
    total?: number;
  } | null;
  if (!data) return Response.json({ error: "respuesta inválida" }, { status: res.status });

  // Enriquecer con nombre/teléfono del contacto (tabla contact del CRM).
  // Se EXCLUYEN también aquí los contactos de prueba del Laboratorio
  // ('[Prueba]...') por si nea-agent devolvió perfiles de ellos (caso sin
  // filtro de búsqueda, donde no pasamos wa_identitys al agente).
  const pacientes = data.pacientes ?? [];
  let contactMap = new Map<string, { name: string; phone: string | null }>();
  if (pacientes.length > 0) {
    const ids = pacientes.map((p) => p.wa_identity);
    const contacts = await db
      .select({ waIdentity: schema.contact.waIdentity, name: schema.contact.name, phone: schema.contact.phone })
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, session.organizationId),
          or(...ids.map((id) => eq(schema.contact.waIdentity, id)))
        )
      );
    contactMap = new Map(contacts.map((c) => [c.waIdentity, { name: c.name, phone: c.phone }]));
  }

  // Descartar los pacientes de prueba del Laboratorio: son contactos cuya
  // wa_identity no está en la org o cuyo nombre empieza con '[Prueba]'. Solo
  // se deja a los que son pacientes reales (el contacto legítimo existe).
  const reales = pacientes.filter((p) => {
    const c = contactMap.get(p.wa_identity);
    return c && !c.name.startsWith("[Prueba]");
  });

  const enriquecidos = reales.map((p) => {
    const c = contactMap.get(p.wa_identity);
    return { ...p, nombre: c?.name ?? p.wa_identity, telefono: c?.phone ?? null };
  });

  return Response.json({
    provider_id: providerId,
    pacientes: enriquecidos,
    total: enriquecidos.length,
  });
});
