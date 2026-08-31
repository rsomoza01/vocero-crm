"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [farmacia, setFarmacia] = useState("");
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          farmacia: farmacia.trim() || undefined,
          providerId: providerId.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        redirectTo?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? "No se pudo crear la cuenta.");
        setLoading(false);
        return;
      }
      router.push(data?.redirectTo ?? "/inbox");
      router.refresh();
    } catch {
      setError("No se pudo crear la cuenta.");
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crear cuenta</CardTitle>
        <CardDescription>
          Cada registro crea una organización nueva para tu farmacia y te deja
          como propietario.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Tu nombre</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Correo</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="farmacia">Nombre de la farmacia</Label>
            <Input
              id="farmacia"
              placeholder="ej. Farma Union Plus"
              value={farmacia}
              onChange={(e) => setFarmacia(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="providerId">ID de proveedor (catálogo)</Label>
            <Input
              id="providerId"
              placeholder="ej. 19"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creando…" : "Crear cuenta"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            ¿Ya tienes cuenta?{" "}
            <Link href="/login" className="text-primary hover:underline">
              Inicia sesión
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
