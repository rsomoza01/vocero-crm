/**
 * Proveedor de canal "evolution" — Evolution GO / Evolution API.
 *
 * Envío por HTTP hacia `EVOLUTION_BASE_URL` con el header `apikey` = token de
 * la instancia. Recibe mensajes entrantes por webhook (ruta propia del CRM) en
 * el formato `{ event: "Message", data: {...}, instanceToken, instanceId }`.
 *
 * El número se envía en formato corto (solo dígitos); Evolution GO añade el
 * sufijo @s.whatsapp.net internamente cuando `formatJid=true`.
 */
import { getEnv } from "@/lib/env";
import {
  SendChannelError,
  type ChannelCredentials,
  type ChannelSendResult,
  type SendMediaInput,
  type SendTextInput,
} from "./channel";

const EVOLUTION_TIMEOUT_MS = 15000;

type EvolutionPayload = Record<string, unknown> | null;

interface EvolutionResponse {
  status: number;
  json: EvolutionPayload;
}

async function evolutionFetch(
  path: string,
  init: { method?: string; body?: unknown; instanceToken: string },
): Promise<EvolutionResponse> {
  const env = getEnv();
  const base = env.EVOLUTION_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    throw new SendChannelError(
      "not_connected",
      "EVOLUTION_BASE_URL no está configurada (canal Evolution)",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? "POST",
      headers: {
        apikey: init.instanceToken,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(EVOLUTION_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new SendChannelError(
      "channel_unavailable",
      `No se pudo contactar Evolution GO: ${cause}`,
    );
  }
  const text = await res.text();
  let json: EvolutionPayload = null;
  try {
    json = text ? (JSON.parse(text) as EvolutionPayload) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** Normaliza el número al formato corto que Evolution acepta (solo dígitos). */
export function evolutionRecipient(to: string): string {
  // Quita el sufijo @s.whatsapp.net si vino con él, y cualquier "+"/"-".
  const clean = (to.split("@")[0] ?? to).replace(/[^0-9]/g, "");
  return clean;
}

export async function sendEvolutionText(
  input: SendTextInput,
): Promise<ChannelSendResult> {
  const token = input.credentials.instanceToken;
  if (!token) {
    throw new SendChannelError(
      "not_connected",
      "No hay token de instancia de Evolution conectado",
    );
  }
  const { status, json } = await evolutionFetch("/send/text", {
    body: {
      number: evolutionRecipient(input.to),
      text: input.text,
      formatJid: true,
    },
    instanceToken: token,
  });
  if (status !== 200) {
    throw mapEvolutionError(status, json, input.organizationId);
  }
  const id = getPath(json, "data", "Info", "ID") ?? getPath(json, "data", "id");
  if (!id) {
    throw new SendChannelError(
      "channel_error",
      "Evolution no devolvió ID del mensaje",
    );
  }
  return { waMessageId: String(id) };
}

/** Lee un valor anidado de forma tolerante (sin `any`). */
function getPath(obj: Record<string, unknown> | null, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in cur) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return null;
    }
  }
  return cur;
}

export async function sendEvolutionMedia(
  input: SendMediaInput,
): Promise<ChannelSendResult> {
  const token = input.credentials.instanceToken;
  if (!token) {
    throw new SendChannelError(
      "not_connected",
      "No hay token de instancia de Evolution conectado",
    );
  }
  // Evolution acepta base64 en el campo "url".
  const b64 = Buffer.from(input.file.data).toString("base64");
  const { status, json } = await evolutionFetch("/send/media", {
    body: {
      number: evolutionRecipient(input.to),
      type: input.kind,
      url: b64,
      caption: input.caption ?? "",
      filename: input.file.fileName ?? "adjunto",
      formatJid: true,
    },
    instanceToken: token,
  });
  if (status !== 200) {
    throw mapEvolutionError(status, json, input.organizationId);
  }
  const id = getPath(json, "data", "Info", "ID") ?? getPath(json, "data", "id");
  if (!id) {
    throw new SendChannelError(
      "channel_error",
      "Evolution no devolvió ID del media",
    );
  }
  return { waMessageId: String(id) };
}

/** Traduce un error HTTP de Evolution a SendChannelError tipado. */
export function mapEvolutionError(
  status: number,
  json: Record<string, unknown> | null,
  _organizationId: string,
): SendChannelError {
  const rawMsg = getPath(json, "error") ?? getPath(json, "message");
  const msg = typeof rawMsg === "string" ? rawMsg : `Evolution GO respondió ${status}`;
  if (status === 401 || status === 403) {
    return new SendChannelError(
      "reconnect_required",
      "El token de instancia de Evolution no es válido: reconecta la instancia",
    );
  }
  if (status === 409) {
    return new SendChannelError("window_closed", String(msg));
  }
  if (status >= 500 || status === 0) {
    return new SendChannelError("channel_unavailable", String(msg));
  }
  return new SendChannelError("channel_error", String(msg));
}

/** Envía un contacto (vCard) por Evolution GO. */
export async function sendEvolutionContact(
  input: {
    organizationId: string;
    to: string;
    name: string;
    phone: string;
    credentials: ChannelCredentials;
  },
): Promise<ChannelSendResult> {
  const token = input.credentials.instanceToken;
  if (!token) {
    throw new SendChannelError(
      "not_connected",
      "No hay token de instancia de Evolution conectado",
    );
  }
  const { status, json } = await evolutionFetch("/send/contact", {
    body: {
      number: evolutionRecipient(input.to),
      contactName: input.name,
      contactPhone: input.phone,
      formatJid: true,
    },
    instanceToken: token,
  });
  if (status !== 200) {
    throw mapEvolutionError(status, json, input.organizationId);
  }
  const id = getPath(json, "data", "Info", "ID") ?? getPath(json, "data", "id");
  if (!id) {
    throw new SendChannelError(
      "channel_error",
      "Evolution no devolvió ID del contacto",
    );
  }
  return { waMessageId: String(id) };
}

/** Envía una ubicación por Evolution GO. */
export async function sendEvolutionLocation(
  input: {
    organizationId: string;
    to: string;
    latitude: number;
    longitude: number;
    name?: string | null;
    credentials: ChannelCredentials;
  },
): Promise<ChannelSendResult> {
  const token = input.credentials.instanceToken;
  if (!token) {
    throw new SendChannelError(
      "not_connected",
      "No hay token de instancia de Evolution conectado",
    );
  }
  const { status, json } = await evolutionFetch("/send/location", {
    body: {
      number: evolutionRecipient(input.to),
      latitude: input.latitude,
      longitude: input.longitude,
      name: input.name ?? "",
      formatJid: true,
    },
    instanceToken: token,
  });
  if (status !== 200) {
    throw mapEvolutionError(status, json, input.organizationId);
  }
  const id = getPath(json, "data", "Info", "ID") ?? getPath(json, "data", "id");
  if (!id) {
    throw new SendChannelError(
      "channel_error",
      "Evolution no devolvió ID de la ubicación",
    );
  }
  return { waMessageId: String(id) };
}
