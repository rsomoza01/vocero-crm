"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type TopMed = { term: string; consultas: number; agregados: number };

const PAGE_SIZE = 25;

export function AnalyticsClient() {
  const [rows, setRows] = useState<TopMed[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [busqueda, setBusqueda] = useState("");

  // Los filtros que se aplicaron (los aplica el botón "Aplicar", no cada tecla).
  const [applied, setApplied] = useState({ desde: "", hasta: "", q: "" });
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const loadPage = useCallback(async (p: number, reset: boolean) => {
    if (loadingRef.current) return;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (applied.desde) q.set("desde", applied.desde);
    if (applied.hasta) q.set("hasta", applied.hasta);
    if (applied.q) q.set("q", applied.q);
    q.set("page", String(p));
    q.set("limit", String(PAGE_SIZE));
    const res = await fetch(`/api/analytics/top-meds?${q.toString()}`).catch(() => null);
    setLoading(false);
    if (!res?.ok) {
      setError("No se pudo cargar la analítica.");
      return;
    }
    const data = (await res.json()) as { top?: TopMed[]; total?: number };
    const newRows = data.top ?? [];
    const t = data.total ?? 0;
    setTotal(t);
    setPage(p);
    setHasMore(p * PAGE_SIZE < t);
    setRows((prev) => (reset ? newRows : [...prev, ...newRows]));
  }, [applied]);

  const aplicar = () => {
    setApplied({ desde, hasta, q: busqueda.trim() });
    // Reset a página 1 en el primer scroll del listado.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void loadPage(1, true);
  };

  useEffect(() => {
    void loadPage(1, true);
  }, [loadPage]);

  // Scroll infinito: IntersectionObserver sobre el marcador de fin de lista,
  // con root = contenedor scrollable (el main del AppShell tiene overflow-hidden).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sentinel = el.querySelector("[data-load-more]");
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting && hasMore && !loadingRef.current) {
          void loadPage(page + 1, false);
        }
      },
      { root: el, rootMargin: "200px" }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, page, loadPage]);

  const totalConsultas = rows.reduce((s, r) => s + r.consultas, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Filtros</CardTitle>
            <CardDescription>
              Rango de fechas y nombre de medicamento (opcional).
            </CardDescription>
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
            <div className="min-w-[200px] space-y-1">
              <Label htmlFor="term">Nombre de medicamento</Label>
              <Input
                id="term"
                type="text"
                placeholder="ej. losartan, daflon…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") aplicar();
                }}
              />
            </div>
            <Button onClick={aplicar} disabled={loading}>
              {loading ? "Cargando…" : "Aplicar"}
            </Button>
          </CardContent>
        </Card>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Card>
          <CardHeader>
            <CardTitle>Top de medicamentos consultados</CardTitle>
            <CardDescription>
              {rows.length} de {total} medicamentos · {totalConsultas} consultas en la página.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !loading ? (
          <p className="p-4 text-sm text-muted-foreground">Sin consultas registradas con esos filtros.</p>
        ) : (
          <ol className="space-y-2 p-4">
            {rows.map((r, i) => (
              <li key={r.term} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <span className="w-6 text-center font-semibold text-muted-foreground">
                    {(page - 1) * PAGE_SIZE + i + 1}
                  </span>
                  <span className="font-medium">{r.term}</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground">{r.consultas} consultas</span>
                  <span className="text-muted-foreground">{r.agregados} al carrito</span>
                </div>
              </li>
            ))}
            {loading && <li className="py-3 text-center text-sm text-muted-foreground">Cargando más…</li>}
            {!hasMore && rows.length > 0 && (
              <li className="py-3 text-center text-sm text-muted-foreground">Fin de la lista</li>
            )}
            <li data-load-more className="h-px" />
          </ol>
        )}
      </div>
    </div>
  );
}
