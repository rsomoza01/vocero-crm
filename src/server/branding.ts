import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import {
  DEFAULT_BRANDING,
  normalizeBranding,
  type Branding,
} from "@/lib/branding";

/** Marca guardada en organization.metadata (JSON de Better Auth). */

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Marca + a qué organización pertenece.
 *
 * El icono se guarda como archivo en `MEDIA_DIR/{organizationId}/favicon`, así
 * que servirlo necesita el id — y la ruta que lo sirve es pública (el login
 * también tiene pestaña), donde no hay sesión de la que sacarlo.
 */
export async function getBrandingContext(
  organizationId?: string | null
): Promise<{ organizationId: string | null; branding: Branding }> {
  const db = getDb();
  const rows = organizationId
    ? await db
        .select({ id: schema.organization.id, metadata: schema.organization.metadata })
        .from(schema.organization)
        .where(eq(schema.organization.id, organizationId))
        .limit(1)
    : // Sin sesión (login, layout raíz): marca de la instancia. Se ordena por id
      // para que sea DETERMINISTA — un LIMIT 1 sin ORDER BY devolvía una fila
      // arbitraria según el plan del planner, así que la marca que se veía en el
      // login cambiaba entre consultas y, al guardar sin sesión, se escribía en
      // una organización cualquiera (origen del "Gentefarma" replicado en varios
      // tenants, que no es el nombre de ninguno).
      await db
        .select({ id: schema.organization.id, metadata: schema.organization.metadata })
        .from(schema.organization)
        .orderBy(schema.organization.id)
        .limit(1);
  if (!rows[0]) return { organizationId: null, branding: DEFAULT_BRANDING };
  const meta = parseMetadata(rows[0].metadata);
  return {
    organizationId: rows[0].id,
    branding: normalizeBranding(
      (meta.branding as Partial<Branding> | undefined) ?? null
    ),
  };
}

export async function getBranding(
  organizationId?: string | null
): Promise<Branding> {
  // Sin organización (login, layout raíz antes de autenticar) NO se cae al
  // `LIMIT 1` de una org arbitraria: se devuelve la marca NEUTRA de la
  // instancia. Así el login muestra el nombre del servicio y no el de una
  // farmacia concreta (que además cambiaba entre consultas por el orden del
  // planner al no llevar ORDER BY).
  if (!organizationId) return brandingDeInstancia();
  return (await getBrandingContext(organizationId)).branding;
}

/**
 * Marca NEUTRA de la instancia, para pantallas sin sesión (login).
 *
 * Toma el nombre de `INSTANCE_BRAND_NAME` (env) y el acento del branding de la
 * primera organización —el aspecto visual del producto— pero SIN el nombre de
 * ningún tenant. El favicon neutro se genera con la inicial del nombre.
 */
export function brandingDeInstancia(): Branding {
  let nombre = DEFAULT_BRANDING.name;
  try {
    const env = getEnv();
    if (env.INSTANCE_BRAND_NAME?.trim()) nombre = env.INSTANCE_BRAND_NAME.trim();
  } catch {
    // En build no hay entorno: se queda el default.
  }
  return { ...DEFAULT_BRANDING, name: nombre.slice(0, 30) };
}

export async function saveBranding(
  organizationId: string,
  branding: Branding
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ metadata: schema.organization.metadata })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const meta = parseMetadata(rows[0]?.metadata ?? null);
  meta.branding = normalizeBranding(branding);
  await db
    .update(schema.organization)
    .set({ metadata: JSON.stringify(meta) })
    .where(eq(schema.organization.id, organizationId));
}
