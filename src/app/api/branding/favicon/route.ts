import { readMediaFile } from "@/server/whatsapp/media";
import { getBrandingContext, brandingDeInstancia } from "@/server/branding";
import { getSessionOrNull } from "@/lib/auth/session";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { FAVICON_ASSET, generatedFaviconSvg } from "@/lib/favicon";

export const dynamic = "force-dynamic";

/**
 * Cabeceras con las que se sirve CUALQUIER icono, subido o generado.
 *
 * Un SVG que sube el dueño es un documento con permiso de ejecutar guiones si
 * alguien navega a su URL. La CSP lo deja sin nada que ejecutar y `nosniff`
 * impide que el navegador reinterprete el tipo. Cuesta dos cabeceras y quita
 * de la mesa toda esa clase de problema.
 */
function cabeceras(mime: string, cacheable: boolean): HeadersInit {
  return {
    "content-type": mime,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    // La URL lleva `?v=` y cambia con la marca, así que se puede cachear
    // fuerte. Sin ese sufijo —alguien pidiendo la ruta pelada— no.
    "cache-control": cacheable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60",
  };
}

/**
 * El icono de la pestaña. **Ruta pública**: el login también tiene pestaña, y
 * ahí todavía no hay sesión. Es la misma decisión que ya toma el GET de la
 * marca — en una instancia de un solo negocio, su nombre y su logo no son un
 * secreto.
 */
export async function GET(req: Request) {
  const cacheable = new URL(req.url).searchParams.has("v");

  // Multitenant: resuelve la org por la sesión del navegador. Cada tenant /
  // providerId tiene su propia marca (nombre, acento y logo), así que el icono
  // de la pestaña cambia según quién entró por SSO. Sin sesión (login) cae al
  // branding genérico de la instancia.
  const org = (await getSessionOrNull())?.organizationId ?? null;
  const ctx = await getBrandingContext(org).catch(() => null);
  // Sin sesión (login) NO se usa el nombre de una organización arbitraria: se
  // genera el icono con la marca NEUTRA de la instancia.
  const branding = org
    ? (ctx?.branding ?? DEFAULT_BRANDING)
    : brandingDeInstancia();

  if (org && ctx?.organizationId && branding.favicon) {
    try {
      const buf = await readMediaFile(ctx.organizationId, FAVICON_ASSET);
      return new Response(new Uint8Array(buf), {
        headers: cabeceras(branding.favicon.mime, cacheable),
      });
    } catch {
      // El archivo se perdió (volumen sin montar, restauración a medias). Se
      // cae al generado en vez de dejar la pestaña sin icono: un 404 aquí se
      // ve como si la instancia estuviera rota.
    }
  }

  return new Response(generatedFaviconSvg(branding), {
    headers: cabeceras("image/svg+xml", cacheable),
  });
}
