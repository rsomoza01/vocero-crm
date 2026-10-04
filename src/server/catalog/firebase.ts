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

/**
 * Accesorios/insumos genéricos que aparecen en cientos de productos (jeringas,
 * agujas, hisopos, agua, guantes...). En la fase difusa NO deben calificar un
 * producto si la consulta trae además un token de FÁRMACO: "vicryl aguja
 * cortante curva" debe matchear por "vicryl", no por "aguja" (que desborda la
 * lista con jeringas/agua oxigenada). Solo califican cuando la consulta es
 * EXCLUSIVAMENTE de accesorios (p. ej. "jeringa 10ml").
 */
const ACCESORIO = new Set<string>([
  "aguja", "agujas", "jeringa", "jeringas", "hisopo", "hisopos", "algodon",
  "algodón", "gasa", "gasas", "venda", "vendas", "esparadrapo", "guante",
  "guantes", "mascarilla", "mascarillas", "tapaboca", "barbijo", "agua",
  "suerofisiologico", "suero", "sonda", "sondas", "cateter", "cateteres",
  "catéter", "catéteres", "torniquete", "bajalengua", "bajalenguas",
  "cotonete", "cotonetes", "torunda", "torundas", "aposito", "apósitos",
  "apositos", "cura", "curitas", "banda", "bandas", "tela", "telas",
  "tijera", "tijeras", "pinza", "pinzas", "fórceps", "forceps", "bisturi",
  "bisturí", "lanceta", "lancetas", "termometro", "termómetro",
  "tensiómetro", "tensiometro", "glucometro", "glucómetro", "oximetro",
  "oxímetro", "nebulizador", "inhalador", "cánula", "canula", "cánulas",
  "canulas", "manguera", "mangueras", "bolsa", "bolsas", "frasco", "frascos",
  "envase", "envases", "recipiente", "recipientes", "vaso", "vasos", "copa",
  "copas", "pajilla", "pajillas", "popote", "popotes", "servilleta",
  "servilletas", "toalla", "toallas", "papel", "papeles", "toallita",
  "toallitas", "pañal", "pañales", "panal", "panales", "esponja", "esponjas",
  "cepillo", "cepillos", "peine", "peines", "cortauñas", "lima", "limas",
  "espejo", "espejos", "lupa", "lupas", "gotero", "goteros", "cuentagotas",
  "pomada", "pomadas", "unguento", "ungüento", "crema", "cremas", "gel",
  "geles", "locion", "loción", "lociones", "shampoo", "shampú", "jabon",
  "jabón", "jabones", "desinfectante", "desinfectantes", "alcohol",
  "alcoholes", "peroxido", "peróxido", "yodo", "povidona", "clorhexidina",
  "merthiolate", "mercurocromo", "aguaoxigenada", "oxigenada", "oxigenado",
  "aguas", "heleal", "elplacer", "guardian", "alna", "toomey", "grossmed",
  "sumedical", "alphapharm", "alpha", "pharm", "im", "iv", "sc", "id", "ev",
  "subcutanea", "subcutánea", "intramuscular", "intravenosa", "intradermica",
  "intradérmica", "cortante", "cortantes", "curva", "curvas", "recta", "rectas",
  "redonda", "redondas", "triangular", "triangulares", "sh", "ct", "ct1",
  "ct-1", "sh26", "sh26mm", "26mm", "36mm", "35mm", "37mm", "40mm", "45mm",
  "50mm", "mm", "cm", "m", "metros", "centimetros", "centímetros",
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

/**
 * Marcadores de presentación TAL COMO aparecen en el catálogo (en el nombre del
 * producto). El cliente pide "tabletas" / "jarabe" y el catálogo escribe
 * "TAB" / "JAB" / "JABE" / "COMP" / "SOB".
 *
 * OJO con `JAB`: significa **jarabe** en catálogos que usan "JAB X 120 ML"
 * (jarabe con dosis por volumen, típico de un laboratorio venezolano) pero es
 * **jabón** cuando va pegado a "ON" o con punto ("JABON", "JAB.YODADO"). Por eso
 * los tokens se extraen del nombre con `tokensPresentacion()`, que normaliza el
 * punto y descarta el sufijo "ON" de jabón. Sin esa desambiguación, pedir
 * "jarabe" devolvería jabones y "tabletas" sería ruido puro.
 */
const MARCADOR_PRESENTACION: Record<string, string[]> = {
  tableta: ["tab", "tabl", "tabla", "tableta", "tabletas", "comp", "compred",
            "comprimido", "comprimidos", "grag", "gragea", "rec", "recubierto",
            "blister"],
  capsula: ["cap", "caps", "capsula", "capsulas", "cps"],
  jarabe: ["jab", "jabe", "jbe", "jarabe", "jarabes"],
  susp: ["susp", "suspension"],
  sobre: ["sob", "sobre", "sobres", "sachet", "granulado"],
  gotas: ["gota", "gotas", "gotero"],
  crema: ["crema", "cremas", "unguento", "pomada", "gel", "locion", "loción"],
  inyectable: ["amp", "ampolla", "ampollas", "vial", "viales", "inyect",
               "inyectable"],
};

/**
 * Presentaciones que NO son jarabe aunque declaren volumen. Un inyectable
 * ("CLEXANE 20 MG / 0.2 ML X 2 AMP"), una crema o un champú llevan ml/cc pero
 * jamás son el jarabe que pide un cliente.
 */
const NO_ES_JARABE = new Set([
  "amp", "ampolla", "ampollas", "vial", "viales", "inyect", "inyectable",
  "crema", "cremas", "unguento", "pomada", "gel", "locion", "jabon",
  "shamp", "shampoo", "spray", "colirio", "ovulo", "ovulos", "supos",
  "supositorio", "supositorios", "inhalacion", "inhalador", "aerosol",
  "nasal", "oftalmica", "otica", "enema", "lavado",
]);

/**
 * Tokens de presentación de un nombre, ya desambiguados. "TAB" → ["tab"],
 * "JAB.X 120 ML" → ["jab"] (jarabe), "JABON" / "JAB.YODADO" → ["jabon"]
 * (jabón, que NO es una forma farmacéutica de presentación).
 */
function tokensPresentacion(nombre: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(nombre).split(/[\s.,/()-]+/)) {
    // Quitar el punto pegado ("JAB.X" → "jabx", "JAB." → "jab").
    const t = raw.replace(/[^a-z0-9]/g, "");
    if (!t) continue;
    // Desambiguar jabón: "jabon", "jabx", "jab.yodado" empiezan con jab pero no
    // son jarabe. El jarabe real es "jab" solo o "jabe"/"jbe".
    if (t.startsWith("jab") && t !== "jab" && t !== "jabe" && t !== "jbe") {
      out.push("jabon");
      continue;
    }
    out.push(t);
  }
  return out;
}

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
  const fuzzyAll: { p: ProductDoc; score: number }[] = [];
  const fuzzyAny: { p: ProductDoc; score: number }[] = [];
  // Tokens de la consulta separados en DISTINTIVOS (el fármaco) y
  // NO-DISTINTIVOS (marca/sal). "FEXOFENADINA CLORHIDRATO CALOX" →
  // distintivos: [fexofenadina], no-distintivos: [clorhidrato, calox].
  const termTokens = term
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_PRESENTACION.has(t));
  // Los números (dosis "300", "500") NO califican en la fase difusa: por
  // Levenshtein "300" matchea con "500"/"100"/"400" e inunda de productos
  // irrelevantes. Solo matchean en la fase exacta (substring), p. ej.
  // "esoz 40" → "esoz 40mg". Se excluyen de distintivos y noDistintivos.
  // IMPORTANTE: cubre también "40mg"/"5mg"/"10mg" (número+unidad pegados),
  // no solo dígitos puros — "40mg" por Levenshtein matchea "10mg"/"50mg"/"400mg"
  // y desbordaba la respuesta con 20 irrelevantes (pandoprazol 40mg → AMLODIPINA).
  const esNumero = (t: string) => /\d/.test(t);
  const distintivos = termTokens.filter((t) => !NO_DISTINTIVO.has(t) && !esNumero(t));
  const noDistintivos = termTokens.filter((t) => NO_DISTINTIVO.has(t) && !esNumero(t));
  // Tokens de ACCESORIO (jeringa, aguja, hisopo, agua...). En la fase difusa
  // NO califican un producto si la consulta trae además un token de FÁRMACO:
  // "vicryl aguja cortante curva" debe matchear por "vicryl", no por "aguja"
  // (que desborda la lista con jeringas/agua oxigenada). Solo califican cuando
  // la consulta es EXCLUSIVAMENTE de accesorios (p. ej. "jeringa 10ml").
  const accesorios = termTokens.filter((t) => ACCESORIO.has(t) && !esNumero(t));
  // Tokens de fármaco = distintivos que NO son accesorios.
  const farmacos = distintivos.filter((t) => !ACCESORIO.has(t));

  // PRESENTACIÓN pedida por el cliente: "tabletas", "jarabe", "capsulas",
  // "sobre"... Se resuelve a la forma canónica vía SINONIMOS_PRESENTACION.
  // Es un FILTRO DURO (no solo score): cuando el cliente pide una presentación,
  // solo se devuelven productos con ESA forma — así, si un medicamento existe en
  // tabletas Y en jarabe, pedir "tabletas" muestra únicamente la tableta.
  // Si el filtro deja la lista vacía se cae al comportamiento normal (nunca
  // esconder el medicamento por un marcador que el catálogo no usa).
  const presionadas = new Set<string>();
  for (const t of term.split(/\s+/)) {
    const canon = SINONIMOS_PRESENTACION[t];
    if (canon) presionadas.add(canon);
  }
  const quierePresentacion = presionadas.size > 0;
  // Tokens de la consulta que son PRESENTACIÓN (tableta, jarabe, cap...). Nunca
  // deben calificar un producto en la fase difusa: por Levenshtein "tab"≈"cap"
  // y "jarabe"≈"jaraba" metían cápsulas/ruido en una consulta de tabletas.
  const presentacionTokensQuery = new Set<string>();
  for (const canon of presionadas) {
    presentacionTokensQuery.add(canon);
    for (const [k, v] of Object.entries(SINONIMOS_PRESENTACION)) {
      if (v === canon) presentacionTokensQuery.add(k);
    }
    for (const m of MARCADOR_PRESENTACION[canon] ?? []) {
      presentacionTokensQuery.add(m);
    }
  }
  /**
   * DOSIS pedida por el cliente: número + unidad ("40 mg", "500 mg", "120 ml").
   *
   * Es un FILTRO DURO, igual que la presentación: si el cliente/la receta pide
   * una dosis, solo se devuelven los productos con ESA dosis. Sin esto la fase
   * difusa EXCLUYE los números de los tokens (a propósito: "300" por Levenshtein
   * matchea "500"/"100" e inundaría de irrelevantes), así que la dosis quedaba
   * sin filtrar y una consulta de "omeprazol 40 mg" mezclaba 20 mg y 40 mg en la
   * misma lista — reportado con la receta "ESOZ 40 MG".
   *
   * Se compara NÚMERO + UNIDAD: "40 mg" no debe aceptar "40 ml" (jarabe vs
   * tableta son presentaciones distintas).
   */
  const dosisPedidas = new Set<string>();
  for (const m of term.matchAll(/(\d+(?:[.,]\d+)?)\s*(mg|mcg|gr|g|ml|cc|ui|ui\.|u\.i\.)/g)) {
    dosisPedidas.add(`${m[1]!.replace(",", ".")}${m[2]!.replace(/\./g, "")}`);
  }
  const quiereDosis = dosisPedidas.size > 0;
  const unidadesDosis = ["mg", "mcg", "gr", "g", "ml", "cc", "ui"];
  /**
   * ¿El nombre del producto declara alguna de las dosis pedidas?
   *
   * Devuelve true cuando NO se pidió dosis (el filtro no aplica). Cuando sí se
   * pidió y el producto no la declara, va al grupo de respaldo — igual que la
   * presentación: NUNCA se esconde el medicamento por un dato que el título
   * pueda no traer.
   */
  const tieneDosis = (nombre: string): boolean => {
    if (!quiereDosis) return true;
    const n = normalize(nombre);
    for (const m of n.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z.]+)/g)) {
      const num = m[1]!.replace(",", ".");
      const unidad = m[2]!.replace(/\./g, "");
      const unidadCanon = unidadesDosis.includes(unidad)
        ? (unidad === "gr" ? "g" : unidad)
        : null;
      if (!unidadCanon) continue;
      // Se aceptan ambas formas: "40mg" pegado y "40 mg" separado.
      const clave = `${num}${unidadCanon}`;
      const clavePegada = `${num}${unidad}`;
      if (dosisPedidas.has(clave) || dosisPedidas.has(clavePegada)) return true;
    }
    return false;
  };
  /** Filtros DUROS (no de score): presentación + dosis. Si no cumple, el
   *  producto solo se usa como respaldo cuando no hay ningún candidato que sí.
   *  Se declara DESPUÉS de `tienePresentacion` (ambas son const arrow). */
  /**
   * ¿El nombre del producto tiene la presentación pedida?
   *
   * Para "jarabe" se acepta además el criterio de VOLUMEN (ml/cc): muchos
   * laboratorios NO escriben "JAB" y distinguen la tableta del jarabe solo por
   * la unidad — "ATAMEL 500 MG X 20 TABLETAS" vs "ATAMEL 120 ML PED SABOR A
   * TUTTI FRUTTI". Medido sobre el catálogo real: de 265 productos con ml, solo
   * 1 (0.4%) llevaba además un marcador sólido, así que el volumen es una señal
   * de líquido fiable; y se excluyen los que sí son sólidos o son inyectables/
   * cremas/champús (NO_ES_JARABE), que llevan ml sin ser jarabe.
   */
  const tienePresentacion = (nombre: string): boolean => {
    if (!quierePresentacion) return true;
    const toks = tokensPresentacion(nombre);
    const tokSet = new Set(toks);
    for (const canon of presionadas) {
      const marcadores = MARCADOR_PRESENTACION[canon];
      if (!marcadores) continue;
      if (toks.some((t) => marcadores.includes(t))) return true;
      if (canon === "jarabe") {
        const esLiquido = tokSet.has("ml") || tokSet.has("cc") || tokSet.has("lt");
        const esSolido = MARCADOR_PRESENTACION.tableta!.some((m) => tokSet.has(m)) ||
                         MARCADOR_PRESENTACION.capsula!.some((m) => tokSet.has(m));
        const excluido = toks.some((t) => NO_ES_JARABE.has(t));
        if (esLiquido && !esSolido && !excluido) return true;
      }
    }
    return false;
  };
  // Un producto SIN ningún marcador de presentación sigue siendo candidato
  // cuando el filtro estricto no encuentre nada (muchos catálogos no marcan la
  // forma en el título); para eso se acumulan aquí los que sí la tienen.
  const conPresentacion: ProductDoc[] = [];
  // CONSOLIDACIÓN de tokens contiguos: en el catálogo las marcas suelen venir
  // pegadas ("ALPHAPRO 1 FORMULA...") pero el cliente las escribe separadas
  // ("Alpha pro"). Sin unir los consecutivos, "alpha" y "pro" solo califican
  // por OR y ganan productos que contienen UNA de las palabras (NAN OPTI PRO,
  // DENY PRO) en vez del ALPHAPRO real. Se generan las uniones de pares
  // consecutivos de los tokens de letras: ["alpha","pro"] → "alphapro".
  const letrasTokens = termTokens.filter((t) => !esNumero(t));
  const consolidados: string[] = [];
  for (let i = 0; i + 1 < letrasTokens.length; i++) {
    consolidados.push(letrasTokens[i]! + letrasTokens[i + 1]!);
  }
  // Tokens de letras que el producto DEBE contener (todos) para clasificar
  // como coincidencia fuerte. Excluye marcas/sal (NO_DISTINTIVO) que solo
  // puntúan, y las presentaciones genéricas ya filtradas.
  const requeridos = letrasTokens.filter((t) => !NO_DISTINTIVO.has(t));

  const cumpleFiltros = (nombre: string): boolean =>
    tienePresentacion(nombre) && tieneDosis(nombre);

  for (const doc of snap.docs) {
    const p = mapProduct(doc.id, doc.data() as Record<string, unknown>);
    const hay = normalize(p.nombre);
    if (!hay) continue;
    const hayTokens = hay.split(/\s+/);

    // Fase 1: exacto (substring completo, prefijo de token, o una marca
    // consolidada de tokens contiguos: "alpha pro" → "alphapro").
    //
    // GUARD: un término CORTO no debe matchear dentro de una palabra MÁS LARGA.
    // `hay.includes(term)` a secas hace que "foto" matchee "FOTORRETIN" (un
    // oftálmico): el cliente mandaba la foto de unos óvulos vaginales, el agente
    // buscaba con la palabra "foto" de su propia pregunta, y el catálogo devolvía
    // GOTAS OFTALMICA (FOTORRETIN) — respondiendo "sí, tengo el producto de la
    // foto" con un producto que no era. Caso real provider 19 (2026-10).
    // Se exige que el término sea palabra completa (o prefijo de token, que ya
    // se comprueba aparte) cuando es corto y cabe dentro de otro token.
    const termEsPalabraCompleta =
      hayTokens.includes(term) ||
      ` ${hay} `.includes(` ${term} `);
    const substringSeguro =
      hay.includes(term) &&
      (term.length >= 6 || termEsPalabraCompleta);
    if (
      substringSeguro ||
      hayTokens.some((t) => t.startsWith(term)) ||
      consolidados.some((c) => c.length >= 4 && hay.includes(c))
    ) {
      // Filtro de presentación: si el cliente pidió una forma concreta, un
      // producto que no la tiene NO entra como exacto (irá a `conPresentacion`
      // como respaldo solo si no hay ninguno que sí la tenga).
      if (cumpleFiltros(p.nombre)) exact.push(p);
      else conPresentacion.push(p);
      continue;
    }

    // Fase 2: difuso. Requiere que al menos un token DISTINTIVO matchee.
    // Si la consulta trae un token de FÁRMACO (no-accesorio), SOLO los
    // fármacos califican; los accesorios suman score pero no califican.
    // Si la consulta es solo de accesorios, estos califican.
    // PRESENTACIÓN: nunca califica un producto. "esoz tab" debe matchear
    // productos por "esoz", no por "tab" (que por Levenshtein de 1 letra
    // matchea "cap" y devolvía ESOZ cápsulas cuando se pidió tableta).
    const calificadores = (farmacos.length > 0 ? farmacos : accesorios)
      .filter((t) => !presentacionTokensQuery.has(t));
    if (calificadores.length === 0) continue;
    let score = 0;
    let matchedDistintivo = false;
    for (const qt of calificadores) {
      // maxD=1: distancia de 1 letra (typo). maxD=2 para tokens largos
      // producía falsos positivos ("moderan"≈"madera", "bumetin"≈"brucetin").
      const maxD = 1;
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
    // Los accesorios (cuando hay fármaco) y no-distintivos suman score para
    // ordenar, no califican.
    for (const qt of accesorios) {
      if (hay.includes(qt)) score += 0.5;
    }
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
    // PRECISIÓN: contar cuántos de los tokens REQUERIDOS de la consulta
    // aparecen en el producto. Una consulta multi-palabra ("Alpha pro") NO
    // debe conformarse con que UNA palabra ("pro") aparezca: eso hacía que
    // "Alpha pro 0-6" devolviera NAN OPTI PRO / DENY PRO en vez de ALPHAPRO.
    // Los que contienen TODAS las palabras van en un grupo de mayor
    // prioridad; los que contienen solo algunas, en un segundo grupo.
    let matchedTokens = 0;
    for (const qt of requeridos) {
      const hit =
        hay.includes(qt) ||
        hayTokens.some((ht) => ht.length >= 3 && levenshtein(ht, qt, 1) <= 1);
      if (hit) matchedTokens += 1;
    }
    const entry = { p, score };
    if (requeridos.length > 1 && matchedTokens === requeridos.length) {
      if (cumpleFiltros(p.nombre)) fuzzyAll.push(entry);
      else conPresentacion.push(p);
    } else {
      if (cumpleFiltros(p.nombre)) fuzzyAny.push(entry);
      else conPresentacion.push(p);
    }
  }

  let out: ProductDoc[];
  if (exact.length) {
    out = exact;
  } else if (fuzzyAll.length) {
    // Todos los tokens distintivos matchean: máxima precisión.
    fuzzyAll.sort((a, b) => b.score - a.score || (a.p.precio ?? Infinity) - (b.p.precio ?? Infinity));
    out = fuzzyAll.map((f) => f.p);
  } else if (fuzzyAny.length) {
    // Solo algunos tokens matchean: se devuelven como respaldo, pero NUNCA
    // por encima de los que matchean todo (por eso van en grupo aparte).
    fuzzyAny.sort((a, b) => b.score - a.score || (a.p.precio ?? Infinity) - (b.p.precio ?? Infinity));
    out = fuzzyAny.map((f) => f.p);
  } else if (conPresentacion.length) {
    // El cliente pidió una presentación concreta (tabletas/jarabe/...) y NINGÚN
    // producto del match la declara en el título. Antes de responder "no hay",
    // se devuelven los que matchearon el fármaco — nunca esconder el
    // medicamento por un marcador que el catálogo no usa.
    out = conPresentacion;
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

/** Datos del proveedor (para el encabezado de la respuesta y formas de pago). */
export async function getProviderInfo(
  providerId: string
): Promise<{
  name: string;
  hours: string | null;
  address: string | null;
  paymenType: string | null;
} | null> {
  const store = firestore();
  if (!store) return null;
  try {
    const env = getEnv();
    const doc = await store.collection(env.FIREBASE_COLLECTION_PROVIDERS).doc(providerId).get();
    if (!doc.exists) return null;
    const d = doc.data() as Record<string, unknown>;
    // El horario es un campo de texto libre que el dueño edita en el SAAS y NO
    // todos los tenants lo escribieron en el mismo campo: la mayoría usa
    // `hours` (17 de 18 providers) pero algunos usan `horario` (p. ej. 11 y 12).
    // Leer solo `hours` dejaba esos tenants sin horario y el agente respondía
    // "no pude obtener la información del horario".
    const horas = d.hours ?? d.horario ?? d.horarioAtencion ?? d.Hours;
    return {
      name: String(d.name ?? d.Name ?? d.nombre ?? ""),
      hours: horas ? String(horas).replace(/\\n/g, "\n").trim() : null,
      address: d.address ? String(d.address) : null,
      // Formas de pago (markdown libre que el dueño edita en el SAAS):
      // campo `paymenType` en providers/{id} de Firestore.
      paymenType: d.paymenType ? String(d.paymenType) : null,
    };
  } catch {
    return null;
  }
}
