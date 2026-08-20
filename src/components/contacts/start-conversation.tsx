"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Cuenta {{1}}..{{n}} igual que el servidor, para pedir sus valores. */
function countVariables(body: string): number {
  const found = new Set(
    Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => m[1])
  );
  return found.size;
}

/**
 * Abrir conversación con quien nunca ha escrito.
 *
 * WhatsApp obliga a usar una plantilla aprobada para escribir primero; no es
 * una decisión del CRM. Si la ventana de 24 h está abierta, este panel ni se
 * muestra: gastar una plantilla ahí sería tirar dinero.
 */
export function StartConversation({
  contactId,
  onStarted,
}: {
  contactId: string;
  onStarted: (conversationId: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [vars, setVars] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Canal activo. "evolution" (WhatsApp Web) permite texto libre sin plantilla.
  const [channel, setChannel] = useState<"meta" | "evolution" | null>(null);
  const [textoLibre, setTextoLibre] = useState("");

  useEffect(() => {
    void (async () => {
      // Canal: meta o evolution. Si falla, se asume meta (comportamiento clásico).
      const cfg = await fetch("/api/settings/whatsapp")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const provider = cfg?.channel === "evolution" ? "evolution" : "meta";
      setChannel(provider);

      if (provider === "evolution") {
        // Evolution no usa plantillas: se escribe texto libre directamente.
        setTemplates([]);
        return;
      }

      const res = await fetch("/api/templates").catch(() => null);
      if (!res?.ok) return setTemplates([]);
      const data = (await res.json()) as { templates: TemplateDto[] };
      const aprobadas = data.templates.filter((t) => t.status === "approved");
      setTemplates(aprobadas);
      setTemplateId(aprobadas[0]?.id ?? "");
    })();
  }, []);

  const elegida = templates?.find((t) => t.id === templateId) ?? null;
  const nVars = elegida ? countVariables(elegida.body) : 0;

  async function enviar() {
    setEnviando(true);
    setError(null);
    const body = JSON.stringify(
      channel === "evolution"
        ? { kind: "text", text: textoLibre }
        : {
            kind: "template",
            templateId,
            variables: nVars > 0 ? vars.slice(0, nVars) : undefined,
          }
    );
    const res = await fetch(`/api/contacts/${contactId}/start-conversation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => null);
    setEnviando(false);
    const data = (await res?.json().catch(() => null)) as
      | { error?: { message?: string }; conversationId?: string }
      | null;
    if (!res?.ok) {
      // El fallo se explica aquí mismo en vez de perderse.
      setError(data?.error?.message ?? "No se pudo iniciar la conversación");
      return;
    }
    onStarted(data?.conversationId ?? "");
  }

  // Canal Evolution: texto libre sin plantilla (WhatsApp Web no lo restringe).
  if (channel === "evolution") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-text-3">
          Este contacto nunca te ha escrito. En el canal Evolution (WhatsApp
          Web) puedes escribirle texto libre directamente.
        </p>
        <textarea
          value={textoLibre}
          aria-label="Mensaje inicial"
          rows={3}
          placeholder="Escribe tu primer mensaje…"
          className="h-auto w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-soft"
          onChange={(e) => setTextoLibre(e.target.value)}
        />
        <Button
          size="sm"
          disabled={enviando || !textoLibre.trim()}
          onClick={() => void enviar()}
        >
          <Send className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.7} />
          {enviando ? "Enviando…" : "Enviar mensaje"}
        </Button>
        {error && <p className="text-xs text-danger-text">{error}</p>}
      </div>
    );
  }

  if (templates === null) {
    return <p className="text-xs text-text-3">Cargando plantillas…</p>;
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-secondary/30 px-3 py-2.5">
        <p className="text-[13px]">
          Esta persona nunca te ha escrito, así que WhatsApp solo permite
          contactarla con una <strong>plantilla aprobada</strong>, y todavía no
          tienes ninguna.
        </p>
        <Link href="/settings/templates">
          <Button size="sm" variant="secondary" className="mt-2">
            Ir a plantillas
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-3">
        Nunca te ha escrito: para iniciar hay que usar una plantilla aprobada.
      </p>
      <select
        value={templateId}
        onChange={(e) => {
          setTemplateId(e.target.value);
          setVars([]);
        }}
        aria-label="Plantilla para iniciar"
        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
      >
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.language})
          </option>
        ))}
      </select>

      {elegida && (
        <p className="rounded-md border bg-secondary/40 px-3 py-2 text-[12px] text-text-2">
          {elegida.body}
        </p>
      )}

      {Array.from({ length: nVars }, (_, i) => (
        <Input
          key={i}
          value={vars[i] ?? ""}
          aria-label={`Valor de la variable ${i + 1}`}
          placeholder={`Valor de {{${i + 1}}}`}
          onChange={(e) => {
            const next = [...vars];
            next[i] = e.target.value;
            setVars(next);
          }}
        />
      ))}

      <Button
        size="sm"
        disabled={enviando || !templateId || vars.slice(0, nVars).some((v) => !v?.trim())}
        onClick={() => void enviar()}
      >
        <Send className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.7} />
        {enviando ? "Enviando…" : "Iniciar conversación"}
      </Button>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </div>
  );
}
