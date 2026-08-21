import { cert, getApps, initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { getEnv } from "@/lib/env";

/**
 * Cliente Firestore para el catálogo de medicamentos/precios.
 *
 * SOLO LECTURA (Constitución I): nunca se escribe, actualiza ni borra en Firebase.
 * Inicialización lazy: no hay credenciales durante `next build`; el primer uso
 * en runtime inicializa la app. Si faltan credenciales, responde `null` para
 * que el endpoint devuelva 503 (firebase_unavailable).
 *
 * Las credenciales viven en env (service account de solo lectura compartida).
 */

export interface CatalogProduct {
  productId: string;
  producto: string;
  generico: string;
  presentacion: string;
  laboratorio: string;
  precio: number;
  disponible: boolean;
  requiereReceta: boolean;
}

export interface ProviderInfo {
  providerId: string;
  nombre: string;
  direccion: string;
  horario: string;
  ciudad: string;
  location?: { lat: number; lng: number } | null;
}

/** true si las credenciales de Firebase están presentes. */
export function isFirebaseConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.FIREBASE_PROJECT_ID &&
      env.FIREBASE_CLIENT_EMAIL &&
      env.FIREBASE_PRIVATE_KEY
  );
}

/** Inicializa (lazy) la app de Firebase y devuelve Firestore, o null si no está configurado. */
function getFirestoreClient() {
  if (!isFirebaseConfigured()) return null;
  const env = getEnv();
  const apps = getApps();
  if (apps.length === 0) {
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: (env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

/** Devuelve Firestore inicializado o lanza si no está configurado. */
function firestore(): Firestore {
  const fs = getFirestoreClient();
  if (!fs) {
    throw new Error("Firebase no está configurado");
  }
  return fs;
}

/** Convierte un documento de Firestore (products-providers) al DTO de catálogo. */
function mapProductDoc(doc: {
  id: string;
  providerId?: string;
  nombreProducto?: string;
  nombreGenerico?: string;
  presentacion?: string;
  laboratorio?: string;
  precio?: number | string;
  disponibilidad?: number | boolean | string;
  requiereReceta?: boolean;
}): CatalogProduct {
  const precio =
    typeof doc.precio === "string"
      ? Number(String(doc.precio).replace(",", "."))
      : typeof doc.precio === "number"
        ? doc.precio
        : null;
  const disponible =
    doc.disponibilidad === true ||
    (typeof doc.disponibilidad === "number" && doc.disponibilidad > 0) ||
    (typeof doc.disponibilidad === "string" &&
      ["si", "yes", "disponible", "true"].includes(
        doc.disponibilidad.toLowerCase()
      ));
  return {
    productId: doc.id,
    producto: doc.nombreProducto || "",
    generico: doc.nombreGenerico || "",
    presentacion: doc.presentacion || "",
    laboratorio: doc.laboratorio || "",
    precio: precio ?? 0,
    disponible: Boolean(disponible),
    requiereReceta: Boolean(doc.requiereReceta),
  };
}

/** Consulta el catálogo de un provider, con filtro opcional de texto. */
export async function getProductsByProvider(
  providerId: string,
  q?: string,
  limit = 10
): Promise<CatalogProduct[]> {
  const fs = firestore();
  const env = getEnv();
  const coll = env.FIREBASE_COLLECTION_PRODUCTS;
  const snap = await fs
    .collection(coll)
    .where("providerId", "==", providerId)
    .limit(500)
    .get();
  const query = (q || "").toLowerCase().trim();
  let products = snap.docs.map((d) =>
    mapProductDoc({ ...(d.data() as object), id: d.id })
  );
  if (query) {
    products = products.filter(
      (p) =>
        p.producto.toLowerCase().includes(query) ||
        p.generico.toLowerCase().includes(query)
    );
  }
  return products.slice(0, limit);
}

/** Devuelve la info de un provider (farmacia). */
export async function getProviderInfo(
  providerId: string
): Promise<ProviderInfo | null> {
  const fs = firestore();
  const env = getEnv();
  const coll = env.FIREBASE_COLLECTION_PROVIDERS;
  const snap = await fs.collection(coll).where("providerId", "==", providerId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  if (!doc) return null;
  const data = doc.data() as Record<string, unknown>;
  return {
    providerId: (data.providerId as string) || providerId,
    nombre: (data.nombre as string) || (data.name as string) || "",
    direccion: (data.direccion as string) || "",
    horario: (data.horario as string) || "",
    ciudad: (data.ciudad as string) || "",
    location: (data.location as ProviderInfo["location"]) || null,
  };
}
