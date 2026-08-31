import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";
import { apiError, parseBody } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** Etapas sembradas del pipeline (mismas que onUserCreated / provision). */
const SEED_STAGES: { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "Nuevo", kind: "open" },
  { name: "En conversación", kind: "open" },
  { name: "Interesado", kind: "open" },
  { name: "Cliente", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

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

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  // Nombre de la farmacia/negocio (opcional; default: "Negocio de {name}").
  farmacia: z.string().trim().min(1).max(120).optional(),
  // providerId del catálogo Firebase (opcional; si no viene, la org queda sin
  // catálogo y el agente no consulta productos hasta configurarlo).
  providerId: z.string().trim().min(1).max(64).optional(),
});

/**
 * POST /api/auth/register  { name, email, password, farmacia?, providerId? }
 *
 * Registro público que SIEMPRE crea una organización nueva para el usuario
 * (a diferencia del registro por defecto, que solo crea la org en la primera
 * cuenta de la instancia). Cada farmacia que se registra obtiene su propia
 * organización + owner + pipeline + agentProfile, con su providerId de
 * catálogo. Crea la sesión y devuelve la cookie firmada (login directo).
 */
export async function POST(req: Request) {
  const env = getEnv();
  const body = await parseBody(req, registerSchema);
  if (!body.ok) return body.response;

  const { name, email, password, farmacia, providerId } = body.data;
  const orgName = farmacia || `Negocio de ${name}`;

  const db = getDb();

  // --- FASE 1: crear el usuario (fuera de transacción: signUpEmail gestiona
  // su propia conexión). runInternalSignup evita el gate de registro público
  // cerrado. El hook onUserCreated NO crea org aquí (ya existen orgs), así
  // que la org la creamos explícitamente abajo.
  let userId: string;
  const existing = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (existing[0]) {
    return apiError(409, "duplicate", "Ya existe una cuenta con ese correo");
  }
  try {
    const result = await runInternalSignup(() =>
      getAuth().api.signUpEmail({
        body: { name, email, password },
      })
    );
    userId = result.user.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo crear la cuenta";
    if (/exist/i.test(message)) {
      return apiError(409, "duplicate", "Ya existe una cuenta con ese correo");
    }
    return apiError(422, "invalid", message);
  }

  // --- FASE 2: crear la org + owner + pipeline + agentProfile en transacción.
  let organizationId: string;
  try {
    organizationId = await db.transaction(async (tx) => {
      const orgId = newId("organization");
      const finalSlug = slugify(orgName);
      // Slug único: si choca, agregar sufijo numérico.
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
        name: orgName,
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
      return orgId;
    });
  } catch (err) {
    console.error("[register] no se pudo crear la organización:", err);
    return apiError(500, "internal", "No se pudo crear la organización");
  }

  // --- FASE 3: crear la sesión y devolver la cookie firmada (login directo).
  try {
    const auth = getAuth();
    const ctx = (await (auth as unknown as { $context: Promise<unknown> }).$context) as {
      internalAdapter: {
        createSession: (userId: string) => Promise<{ token: string }>;
      };
      createAuthCookie: (
        name: string
      ) => { name: string; attributes: Record<string, unknown> };
    };
    const session = await ctx.internalAdapter.createSession(userId);
    const cookie = ctx.createAuthCookie("session_token");
    const signedToken = signSessionCookie(session.token, env.BETTER_AUTH_SECRET);
    const res = Response.json(
      { ok: true, organizationId, redirectTo: "/inbox" },
      { status: 201 }
    );
    res.headers.set(
      "Set-Cookie",
      `${cookie.name}=${signedToken}; Path=/; HttpOnly; SameSite=Lax; ${
        env.APP_BASE_URL.startsWith("https") ? "Secure; " : ""
      }Max-Age=604800`
    );
    return res;
  } catch (err) {
    console.error("[register] no se pudo crear la sesión:", err);
    // El usuario y la org se crearon; el login normal funcionará.
    return Response.json(
      { ok: true, organizationId, redirectTo: "/login" },
      { status: 201 }
    );
  }
}

/** Cookie firmada de better-auth: `token.firma` (HMAC-SHA256 base64). */
function signSessionCookie(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return `${value}.${signature}`;
}
