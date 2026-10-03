import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// La versión sale de package.json y no de una constante aparte: duplicarla es
// tenerla desactualizada en uno de los dos lados, y justo esta no puede mentir.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

const nextConfig: NextConfig = {
  // standalone es para la imagen Docker (Linux). En Windows el trazado crea
  // symlinks que requieren permisos elevados, así que ahí se omite.
  output: process.platform === "win32" ? undefined : "standalone",
  // El paquete `postgres` usa APIs de Node que no deben empaquetarse en el bundle.
  serverExternalPackages: ["postgres"],
  // Se congelan al construir: el binario lleva dentro de qué código salió, así
  // que no puede mentir en tiempo de ejecución. `SOURCE_COMMIT` lo inyecta
  // Coolify solo; con docker compose se pasa por `--build-arg` y si falta, la
  // app enseña solo la versión.
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_COMMIT: process.env.SOURCE_COMMIT ?? "",
  },
  /**
   * Cabeceras de seguridad.
   *
   * `Strict-Transport-Security` (HSTS) es la que faltaba: sin ella el navegador
   * NO recuerda que este host debe ir SIEMPRE por HTTPS, así que si el usuario
   * entra por `http://` (un enlace viejo, el autocompletado que elige http, un
   * marcador antiguo) la primera petición viaja en claro. Con HSTS el navegador
   * reescribe `http://` a `https://` ANTES de salir a la red. Los navegadores
   * IGNORAN esta cabecera cuando llega por http (por especificación), así que
   * declararla siempre es seguro: en desarrollo local por http no tiene efecto.
   *
   * `includeSubDomains` se omite a propósito: el dominio raíz aloja otros
   * servicios (el SAAS) y un HSTS con subdominios obligaría a TODOS ellos a
   * tener un certificado válido para siempre — si uno fallara, quedaría
   * inaccesible. El host del CRM se protege igual sin ese flag.
   */
  async headers() {
    const seguridad = [
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
    ];
    return [{ source: "/:path*", headers: seguridad }];
  },
};

export default nextConfig;
