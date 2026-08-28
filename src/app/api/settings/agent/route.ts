import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type OrgMeta = { ownerPhone?: string };

function parseMeta(raw: string | null): OrgMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as OrgMeta;
  } catch {
    return {};
  }
}

/**
 * GET /api/settings/agent
 * Estado global del agente (pausado o no) + teléfono autorizado a cambiarlo.
 */
export async function GET() {
  const session = await requireSession();
  const db = getDb();
  const rows = await db
    .select({
      botPaused: schema.organization.botPaused,
      metadata: schema.organization.metadata,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, session.organizationId))
    .limit(1);
  const org = rows[0];
  if (!org) return Response.json({ error: "not_found" }, { status: 404 });
  const meta = parseMeta(org.metadata);
  return Response.json({
    botPaused: org.botPaused ?? false,
    ownerPhone: meta.ownerPhone ?? "",
  });
}

/**
 * POST /api/settings/agent  { botPaused?, ownerPhone? }
 * Actualiza el estado global del agente y/o el teléfono autorizado.
 */
export async function POST(req: Request) {
  const session = await requireSession();
  const body = (await req.json().catch(() => null)) as {
    botPaused?: boolean;
    ownerPhone?: string;
  } | null;
  const db = getDb();
  const rows = await db
    .select({
      botPaused: schema.organization.botPaused,
      metadata: schema.organization.metadata,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, session.organizationId))
    .limit(1);
  const org = rows[0];
  if (!org) return Response.json({ error: "not_found" }, { status: 404 });

  const meta = parseMeta(org.metadata);
  let botPaused = org.botPaused ?? false;
  if (body?.ownerPhone !== undefined) {
    const digits = body.ownerPhone.replace(/[^0-9]/g, "");
    if (body.ownerPhone.trim() !== "" && !/^\d{7,15}$/.test(digits)) {
      return Response.json(
        { error: "ownerPhone inválido (usa formato internacional sin +: p.ej. 584128840350)" },
        { status: 400 }
      );
    }
    meta.ownerPhone = digits || undefined;
  }
  if (typeof body?.botPaused === "boolean") {
    botPaused = body.botPaused;
  }
  await db
    .update(schema.organization)
    .set({
      botPaused,
      metadata: Object.keys(meta).length ? JSON.stringify(meta) : null,
    })
    .where(eq(schema.organization.id, session.organizationId));
  return Response.json({ ok: true, botPaused, ownerPhone: meta.ownerPhone ?? "" });
}
