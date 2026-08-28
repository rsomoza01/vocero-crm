"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Paciente = {
  wa_identity: string;
  condicion: string;
  confianza: number;
  nivel: string;
  consent: boolean;
  first_seen_at: string;
  updated_at: string;
};

const NIVEL_COLOR: Record<string, string> = {
  alto: "destructive",
  medio: "warning",
  bajo: "default",
};

export function PatientsClient() {
  const [rows, setRows] = useState<Paciente[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloConsentidos, setSoloConsentidos] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (soloConsentidos) q.set("consentidos", "1");
    const res = await fetch(`/api/analytics/chronic-patients?${q.toString()}`).catch(() => null);
    setLoading(false);
    if (!res?.ok) {
      setError("No se pudo cargar la lista de pacientes.");
      return;
    }
    const data = (await res.json()) as { pacientes?: Paciente[] };
    setRows(data.pacientes ?? []);
  }, [soloConsentidos]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{rows.length} pacientes detectados.</p>
        <Button variant="outline" size="sm" onClick={() => setSoloConsentidos((v) => !v)}>
          {soloConsentidos ? "Mostrar todos" : "Solo consentidos"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {loading ? "Cargando…" : "Sin pacientes crónicos detectados todavía."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={`${p.wa_identity}-${p.condicion}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{p.wa_identity}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={(NIVEL_COLOR[p.nivel] ?? "default") as never}>
                      {p.nivel}
                    </Badge>
                    {p.consent && <Badge variant="success">Consentido</Badge>}
                  </div>
                </div>
                <CardDescription>{p.condicion}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Confianza: {Math.round(p.confianza * 100)}% · Actualizado:{" "}
                {new Date(p.updated_at).toLocaleDateString()}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
