"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Pause, Play, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AgentState = {
  botPaused: boolean;
  ownerPhone: string;
};

/**
 * Tarjeta "Agente IA (global)": pausa/reactiva el agente para TODA la
 * farmacia y configura el teléfono autorizado a cambiarlo por WhatsApp
 * (comando AGENTE OFF/ON). Sincronizado con /api/settings/agent.
 */
export function AgentGlobalToggle() {
  const [state, setState] = useState<AgentState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");

  const refetch = useCallback(async () => {
    const res = await fetch("/api/settings/agent").catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as AgentState;
      setState(data);
      setPhoneDraft(data.ownerPhone ?? "");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function save(patch: Partial<AgentState>) {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/settings/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "No se pudo guardar");
      return false;
    }
    const data = (await res.json()) as AgentState;
    setState(data);
    setPhoneDraft(data.ownerPhone ?? "");
    return true;
  }

  async function togglePause() {
    if (!state) return;
    const ok = await save({ botPaused: !state.botPaused });
    if (ok) setEditingPhone(false);
  }

  async function savePhone() {
    const ok = await save({ ownerPhone: phoneDraft });
    if (ok) setEditingPhone(false);
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }
  if (!state) {
    return <p className="text-sm text-destructive">No se pudo cargar el estado del agente.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          Agente IA (global)
        </CardTitle>
        <CardDescription>
          Pausa o reactiva el asistente para toda la farmacia. Cuando está
          pausado, los mensajes entran a la Bandeja para atención humana y el
          agente no responde.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border p-4">
          <div className="flex items-center gap-3">
            {state.botPaused ? (
              <Pause className="h-5 w-5 text-amber-500" />
            ) : (
              <Play className="h-5 w-5 text-success" />
            )}
            <div>
              <p className="font-medium">
                {state.botPaused ? "Agente pausado" : "Agente activo"}
              </p>
              <p className="text-sm text-muted-foreground">
                {state.botPaused
                  ? "Los mensajes quedan en la Bandeja."
                  : "El asistente responde automáticamente."}
              </p>
            </div>
          </div>
          <Button
            variant={state.botPaused ? "default" : "outline"}
            disabled={saving}
            onClick={() => void togglePause()}
          >
            {state.botPaused ? "Reactivar" : "Pausar"}
          </Button>
        </div>

        <div className="rounded-md border p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Teléfono autorizado</p>
                <p className="text-sm text-muted-foreground">
                  {state.ownerPhone
                    ? `Solo ${state.ownerPhone} puede pausar/reactivar por WhatsApp (AGENTE OFF/ON).`
                    : "Sin número autorizado: el comando por WhatsApp está deshabilitado."}
                </p>
              </div>
            </div>
            {!editingPhone && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPhoneDraft(state.ownerPhone ?? "");
                  setEditingPhone(true);
                }}
              >
                {state.ownerPhone ? "Cambiar" : "Configurar"}
              </Button>
            )}
          </div>

          {editingPhone && (
            <div className="mt-3 space-y-2">
              <Label htmlFor="owner-phone">Número (formato internacional, sin +)</Label>
              <div className="flex gap-2">
                <Input
                  id="owner-phone"
                  placeholder="584128840350"
                  value={phoneDraft}
                  onChange={(e) => setPhoneDraft(e.target.value)}
                />
                <Button disabled={saving} onClick={() => void savePhone()}>
                  Guardar
                </Button>
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setEditingPhone(false)}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Badge variant={state.botPaused ? "warning" : "success"}>
            {state.botPaused ? "Pausado" : "Activo"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Sincronizado con el comando WhatsApp AGENTE OFF/ON.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
