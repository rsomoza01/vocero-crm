import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist } from "next/font/google";
import { accentCssVariables, DEFAULT_BRANDING } from "@/lib/branding";
import { faviconHref } from "@/lib/favicon";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { getSessionOrNull } from "@/lib/auth/session";
import { getBranding } from "@/server/branding";
import "./globals.css";

// next/font descarga la fuente en BUILD y la sirve self-hosted (sin CDN).
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // Multitenant: el favicon y el título dependen de la org activa, que se
  // resuelve por la sesión (cada tenant/providerId tiene su marca). Sin sesión
  // (login) cae al branding genérico.
  const org = (await getSessionOrNull())?.organizationId ?? null;
  const branding = await getBranding(org).catch(() => DEFAULT_BRANDING);
  return {
    title: `${branding.name} — CRM de WhatsApp`,
    description: "CRM de WhatsApp con agente de IA y Laboratorio de auto-evaluación",
    // El `?v=` cambia con la marca: los navegadores guardan el favicon con una
    // insistencia notable y, sin eso, el logo nuevo tarda días en aparecer.
    icons: { icon: faviconHref(branding) },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // MULTITENANT: el acento (color) es por organización, así que hay que
  // resolverlo por la SESIÓN, no con un `getBranding()` sin org — ese cae al
  // fallback `LIMIT 1` y pintaba a TODOS los tenants con el color de una org
  // arbitraria (la misma raíz del bug del nombre "Gentefarma" repetido). Sin
  // sesión (login) va el acento neutro de la instancia.
  const org = (await getSessionOrNull())?.organizationId ?? null;
  const branding = await getBranding(org).catch(() => DEFAULT_BRANDING);
  const theme = normalizeThemePreference(
    (await cookies()).get(THEME_COOKIE)?.value
  );
  return (
    <html
      lang="es"
      className={geist.variable}
      // La preferencia siempre es explícita: el tema viaja resuelto en el HTML
      // del servidor, así que no hay divergencia con el cliente ni parpadeo.
      data-theme={theme}
    >
      <head>
        {/* Acento white-label inyectado en SSR: sin flash de tema */}
        <style
          dangerouslySetInnerHTML={{ __html: accentCssVariables(branding.accent) }}
        />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
