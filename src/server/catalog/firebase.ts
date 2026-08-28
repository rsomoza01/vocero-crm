/**
 * Catálogo de medicamentos desde Firebase Firestore (multi-tenant).
 *
 * Collections (solo lectura, service account compartida) en proyecto
 * `genteapp-cupones`:
 *   - products-providers: docs con ProviderId, ProductTitle, ProductPrice,
 *     productTitleArray (tokens pre-calculados), Available, StatusId.
 *   - provider: metadatos del proveedor (nombre).
 *   - divisabcv: tasa BCV (doc con campo DivisaBs).
 *
 * Búsqueda en 2 fases:
 *   1. Exacta (substring / prefijo de token).
 *   2. Difusa (Levenshtein) — solo el token DISTINTIVO del fármaco califica;
 *      las palabras de presentación y la marca/sal NO desbordan el resultado.
 */
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getEnv } from "@/lib/env";

export type ProductDoc = {
  id: string;
  nombre: string;
  precio: number | null;
  precioBs: number | null;
  disponible: boolean;
};

let _app: App | null = null;
let _db: Firestore | null = null;
let _tasaCache: { at: number; valor: number } | null = null;

function firestore(): Firestore | null {
  const env = getEnv();
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return null;
  }
  if (!_db) {
    if (!_app) {
      _app = initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    _db = getFirestore(_app);
  }
  return _db;
}

/** Normaliza texto para búsqueda: sin tildes, minúsculas, sin espacios extra. */
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Palabras genéricas de presentación/dosificación que NO identifican el
 * medicamento. En el matching difuso no cuentan como acierto: "MODERAN SUSP"
 * debe matchear SOLO por "moderan", no devolver todos los jarabes.
 */
const GENERIC_PRESENTACION = new Set<string>([
  "susp", "jarabe", "gotas", "gota", "crema", "unguento", "polvo",
  "tableta", "tabletas", "tab", "comprimido", "comprimidos", "capsula",
  "capsulas", "cap", "ampolla", "ampollas", "amp", "frasco", "frascos",
  "inyectable", "inyect", "solucion", "suspension", "oral", "topica",
  "topico", "pediatrico", "pediatrica", "ped", "x", "mg", "ml", "gr", "g",
  "ui", "mcg", "por", "de", "con", "y", "e", "o", "a", "el", "la", "los",
  "las", "para", "uso", "im", "iv", "comp", "tab", "sob", "sobre", "sobres",
  "blister", "unidad", "unidades", "caja", "cajas", "frasco", "vial",
  "viales", "crema", "unguento", "pomada", "gel", "locion", "lotion",
]);

/**
 * Palabras NO-DISTINTIVAS (marca/sal) que solo suman score para ordenar,
 * jamás califican un producto. "FEXOFENADINA CLORHIDRATO CALOX" debe
 * matchear por "fexofenadina", no por "calox" (que está en todos los
 * productos del laboratorio).
 */
const NO_DISTINTIVO = new Set<string>([
  "clorhidrato", "clorhidrat", "hidrocloruro", "hidroclorato", "sodico",
  "sodica", "potasico", "potasica", "calcio", "magnesio", "sulfato",
  "fosfato", "citrato", "maleato", "fumarato", "acetato", "nitrato",
  "bicarbonato", "carbonato", "genven", "calox", "biotech", "elter",
  "tiares", "valmorca", "elmor", "rowe", "vargas", "cofasa", "siegfried",
  "pharmetique", "angelus", "leti", "polinac", "fsi", "zakimed", "drotafarma",
  "hm", "kplus", "kmplus", "sante", "meyer", "ronava", "gencer", "spefar",
  "arte", "medico", "ponce", "benzo", "kimiceg", "nivea", "caloxp",
]);

/** Sinónimos de presentación: "crema" == "ungüento" (misma forma). */
const SINONIMOS_PRESENTACION: Record<string, string> = {
  crema: "crema", unguento: "crema", ungüento: "crema", pomada: "crema",
  gel: "crema", locion: "crema", loción: "crema",
  jarabe: "jarabe", susp: "susp", suspension: "susp", suspensión: "susp",
  polvo: "polvo", gotas: "gotas", gota: "gotas",
  capsula: "capsula", capsulas: "capsula", cap: "capsula",
  tableta: "tableta", tabletas: "tableta", tab: "tableta",
  comprimido: "tableta", comprimidos: "tableta",
  ampolla: "ampolla", ampollas: "ampolla", amp: "ampolla",
  vial: "vial", viales: "vial",
};

/** Distancia de Levenshtein con corte temprano (banded) para términos cortos. */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const up = prev[j]! + 1;
      const left = cur[j - 1]! + 1;
      const diag = prev[j - 1]! + cost;
      cur[j] = Math.min(up, left, diag);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Tasa BCV (Bs por USD) con cache de 30 min. */
async function tasaBcv(): Promise<number> {
  if (_tasaCache && Date.now() - _tasaCache.at < 30 * 60 * 1000) {
    return _tasaCache.valor;
  }
  const store = firestore();
  if (!store) return 0;
  try {
    const snap = await store.collection("divisabcv").limit(1).get();
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const v = Number(d.DivisaBs ?? d.tasa ?? d.valor ?? 0);
      if (v > 0) {
        _tasaCache = { at: Date.now(), valor: v };
        return v;
      }
    }
  } catch (e) {
    console.warn("[catalog/firebase] no se pudo leer la tasa BCV:", e);
  }
  return 0;
}

function mapProduct(id: string, d: Record<string, unknown>): ProductDoc {
  const precio = Number(d.ProductPrice ?? d.price ?? 0) || null;
  return {
    id,
    nombre: String(d.ProductTitle ?? d.title ?? d.name ?? ""),
    precio,
    precioBs: null,
    disponible: d.Available !== false && d.StatusId !== "0",
  };
}

/**
 * Busca productos del provider. Devuelve la lista canónica (precio ascendente)
 * con precio Bs calculado. Fase 1 exacta; si no hay resultados, fase 2 difusa
 * exigiendo que el token DISTINTIVO del fármaco matchee.
 */
export async function searchProducts(
  providerId: string,
  q: string,
  limit = 20
): Promise<ProductDoc[]> {
  const store = firestore();
  if (!store) return [];
  const term = normalize(q);
  const tasa = await tasaBcv();
  const snap = await store
    .collection(getEnv().FIREBASE_COLLECTION_PRODUCTS)
    .where("ProviderId", "==", providerId)
    .limit(5000)
    .get();

  const exact: ProductDoc[] = [];
  const fuzzy: { p: ProductDoc; score: number }[] = [];
  // Tokens de la consulta separados en DISTINTIVOS (el fármaco) y
  // NO-DISTINTIVOS (marca/sal). "FEXOFENADINA CLORHIDRATO CALOX" →
  // distintivos: [fexofenadina], no-distintivos: [clorhidrato, calox].
  const termTokens = term
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_PRESENTACION.has(t));
  const distintivos = termTokens.filter((t) => !NO_DISTINTIVO.has(t));
  const noDistintivos = termTokens.filter((t) => NO_DISTINTIVO.has(t));

  for (const doc of snap.docs) {
    const p = mapProduct(doc.id, doc.data() as Record<string, unknown>);
    const hay = normalize(p.nombre);
    if (!hay) continue;
    const hayTokens = hay.split(/\s+/);

    // Fase 1: exacto (substring o prefijo de token).
    if (hay.includes(term) || hayTokens.some((t) => t.startsWith(term))) {
      exact.push(p);
      continue;
    }

    // Fase 2: difuso. Requiere que al menos un token DISTINTIVO matchee.
    if (distintivos.length === 0) continue;
    let score = 0;
    let matchedDistintivo = false;
    for (const qt of distintivos) {
      const maxD = qt.length <= 6 ? 1 : 2;
      for (const ht of hayTokens) {
        if (ht.length < 3) continue;
        if (levenshtein(qt, ht, maxD) <= maxD) {
          score += 1;
          matchedDistintivo = true;
          break;
        }
      }
    }
    if (!matchedDistintivo) continue;
    // Los no-distintivos (marca/sal) suman score para ordenar, no califican.
    for (const qt of noDistintivos) {
      if (hay.includes(qt)) score += 0.5;
    }
    // Sinónimo de presentación: si la consulta pide "crema" y el producto
    // tiene "ungüento" (misma forma), suma acierto.
    for (const qt of termTokens) {
      const canon = SINONIMOS_PRESENTACION[qt];
      if (canon && hayTokens.some((ht) => SINONIMOS_PRESENTACION[ht] === canon)) {
        score += 0.5;
      }
    }
    fuzzy.push({ p, score });
  }

  let out: ProductDoc[];
  if (exact.length) {
    out = exact;
  } else if (fuzzy.length) {
    fuzzy.sort((a, b) => b.score - a.score || (a.p.precio ?? Infinity) - (b.p.precio ?? Infinity));
    out = fuzzy.map((f) => f.p);
  } else {
    out = [];
  }

  // Orden canónico: precio ascendente + calcular Bs = USD × tasa.
  out.sort((a, b) => (a.precio ?? Infinity) - (b.precio ?? Infinity));
  for (const p of out) {
    if (p.precio != null && tasa > 0) p.precioBs = Math.round(p.precio * tasa * 100) / 100;
  }
  return out.slice(0, limit);
}

/** Nombre del proveedor (para el encabezado de la respuesta). */
export async function getProviderInfo(providerId: string): Promise<{ name: string } | null> {
  const store = firestore();
  if (!store) return null;
  try {
    const env = getEnv();
    const doc = await store.collection(env.FIREBASE_COLLECTION_PROVIDERS).doc(providerId).get();
    if (!doc.exists) return null;
    const d = doc.data() as Record<string, unknown>;
    return { name: String(d.name ?? d.Name ?? d.nombre ?? "") };
  } catch {
    return null;
  }
}
