import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/sso/verify?token=...
 * Verifica el token de un solo uso, crea la sesión better-auth NATIVA y
 * redirige a /inbox con la cookie de sesión firmada (token.firma).
 */
export async function GET(req: Request) {
  const env = getEnv();
  if (!env.SSO_SHARED_SECRET) {
    return NextResponse.redirect(new URL("/login", env.APP_BASE_URL));
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/login", env.APP_BASE_URL));
  }

  const db = getDb();
  const tokenHash = createHmac("sha256", env.SSO_SHARED_SECRET).update(token).digest("hex");
  const rows = await db
    .select()
    .from(schema.ssoToken)
    .where(
      and(
        eq(schema.ssoToken.tokenHash, tokenHash),
        isNull(schema.ssoToken.usedAt),
        gt(schema.ssoToken.expiresAt, new Date())
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) {
    return NextResponse.redirect(new URL("/login?error=sso", env.APP_BASE_URL));
  }

  // Marcar como usado (1 solo uso).
  await db
    .update(schema.ssoToken)
    .set({ usedAt: new Date() })
    .where(eq(schema.ssoToken.tokenHash, tokenHash));

  // Buscar el usuario por email.
  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, row.email))
    .limit(1);
  const user = users[0];
  if (!user) {
    return NextResponse.redirect(new URL("/login?error=sso", env.APP_BASE_URL));
  }

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
    const session = await ctx.internalAdapter.createSession(user.id);
    // La cookie de sesión de better-auth NO es el token plano: es
    // `token.firma` (HMAC-SHA256(token, BETTER_AUTH_SECRET) en base64).
    // getSession lee esa cookie, verifica la firma y obtiene el token plano
    // para buscar en BD. Sin la firma, getSession rechaza la cookie → login.
    const cookie = ctx.createAuthCookie("session_token");
    const signedToken = signSessionCookie(session.token, env.BETTER_AUTH_SECRET);
    const dest = row.redirectTo.startsWith("/") ? row.redirectTo : "/inbox";
    const res = NextResponse.redirect(new URL(dest, env.APP_BASE_URL));
    // Setear la cookie firmada (token.firma) httpOnly en el dominio del CRM.
    res.cookies.set(cookie.name, signedToken, cookie.attributes);
    return res;
  } catch (err) {
    console.error("[sso/verify] no se pudo crear la sesión:", err);
    return NextResponse.redirect(new URL("/login?error=sso", env.APP_BASE_URL));
  }
}

/**
 * Construye el valor de cookie firmada de better-auth: `token.firma` donde
 * firma = base64(HMAC-SHA256(token, secret)). NO se aplica encodeURIComponent
 * aquí: res.cookies.set() (Next.js) ya codifica el valor al serializar, y
 * better-auth decodifica al leer. Si codificáramos aquí, quedaría doble-codificado.
 */
function signSessionCookie(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return `${value}.${signature}`;
}
