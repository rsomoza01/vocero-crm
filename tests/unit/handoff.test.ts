import { describe, expect, it, afterEach } from "vitest";
import { corteHandoffManual, handoffManualExpirado, handoffManualTtlHoras } from "@/server/inbox/handoff";

/**
 * Caso real (providerId 05, 2026-11-06): 28 conversaciones pausadas con
 * `manual_reply` y ninguna volvía al agente. El cliente escribía días después y
 * el mensaje se quedaba en la bandeja.
 */

const AHORA = new Date("2026-11-06T15:00:00.000Z");

function pausada(horasAtras: number, reason: string | null = "manual_reply") {
  return {
    id: "cv_test",
    aiEnabled: false,
    handoffAt: new Date(AHORA.getTime() - horasAtras * 3600_000),
    handoffReason: reason,
  };
}

afterEach(() => {
  delete process.env.HANDOFF_MANUAL_TTL_HOURS;
});

describe("TTL del handoff por respuesta manual", () => {
  it("por defecto son 24 h", () => {
    expect(handoffManualTtlHoras()).toBe(24);
  });

  it("se puede configurar por entorno", () => {
    process.env.HANDOFF_MANUAL_TTL_HOURS = "6";
    expect(handoffManualTtlHoras()).toBe(6);
  });

  it("un valor inválido cae al default", () => {
    process.env.HANDOFF_MANUAL_TTL_HOURS = "no-es-un-numero";
    expect(handoffManualTtlHoras()).toBe(24);
    process.env.HANDOFF_MANUAL_TTL_HOURS = "0";
    expect(handoffManualTtlHoras()).toBe(24);
  });

  it("el corte queda TTL horas atrás", () => {
    const corte = corteHandoffManual(AHORA);
    expect(AHORA.getTime() - corte.getTime()).toBe(24 * 3600_000);
  });
});

describe("handoffManualExpirado", () => {
  it("libera a las 25 h", () => {
    expect(handoffManualExpirado(pausada(25), AHORA)).toBe(true);
  });

  it("NO libera a las 23 h", () => {
    expect(handoffManualExpirado(pausada(23), AHORA)).toBe(false);
  });

  it("justo en el TTL ya libera", () => {
    expect(handoffManualExpirado(pausada(24), AHORA)).toBe(true);
  });

  it("una conversación activa nunca se toca", () => {
    expect(
      handoffManualExpirado(
        { id: "cv", aiEnabled: true, handoffAt: null, handoffReason: null },
        AHORA
      )
    ).toBe(false);
  });

  it("no toca los otros motivos de handoff", () => {
    for (const motivo of [
      "cliente",
      "hostilidad",
      "medicamento_no_disponible",
      "modelo",
      "error",
    ]) {
      expect(handoffManualExpirado(pausada(100, motivo), AHORA)).toBe(false);
    }
  });

  it("pausada sin fecha de handoff no se libera (no hay de dónde contar)", () => {
    expect(
      handoffManualExpirado(
        { id: "cv", aiEnabled: false, handoffAt: null, handoffReason: "manual_reply" },
        AHORA
      )
    ).toBe(false);
  });
});
