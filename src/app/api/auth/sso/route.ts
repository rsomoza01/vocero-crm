import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
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

/**
 * POST /api/auth/sso  { email }
 * Llamado por el SAAS (app.gentefarma.com) con firma HMAC del body.
 * Emite un token de un solo uso (60 s) y devuelve la URL de verify.
 */
export async function POST(req: Request) {
  const env = getEnv();
  if (!env.SSO_SHARED_SECRET) {
    return withCors(Response.json({ error: "disabled" }, { status: 404 }));
  }

  const raw = await req.text();
  let body: { email?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return withCors(Response.json({ error: "invalid_body" }, { status: 400 }));
  }
  const email = (body.email ?? "").toString().trim().toLowerCase();
  if (!email) {
    return withCors(Response.json({ error: "email_required" }, { status: 400 }));
  }

  // Verificar firma HMAC-SHA256 del body con el secreto compartido.
  const sig = req.headers.get("x-sso-signature") ?? "";
  const expected = createHmac("sha256", env.SSO_SHARED_SECRET).update(raw).digest("hex");
  if (!timingSafeEqualHex(sig, expected)) {
    return withCors(Response.json({ error: "bad_signature" }, { status: 401 }));
  }

  // El email debe existir en el CRM (nunca se crean cuentas nuevas).
  const db = getDb();
  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (!users[0]) {
    return withCors(Response.json({ error: "account_not_found" }, { status: 404 }));
  }

  // Token opaco de un solo uso, 60 s de vida.
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
  return withCors(Response.json({ url }));
}
