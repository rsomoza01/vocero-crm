/**
 * Detección de mensajes AUTOMÁTICOS de WhatsApp Business.
 *
 * Por qué existe: WhatsApp Business manda plantillas (mensaje de bienvenida,
 * respuesta inmediata, ausencia, catálogo) al recibir el primer mensaje del
 * cliente. En el webhook llegan EXACTAMENTE igual que una respuesta manual del
 * dueño (`Info.IsFromMe = true` / echo), así que el CRM pausaba la IA con
 * `handoff_reason = "manual_reply"` por un mensaje que el dueño NUNCA escribió.
 *
 * Efecto real: el cliente escribía "Hola", el negocio contestaba su plantilla, la
 * conversación quedaba con `ai_enabled = false` y el agente no volvía a responder
 * nunca más en ese hilo — el cliente reportaba "el agente no responde".
 *
 * Medido en la BD de producción: 34 salidas con delta ≈0 s respecto al inbound, y
 * la misma plantilla repetida a varios contactos distintos (imposible a mano).
 *
 * Nota: el fork evolution-go NO expone ningún flag de "plantilla/mensaje rápido"
 * en el payload, así que la detección es por TEXTO. Si el dueño usa una plantilla
 * que no está en esta lista, se registra como respuesta manual (comportamiento
 * anterior); añadirla aquí es el ajuste.
 */

/** Plantillas conocidas de WhatsApp Business. Se comparan en minúsculas por
 *  inclusión, porque el dueño suele añadir el nombre del negocio delante. */
export const PLANTILLAS_AUTOMATICAS: readonly string[] = [
  // mensaje de bienvenida / respuesta inmediata
  "saludos bienvenidos",
  "bienvenido a",
  "bienvenidos a",
  "gracias por escribirnos",
  "gracias por contactarnos",
  "gracias por comunicarte",
  "en breve te atendemos",
  "en breve le atendemos",
  "en un momento le atendemos",
  "en un momento te atendemos",
  "pronto le atenderemos",
  "gracias por preferirnos",
  // mensaje de ausencia
  "no estamos disponibles",
  "no puedo atender en este momento",
  "fuera de horario",
  "nuestro horario de atencion",
  "nuestro horario de atención",
  "dejanos tu mensaje",
  "deje su mensaje",
  "te responderemos lo antes posible",
  "le responderemos lo antes posible",
  "escribenos y te atendemos",
  // promoción automática con catálogo/tienda (no es conversación)
  "nuestra tienda online",
  "nuestro catalogo",
  "nuestro catálogo",
  "visita nuestra tienda",
  // despedida automática
  "gracias por tu compra",
  "gracias por su compra",
];

/**
 * ¿El texto es un mensaje automático de WhatsApp Business?
 *
 * Se usa para registrar el mensaje en el hilo (el cliente SÍ lo vio) SIN pausar
 * la IA. Nunca debe silenciarse el mensaje: solo evitar el handoff.
 */
export function esMensajeAutomatico(texto: string | null | undefined): boolean {
  const t = (texto ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  return PLANTILLAS_AUTOMATICAS.some((p) => t.includes(p));
}
