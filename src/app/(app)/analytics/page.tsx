import { AnalyticsClient } from "@/components/analytics/analytics-client";

export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="flex h-full flex-col gap-0 p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Analítica</h1>
        <p className="text-sm text-muted-foreground">
          Medicamentos más consultados por los clientes de la farmacia.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AnalyticsClient />
      </div>
    </div>
  );
}
