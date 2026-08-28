import { PatientsClient } from "@/components/analytics/patients-client";

export const dynamic = "force-dynamic";

export default function PatientsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Pacientes</h1>
        <p className="text-sm text-muted-foreground">
          Pacientes con condición crónica detectada por consultas repetidas de
          medicamentos.
        </p>
      </div>
      <PatientsClient />
    </div>
  );
}
