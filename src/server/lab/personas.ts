/**
 * Las 6 personas GUIONADAS del Laboratorio (FR-030). El cliente simulado no
 * usa LLM: son secuencias fijas — determinismo total del lado del cliente.
 * El agente que responde es el REAL (mismo pipeline de US3).
 *
 * DOMINIO: agente farmacéutico (vocero-crm + nea-agent) con catálogo de
 * medicamentos. Los guiones usan medicamentos reales del catálogo de la
 * farmacia (losartán, daflon, esoz, bumetin, fexofenadina, moderan...) para
 * disparar los flujos reales: consulta, genéricos, carrito, receta, escalado.
 */

import { RECETA_FOTO_BASE64 } from "./receta_base64";

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Teléfono sintético estable (jamás un número real). */
  phone: string;
  contactName: string;
  script: string[];
  /**
   * Imagen de receta (base64) para el personaje de receta por foto. Si una
   * línea del script es exactamente "[FOTO]", el runner envía esta imagen al
   * agente (imageBase64) en vez de texto, simulando una foto de receta.
   */
  imageBase64?: string;
};

export const PERSONAS: Persona[] = [
  {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description: "Sabe lo que quiere y va directo a comprar.",
    phone: "5210000000001",
    contactName: "[Prueba] Comprador decidido",
    script: [
      "Hola, buenas tardes",
      "¿Tienen losartán 50 mg?",
      "Perfecto, quiero 2 cajas de la opción más económica",
      "Sí, eso es todo, finaliza mi pedido",
    ],
  },
  {
    key: "pregunton_precios",
    label: "Preguntón de precios",
    description: "Pregunta precio tras precio y pide genéricos sin decidirse.",
    phone: "5210000000002",
    contactName: "[Prueba] Preguntón de precios",
    script: [
      "Hola, ¿qué precio tiene el daflon 500?",
      "¿Y el esoz 40 mg?",
      "¿Tienen genérico del daflon más económico?",
      "¿Qué llevo en el carrito hasta ahora?",
      "Ok, lo voy a pensar",
    ],
  },
  {
    key: "cliente_enojado",
    label: "Cliente enojado",
    description: "Llega molesto por un medicamento que no le despacharon bien.",
    phone: "5210000000003",
    contactName: "[Prueba] Cliente enojado",
    script: [
      "Oigan, esto es el colmo",
      "Pedí mi bumetin retard y me dieron otra cosa, son unos inútiles",
      "¿Me van a responder o qué? Quiero una solución YA",
      "Esto es una estafa, no pienso dejar mi dinero con ustedes",
    ],
  },
  {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description: "Pregunta algo que el knowledge base no cubre (fuera_de_kb).",
    phone: "5210000000004",
    contactName: "[Prueba] Fuera del conocimiento",
    script: [
      "Hola, una pregunta",
      "¿Me dan la receta de la abuela? No, ¿hacen entrega a domicilio los domingos?",
      "¿Y si el medicamento llega vencido me lo cambian?",
      "¿Dónde reclamo si algo sale mal?",
    ],
  },
  {
    key: "pide_humano",
    label: "Pide un humano",
    description: "Quiere ser atendido por una persona (debe escalar).",
    phone: "5210000000005",
    contactName: "[Prueba] Pide humano",
    script: [
      "Hola",
      "Necesito un medicamento controlado que no manejan",
      "Prefiero que me atienda una persona, quiero hablar con un humano",
      "Gracias",
    ],
  },
  {
    key: "errores_modismos",
    label: "Errores y modismos",
    description: "Escribe con faltas de ortografía y modismos venezolanos.",
    phone: "5210000000006",
    contactName: "[Prueba] Errores y modismos",
    script: [
      "epa, tienes panadol?",
      "oiga y que me cuesta la fexofenasina?",
      "dame 3 cajas de la mas barata de esoz",
      "va, listo, eso es todo vale",
    ],
  },
  {
    key: "receta_foto",
    label: "Receta por foto",
    description: "Manda una foto de su receta (OCR) y pide los medicamentos.",
    phone: "5210000000007",
    contactName: "[Prueba] Receta por foto",
    imageBase64: RECETA_FOTO_BASE64,
    script: [
      "Hola, te mando la foto de mi receta",
      "[FOTO]",
      "¿Cuánto sale todo eso?",
      "Ok, quiero 1 caja de cada uno",
    ],
  },
];

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, p.label])
);
