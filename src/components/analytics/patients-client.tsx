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
  medicamentos?: { term: string; veces: number; ultima: string | null }[];
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
              <CardContent className="space-y-3 text-sm">
                <div className="text-muted-foreground">
                  Confianza: {p.confianza} consulta{p.confianza === 1 ? "" : "s"} ·
                  Actualizado: {new Date(p.updated_at).toLocaleDateString()}
                </div>
                {p.medicamentos && p.medicamentos.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      Medicamentos consultados que sustentan la condición:
                    </p>
                    <ul className="space-y-1">
                      {p.medicamentos.map((m) => (
                        <li
                          key={m.term}
                          className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-2.5 py-1.5"
                        >
                          <span className="font-medium">{m.term}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {m.veces} consulta{m.veces === 1 ? "" : "s"}
                            {m.ultima
                              ? ` · ${new Date(m.ultima).toLocaleDateString()}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
