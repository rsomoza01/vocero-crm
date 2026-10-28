import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { getProviderInfo } from "@/server/catalog/firebase";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/providers?providerId=...
 *
 * Info del proveedor/farmacia: nombre, HORARIO, dirección y formas de pago.
 * La consume el agente externo (nea-agent) para responder "¿hasta qué hora está
 * abierta la farmacia?", "¿dónde están?", "¿cómo puedo pagar?".
 *
 * Autenticado con X-API-Key (igual que /api/bot/products).
 */
export async function GET(req: Request) {
  const env = getEnv();
  if (!env.BOT_API_KEY) {
    return Response.json({ error: "bot_disabled" }, { status: 401 });
  }
  const key = req.headers.get("x-api-key");
  if (!key || key.length < 16) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const a = Buffer.from(env.BOT_API_KEY);
  const b = Buffer.from(key);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const providerId = url.searchParams.get("providerId") ?? "";
  if (!providerId) {
    return Response.json({ provider: null, hours: null }, { status: 200 });
  }

  const provider = await getProviderInfo(providerId);
  if (!provider) {
    return Response.json({ provider: null, hours: null }, { status: 200 });
  }

  // `provider` va como OBJETO (no como string): nea-agent hace
  // `provider = data.get("provider") or data` y luego `provider.get("hours")`.
  // Devolver solo el nombre rompía el acceso por clave.
  return Response.json({
    provider: {
      name: provider.name ?? null,
      hours: provider.hours ?? null,
      address: provider.address ?? null,
      paymenType: provider.paymenType ?? null,
    },
    // Espejo en la raíz por comodidad/compatibilidad.
    hours: provider.hours ?? null,
    address: provider.address ?? null,
    paymenType: provider.paymenType ?? null,
  });
}
