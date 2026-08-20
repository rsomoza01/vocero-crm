/**
 * Canal de WhatsApp — frontera única de salida (Constitución II).
 *
 * Vocero soporta dos proveedores:
 *  - "meta"      : WhatsApp Business Cloud API (Graph API de Meta).
 *  - "evolution" : Evolution GO / Evolution API (número personal, sin 24h).
 *
 * Este módulo resuelve el canal por organización (CHANNEL_PROVIDER global) y
 * expone sendText/sendMedia con un contrato común. Cada implementación traduce
 * sus errores a un SendChannelError con code tipado.
 */
import { getEnv } from "@/lib/env";

export type ChannelProvider = "meta" | "evolution";

export class SendChannelError extends Error {
  code:
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    | "channel_error"
    | "channel_unavailable"
    | "upload_failed";
  constructor(
    code: SendChannelError["code"],
    message: string,
    public readonly messageId?: string,
  ) {
    super(message);
    this.name = "SendChannelError";
    this.code = code;
  }
}

export interface SendTextInput {
  organizationId: string;
  to: string; // destinatario ya normalizado (solo dígitos, sin @s.whatsapp.net)
  text: string;
  credentials: ChannelCredentials;
}

export interface SendMediaInput {
  organizationId: string;
  to: string;
  kind: "image" | "video" | "audio" | "document";
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string | null;
  credentials: ChannelCredentials;
}

export type ChannelSendResult = { waMessageId: string };

/** Credenciales genéricas del canal resueltas para una organización. */
export type ChannelCredentials = {
  provider: ChannelProvider;
  // meta
  phoneNumberId?: string;
  token?: string;
  // evolution
  instanceToken?: string;
};

export function channelEnabled(): boolean {
  return getEnv().CHANNEL_PROVIDER === "evolution" || !!getEnv().META_GRAPH_BASE_URL;
}
