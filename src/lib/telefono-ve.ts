/**
 * Normaliza un teléfono venezolano al formato que WhatsApp acepta (solo dígitos,
 * con código de país).
 *
 * Los pacientes se cargan a mano en el SAAS y el número aparece de todas las
 * formas: `04249172943`, `0424 9578845`, `4249172943`, `+58 424-9172943`. Sin
 * normalizar, el envío falla o —peor— va a un número que no existe.
 */
export function normalizarTelefonoVE(crudo: string): string | null {
  let d = String(crudo || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("58")) {
    // ya viene con país
  } else if (d.startsWith("0") && d.length >= 11) {
    d = `58${d.slice(1)}`;
  } else if (d.length === 10) {
    d = `58${d}`;
  }
  if (d.length < 12 || d.length > 13) return null;
  return d;
}
