import { AnalyticsClient } from "@/components/analytics/analytics-client";

export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Analítica</h1>
        <p className="text-sm text-muted-foreground">
          Medicamentos más consultados por los clientes de la farmacia.
        </p>
      </div>
      <AnalyticsClient />
    </div>
  );
}
