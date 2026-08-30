import { PatientsClient } from "@/components/analytics/patients-client";

export const dynamic = "force-dynamic";

export default function PatientsPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-3 sm:px-6">
        <h1 className="text-2xl font-semibold">Pacientes</h1>
        <p className="text-sm text-muted-foreground">
          Pacientes con condición crónica detectada por consultas repetidas de
          medicamentos.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <PatientsClient />
      </div>
    </div>
  );
}
