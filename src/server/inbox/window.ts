/**
 * Ventana de servicio de 24 horas de WhatsApp: solo se puede enviar texto
 * libre dentro de las 24h siguientes al último mensaje ENTRANTE. Una
 * conversación sin entrantes (p. ej. iniciada por plantilla) tiene la
 * ventana cerrada.
 *
 * En el canal "evolution" (Evolution GO/API) esta regla de Meta NO aplica:
 * WhatsApp Web permite escribir libremente, así que la ventana se considera
 * siempre abierta.
 */

import { getEnv } from "@/lib/env";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWindowOpen(
  lastInboundAt: Date | null,
  now: Date = new Date()
): boolean {
  // Evolution (WhatsApp Web) no tiene ventana de 24h de Meta.
  try {
    if (getEnv().CHANNEL_PROVIDER === "evolution") return true;
  } catch {
    // Si la config no está disponible, seguir la lógica de Meta.
  }
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/** Milisegundos restantes de ventana (0 si está cerrada). */
export function windowRemainingMs(
  lastInboundAt: Date | null,
  now: Date = new Date()
): number {
  try {
    if (getEnv().CHANNEL_PROVIDER === "evolution") return WINDOW_MS;
  } catch {
    // Si la config no está disponible, seguir la lógica de Meta.
  }
  if (!lastInboundAt) return 0;
  const remaining = WINDOW_MS - (now.getTime() - lastInboundAt.getTime());
  return Math.max(0, remaining);
}

