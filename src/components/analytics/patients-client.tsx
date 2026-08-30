"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhone } from "@/lib/utils";

type Medicamento = { term: string; veces: number; ultima: string | null };

type Paciente = {
  wa_identity: string;
  condicion: string;
  confianza: number;
  nivel: string;
  consent: boolean;
  first_seen_at: string;
  updated_at: string;
  medicamentos?: Medicamento[];
  nombre?: string;
  telefono?: string | null;
};

const NIVEL_COLOR: Record<string, string> = {
  alto: "destructive",
  medio: "warning",
  bajo: "default",
};

const PAGE_SIZE = 20;

export function PatientsClient() {
  const [rows, setRows] = useState<Paciente[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloConsentidos, setSoloConsentidos] = useState(false);

  // Filtros
  const [query, setQuery] = useState("");
  const [condicion, setCondicion] = useState("");
  const [condiciones, setCondiciones] = useState<string[]>([]);

  // Paginación por scroll infinito
  const [hasMore, setHasMore] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const pageRef = useRef(1);
  const filtersRef = useRef({ query: "", condicion: "", soloConsentidos: false });

  // Cargar las condiciones disponibles (para el filtro) una vez.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/analytics/chronic-patients?limit=1").catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json()) as { pacientes?: Paciente[] };
      const conds = new Set<string>();
      for (const p of data.pacientes ?? []) conds.add(p.condicion);
      setCondiciones([...conds]);
    })();
  }, []);

  const loadPage = useCallback(
    async (pageNum: number, replace: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      const f = filtersRef.current;
      const q = new URLSearchParams();
      q.set("page", String(pageNum));
      q.set("limit", String(PAGE_SIZE));
      if (f.query.trim()) q.set("q", f.query.trim());
      if (f.condicion) q.set("condicion", f.condicion);
      if (f.soloConsentidos) q.set("consentidos", "1");
      const res = await fetch(`/api/analytics/chronic-patients?${q.toString()}`).catch(() => null);
      loadingRef.current = false;
      setLoading(false);
      if (!res?.ok) {
        setError("No se pudo cargar la lista de pacientes.");
        return;
      }
      const data = (await res.json()) as { pacientes?: Paciente[]; total?: number };
      const nuevos = data.pacientes ?? [];
      setTotal(data.total ?? 0);
      setRows((prev) => (replace ? nuevos : [...prev, ...nuevos]));
      setHasMore((data.total ?? nuevos.length) > pageNum * PAGE_SIZE);
    },
    []
  );

  // Resetear y cargar página 1 cuando cambian los filtros.
  useEffect(() => {
    filtersRef.current = { query, condicion, soloConsentidos };
    pageRef.current = 1;
    setRows([]);
    setHasMore(true);
    void loadPage(1, true);
  }, [query, condicion, soloConsentidos, loadPage]);

  // Scroll infinito: IntersectionObserver sobre el centinela, con root = el
  // contenedor de scroll interno (el <main> del AppShell tiene overflow-hidden,
  // así que el scroll ocurre aquí, no en el viewport).
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasMore && !loadingRef.current) {
          const next = pageRef.current + 1;
          pageRef.current = next;
          void loadPage(next, false);
        }
      },
      { root, rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadPage]);

  return (
    <div className="flex h-full flex-col">
      {/* Filtros (fijos arriba) */}
      <div className="shrink-0 border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="q">Nombre o teléfono</Label>
            <Input
              id="q"
              placeholder="Buscar…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="condicion">Condición</Label>
            <select
              id="condicion"
              value={condicion}
              onChange={(e) => setCondicion(e.target.value)}
              className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">Todas</option>
              {condiciones.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSoloConsentidos((v) => !v)}
          >
            {soloConsentidos ? "Mostrar todos" : "Solo consentidos"}
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total} pacientes detectados.
          </p>
          {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {/* Listado con scroll interno */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {rows.length === 0 && !loading ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">
                {query || condicion
                  ? "Sin pacientes que coincidan con los filtros."
                  : "Sin pacientes crónicos detectados todavía."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {rows.map((p) => (
              <Card key={`${p.wa_identity}-${p.condicion}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">
                      {p.nombre ?? p.wa_identity}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant={(NIVEL_COLOR[p.nivel] ?? "default") as never}>
                        {p.nivel}
                      </Badge>
                      {p.consent && <Badge variant="success">Consentido</Badge>}
                    </div>
                  </div>
                  <CardDescription>
                    {p.condicion}
                    {p.telefono ? ` · ${formatPhone(p.telefono)}` : ""}
                  </CardDescription>
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
            {/* Centinela para scroll infinito */}
            <div ref={sentinelRef} className="h-1" />
            {loading && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Cargando más…
              </p>
            )}
            {!hasMore && rows.length > 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Fin de la lista.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
