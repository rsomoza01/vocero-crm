"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type TopMed = { term: string; consultas: number; agregados: number };

export function AnalyticsClient() {
  const [rows, setRows] = useState<TopMed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (desde) q.set("desde", desde);
    if (hasta) q.set("hasta", hasta);
    const res = await fetch(`/api/analytics/top-meds?${q.toString()}`).catch(() => null);
    setLoading(false);
    if (!res?.ok) {
      setError("No se pudo cargar la analítica.");
      return;
    }
    const data = (await res.json()) as { top?: TopMed[] };
    setRows(data.top ?? []);
  }, [desde, hasta]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = rows.reduce((s, r) => s + r.consultas, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>Rango de fechas (opcional).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="desde">Desde</Label>
            <Input id="desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hasta">Hasta</Label>
            <Input id="hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? "Cargando…" : "Aplicar"}
          </Button>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Top de medicamentos consultados</CardTitle>
          <CardDescription>{total} consultas en total.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin consultas registradas.</p>
          ) : (
            <ol className="space-y-2">
              {rows.map((r, i) => (
                <li key={r.term} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div className="flex items-center gap-3">
                    <span className="w-6 text-center font-semibold text-muted-foreground">{i + 1}</span>
                    <span className="font-medium">{r.term}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">{r.consultas} consultas</span>
                    <span className="text-muted-foreground">{r.agregados} al carrito</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
