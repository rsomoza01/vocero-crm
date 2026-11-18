import { describe, expect, it } from "vitest";
import { normalizarTelefonoVE } from "@/app/api/bot/notify/route";

describe("normalizarTelefonoVE", () => {
  it("convierte el 0 local a 58", () => {
    expect(normalizarTelefonoVE("04249172943")).toBe("584249172943");
  });
  it("limpia espacios y guiones", () => {
    expect(normalizarTelefonoVE("0424 9578845")).toBe("584249578845");
  });
  it("añade 58 cuando viene sin 0 ni país", () => {
    expect(normalizarTelefonoVE("4249172943")).toBe("584249172943");
  });
  it("deja igual lo que ya trae país", () => {
    expect(normalizarTelefonoVE("584249172943")).toBe("584249172943");
    expect(normalizarTelefonoVE("+58 424-9172943")).toBe("584249172943");
  });
  it("rechaza lo que no es un número usable", () => {
    expect(normalizarTelefonoVE("123")).toBeNull();
    expect(normalizarTelefonoVE("")).toBeNull();
    expect(normalizarTelefonoVE("abc")).toBeNull();
  });
});
