import { createHmac, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Origen permitido para CORS (el SAAS). Configurable por env. */
const ALLOWED_ORIGIN = process.env.SSO_ALLOWED_ORIGIN || "https://app.gentefarma.com";

function withCors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-SSO-Signature, Authorization");
  return res;
}

export async function OPTIONS() {
  return withCors(new Response(null, { status: 204 }));
}

/** Comparación en tiempo constante para firmas hex. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Etapas sembradas del pipeline (mismas que onUserCreated). */
const SEED_STAGES: { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "Nuevo", kind: "open" },
  { name: "En conversación", kind: "open" },
  { name: "Interesado", kind: "open" },
  { name: "Cliente", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

/** Slug único derivado del nombre del negocio. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "negocio";
}

/** Genera una contraseña aleatoria inutilizable: SSO no usa contraseñas. */
function randomPassword(): string {
  return `sso_${randomBytes(18).toString("base64url")}`;
}

/**
 * POST /api/auth/sso/provision  { email, name, slug?, providerId? }
 * Llamado por el SAAS (app.gentefarma.com) con firma HMAC del body.
 *
 * Garantiza acceso único con SSO: crea la farmacia (org) en la BD del CRM y
 * deja al dueño como owner, SIN contraseña utilizable (login siempre por SSO).
 * Es IDEMPOTENTE: si la org ya existe (re-registro del SAAS) no duplica, solo
 * re-emite un token SSO. Devuelve la URL de /verify para entrar directo.
 *
 * El alta va protegida por un advisory lock transaccional por email, así dos
 * llamadas simultáneas del SAAS nunca crean dos organizaciones.
 */
export async function POST(req: Request) {
  const env = getEnv();
  if (!env.SSO_SHARED_SECRET) {
    return withCors(Response.json({ error: "disabled" }, { status: 404 }));
  }

  const raw = await req.text();
  let body: { email?: string; name?: string; slug?: string; providerId?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return withCors(Response.json({ error: "invalid_body" }, { status: 400 }));
  }

  const email = (body.email ?? "").toString().trim().toLowerCase();
  const ownerName = (body.name ?? email.split("@")[0] ?? "").toString().trim();
  if (!email) {
    return withCors(Response.json({ error: "email_required" }, { status: 400 }));
  }
  if (!ownerName) {
    return withCors(Response.json({ error: "name_required" }, { status: 400 }));
  }
  const providerId = (body.providerId ?? "").toString().trim() || null;
  const slug = (body.slug ?? "").toString().trim() || null;

  // Verificar firma HMAC-SHA256 del body con el secreto compartido.
  const sig = req.headers.get("x-sso-signature") ?? "";
  const expected = createHmac("sha256", env.SSO_SHARED_SECRET).update(raw).digest("hex");
  if (!timingSafeEqualHex(sig, expected)) {
    return withCors(Response.json({ error: "bad_signature" }, { status: 401 }));
  }

  const db = getDb();

  // --- FASE 1: asegurar que el usuario existe (fuera de transacción, porque
  // signUpEmail gestiona su propia conexión/transacción) ---------------------
  let userId: string;
  const existingUser = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (existingUser[0]) {
    userId = existingUser[0].id;
  } else {
    // Alta sin contraseña utilizable; runInternalSignup evita el gate de
    // registro público cerrado. El hook onUserCreated de better-auth no crea
    // org aquí (el tenant ya tiene una), así que la org la creamos abajo.
    try {
      const result = await runInternalSignup(() =>
        getAuth().api.signUpEmail({
          body: {
            name: ownerName,
            email,
            password: randomPassword(),
          },
        })
      );
      userId = result.user.id;
    } catch (err) {
      // Carrera: otro request creó el usuario entre la consulta y el signUp.
      if (err instanceof Error && /exist/i.test(err.message)) {
        const re = await db
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.email, email))
          .limit(1);
        if (!re[0]) {
          return withCors(
            Response.json({ error: "signup_failed", detail: err.message }, { status: 409 })
          );
        }
        userId = re[0].id;
      } else {
        return withCors(
          Response.json({ error: "signup_failed", detail: err instanceof Error ? err.message : "?" }, { status: 409 })
        );
      }
    }
  }

  // --- FASE 2: crear/recuperar la org en transacción con advisory lock -------
  let organizationId: string = null as unknown as string;
  let created = false;

  await db.transaction(async (tx) => {
    // Lock transaccional POR EMAIL: dos provisions simultáneos del SAAS para la
    // misma farmacia se serializan aquí y solo el primero crea la org.
    const KEY = 8672;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${email}, ${KEY}))`);

    // 1) Buscar una org existente que corresponda a ESTA farmacia, por
    //    prioridad: providerId → slug → org donde el dueño es owner.
    let found: { id: string } | undefined;

    if (providerId) {
      const rows = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.providerId, providerId))
        .limit(1);
      found = rows[0];
    }
    if (!found && slug) {
      const rows = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug))
        .limit(1);
      found = rows[0];
    }
    if (!found) {
      const rows = await tx
        .select({ id: schema.organization.id })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
        .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
        .where(
          and(
            eq(schema.user.email, email),
            eq(schema.member.role, "owner")
          )
        )
        .limit(1);
      found = rows[0];
    }

    if (found) {
      organizationId = found.id;
      return; // idempotente: no crear nada, re-emitir SSO abajo.
    }

    // 2) Crear la org nueva.
    const orgId = newId("organization");
    const finalSlug = slug ?? slugify(ownerName);

    // Si el slug derivado ya lo usa otra org, agregar sufijo numérico.
    let uniqueSlug = finalSlug;
    let n = 2;
    for (;;) {
      const clash = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, uniqueSlug))
        .limit(1);
      if (!clash[0]) break;
      uniqueSlug = `${finalSlug}-${n++}`;
    }

    await tx.insert(schema.organization).values({
      id: orgId,
      name: ownerName,
      slug: uniqueSlug,
      providerId: providerId ?? undefined,
    });
    await tx.insert(schema.member).values({
      id: newId("member"),
      organizationId: orgId,
      userId,
      role: "owner",
    });
    await tx.insert(schema.pipelineStage).values(
      SEED_STAGES.map((s, i) => ({
        id: newId("stage"),
        organizationId: orgId,
        name: s.name,
        position: i,
        kind: s.kind,
      }))
    );
    await tx.insert(schema.agentProfile).values({
      id: newId("agentProfile"),
      organizationId: orgId,
    });

    organizationId = orgId;
    created = true;
  });

  // --- FASE 3: emitir token SSO de un solo uso y URL de verify ---------------
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHmac("sha256", env.SSO_SHARED_SECRET).update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60_000);
  await db.insert(schema.ssoToken).values({
    tokenHash,
    email,
    redirectTo: "/inbox",
    expiresAt,
  });

  const url = `${env.APP_BASE_URL}/api/auth/sso/verify?token=${encodeURIComponent(token)}`;
  return withCors(
    Response.json({ url, organizationId, existing: !created }, { status: created ? 201 : 200 })
  );
}
