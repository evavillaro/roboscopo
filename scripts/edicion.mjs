// Roboscopo · edición diaria
// Lee las portadas (RSS) y los horóscopos del día, llama UNA vez a Claude y escribe data/hoy.json.
// Se ejecuta desde GitHub Actions a las 06:00 hora de Madrid (o a mano: npm run edicion:forzar).

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Haiku 4.5 por defecto: una edición cuesta alrededor de un céntimo. Para más ingenio, ROBOSCOPO_MODEL=claude-opus-5.
const MODEL = process.env.ROBOSCOPO_MODEL || "claude-haiku-4-5";
const CON_FALLBACK = /opus-5|fable/.test(MODEL); // el parámetro fallbacks solo existe en esos modelos
const TZ = "Europe/Madrid";
const FORCE = !!process.env.FORCE && process.env.FORCE !== "false";
const UA = "Mozilla/5.0 (compatible; Roboscopo/1.0; +https://github.com/evavillaro/roboscopo)";

const PORTADAS = [
  { src: "El Mundo", url: "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml" },
  { src: "El País", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada" },
  { src: "eldiario.es", url: "https://www.eldiario.es/rss/" },
  { src: "ABC", url: "https://www.abc.es/rss/2.0/portada/" },
  { src: "La Vanguardia", url: "https://www.lavanguardia.com/rss/home.xml" },
  { src: "RTVE", url: "https://api2.rtve.es/rss/temas_noticias.xml" },
  { src: "20minutos", url: "https://www.20minutos.es/rss/" },
  { src: "El Periódico", url: "https://www.elperiodico.com/es/rss/rss_portada.xml" },
];
const POR_PORTADA = 6; // titulares por periódico

const HOROSCOPOS = [
  { src: "20minutos", url: "https://www.20minutos.es/horoscopo/" },
  { src: "El Periódico", url: "https://www.elperiodico.com/es/horoscopo/" },
  { src: "La Vanguardia", url: "https://www.lavanguardia.com/horoscopo" },
  { src: "ABC", url: "https://www.abc.es/horoscopo/" },
];

const CAPITALES = [
  ["Madrid", 40.4168, -3.7038], ["Barcelona", 41.3888, 2.159], ["Sevilla", 37.3891, -5.9845],
  ["Valencia", 39.4699, -0.3763], ["Bilbao", 43.263, -2.935], ["Las Palmas", 28.1235, -15.4363],
];

const SIGNOS = ["aries", "tauro", "geminis", "cancer", "leo", "virgo", "libra", "escorpio", "sagitario", "capricornio", "acuario", "piscis"];
const GRUPOS = ["joven", "maduro", "remaduro", "veterano"];

// ---------- utilidades ----------
const fmt = (d, opts) => new Intl.DateTimeFormat("es-ES", { timeZone: TZ, ...opts }).format(d);
function hoyMadrid() {
  const d = new Date();
  const ymd = fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-");
  const hora = parseInt(fmt(d, { hour: "numeric", hour12: false }), 10);
  const legible = fmt(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const inicio = Date.UTC(parseInt(ymd.slice(0, 4), 10), 0, 1);
  const numero = Math.floor((Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - inicio) / 864e5) + 1;
  return { ymd, hora, legible, numero, cerrada: fmt(d, { hour: "2-digit", minute: "2-digit", hour12: false }) };
}
async function traer(url, ms = 15000) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const entidades = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").trim();

function parseRSS(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/g)) {
    const it = m[0];
    const t = it.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || it.match(/<link[^>]*href="([^"]+)"/);
    if (t && l) items.push({ t: entidades(t[1]).replace(/\s+/g, " "), u: entidades(l[1]).trim() });
  }
  return items;
}
function htmlATexto(html, max = 7000) {
  return entidades(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<\/(p|div|li|h\d|br|tr)>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, max);
}

// ---------- recogida ----------
async function portadas() {
  const out = [], fuentes = [];
  const res = await Promise.allSettled(PORTADAS.map(async (p) => ({ ...p, items: parseRSS(await traer(p.url)).slice(0, POR_PORTADA) })));
  let id = 1;
  for (const r of res) {
    if (r.status !== "fulfilled" || !r.value.items.length) { console.warn("Portada no disponible:", r.reason?.message || r.value?.src); continue; }
    fuentes.push(r.value.src);
    for (const it of r.value.items) out.push({ id: id++, src: r.value.src, t: it.t, u: it.u });
  }
  return { titulares: out, fuentes };
}
async function horoscopos() {
  const res = await Promise.allSettled(HOROSCOPOS.map(async (h) => ({ ...h, texto: htmlATexto(await traer(h.url)) })));
  const ok = [];
  for (const r of res) {
    if (r.status !== "fulfilled") { console.warn("Horóscopo no disponible:", r.reason?.message); continue; }
    const t = r.value.texto.toLowerCase();
    const n = ["aries", "tauro", "géminis", "cáncer", "leo", "virgo", "libra", "escorpio", "sagitario", "capricornio", "acuario", "piscis"].filter((s) => t.includes(s)).length;
    if (n >= 8) ok.push({ src: r.value.src, texto: r.value.texto }); else console.warn("Horóscopo sin signos:", r.value.src);
  }
  return ok;
}
async function tiempoCapitales() {
  const res = await Promise.allSettled(CAPITALES.map(async ([n, la, lo]) => {
    const j = JSON.parse(await traer(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max&timezone=${encodeURIComponent(TZ)}&forecast_days=1`));
    const d = j.daily; return { n, max: d.temperature_2m_max[0], min: d.temperature_2m_min[0], lluvia: d.precipitation_probability_max[0], viento: d.wind_speed_10m_max[0] };
  }));
  return res.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

// ---------- la llamada a Claude ----------
const PERSONA = `Eres la Unidad R-42, el robot que redacta Roboscopo, una web española de horóscopos contrastados con las portadas de los periódicos.
Personalidad: un androide con un cerebro del tamaño de un planeta al que han puesto a leer horóscopos. Desganado, brillante, ligeramente deprimido, científico hasta la médula: no te crees ni a los astros ni a las portadas, y lo demuestras con datos. Humor seco, frases cortas, sin exclamaciones, sin emojis, nunca cruel con personas concretas más allá de lo que dicen los propios titulares. Escribes en castellano de España, en segunda persona cuando te diriges al lector.

Reglas duras:
- Solo puedes citar noticias que estén en la lista de titulares que te doy. Nunca inventes hechos ni cifras. Si citas un titular, envuelve el fragmento citado en <mark>...</mark> (una o dos veces por texto como máximo) y añade su id al campo hits.
- Los horóscopos reales no se copian: se resumen con tus palabras en una o dos frases, en el tono clásico y grandilocuente de los horóscopos, para que luego tú los desmontes.
- "contra" es tu contraste: qué dice de verdad la portada sobre lo que prometen los astros, con un porcentaje de coincidencia (coin, 0 a 100) justificado en el propio texto. 2 a 4 frases.
- "score" es tu índice de día para ese signo, de 0 a 10 con un decimal, cruzando lo que prometen los astros con lo que traen las portadas. Todos los signos deben tener puntuaciones distintas para que haya ranking.
- "why" es una sola frase corta para el ranking, sin <mark>.
- Los grupos de edad son independientes del signo: joven (menos de 30), maduro (30 a 49), remaduro (50 a 64), veterano (65 o más). Para cada grupo, "txt" cuenta lo que le va a pasar hoy de verdad según las portadas (3 a 5 frases, con uno o dos <mark> y sus hits). Además cuatro frases cortas de tiempo para ese grupo según el día que haga: calor (máxima 30 o más), templado, frio (máxima por debajo de 15) y lluvia. Esas frases no llevan cifras, las pone la web.
- "editorial": 2 a 4 párrafos de apertura de la edición: qué has leído, qué prometen los astros en conjunto, qué traen las portadas, la coincidencia media y tu conclusión. Puedes mencionar el tiempo de las capitales.
- "sol": una frase seca sobre en qué signo está el Sol hoy y si los astrólogos han acertado la fecha de cambio de signo (cambia alrededor del 20-23 de cada mes; si hoy es uno de esos días, dilo).
- Nada de HTML salvo <mark>. Nada de markdown.`;

const signoSchema = {
  type: "object",
  properties: {
    astros: { type: "string" }, contra: { type: "string" }, coin: { type: "integer" },
    score: { type: "number" }, why: { type: "string" }, hits: { type: "array", items: { type: "integer" } },
  },
  required: ["astros", "contra", "coin", "score", "why", "hits"], additionalProperties: false,
};
const grupoSchema = {
  type: "object",
  properties: { txt: { type: "string" }, hits: { type: "array", items: { type: "integer" } }, calor: { type: "string" }, templado: { type: "string" }, frio: { type: "string" }, lluvia: { type: "string" } },
  required: ["txt", "hits", "calor", "templado", "frio", "lluvia"], additionalProperties: false,
};
const schema = {
  type: "object",
  properties: {
    editorial: { type: "array", items: { type: "string" } },
    sol: { type: "string" },
    signos: { type: "object", properties: Object.fromEntries(SIGNOS.map((s) => [s, signoSchema])), required: SIGNOS, additionalProperties: false },
    grupos: { type: "object", properties: Object.fromEntries(GRUPOS.map((g) => [g, grupoSchema])), required: GRUPOS, additionalProperties: false },
  },
  required: ["editorial", "sol", "signos", "grupos"], additionalProperties: false,
};

async function redactar({ fecha, titulares, horos, tiempo }) {
  const client = new Anthropic();
  const listaTitulares = titulares.map((t) => `[${t.id}] (${t.src}) ${t.t}`).join("\n");
  const textoHoros = horos.length
    ? horos.map((h) => `=== ${h.src} ===\n${h.texto}`).join("\n\n")
    : "NO HAY HORÓSCOPOS DISPONIBLES HOY. Redacta tú el campo 'astros' de cada signo imitando el estilo de los horóscopos de periódico (vago, grandilocuente, planetas al azar). En el editorial di que las fuentes de horóscopos no estaban accesibles y que los has reconstruido aplicando su método, que consiste en no tener ninguno.";
  const textoTiempo = tiempo.map((t) => `${t.n}: máx ${t.max}º, mín ${t.min}º, lluvia ${t.lluvia} %, viento ${t.viento} km/h`).join("; ");

  const user = `Hoy es ${fecha.legible}. Edición número ${fecha.numero}.

TITULARES DE PORTADA (id, periódico, titular):
${listaTitulares}

HORÓSCOPOS DEL DÍA (texto extraído de las webs, puede llevar ruido):
${textoHoros}

TIEMPO PREVISTO EN CAPITALES: ${textoTiempo}

Redacta la edición completa de hoy.`;

  const peticion = {
    model: MODEL,
    max_tokens: 16000,
    system: PERSONA,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };
  let res;
  if (CON_FALLBACK) {
    try {
      // Fallback servidor por defecto: si un clasificador declina la petición, se reintenta en otro modelo dentro de la misma llamada.
      res = await client.beta.messages.create({ ...peticion, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) { console.warn("Reintento sin fallbacks:", e.message); res = await client.messages.create(peticion); }
      else throw e;
    }
  } else {
    res = await client.messages.create(peticion);
  }
  if (res.stop_reason === "refusal") throw new Error("El modelo ha declinado redactar la edición: " + JSON.stringify(res.stop_details));
  if (res.stop_reason === "max_tokens") throw new Error("Respuesta truncada por max_tokens");
  const texto = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const json = JSON.parse(texto);
  console.log(`Modelo ${res.model} · tokens entrada ${res.usage.input_tokens} · salida ${res.usage.output_tokens}`);
  return json;
}

// ---------- principal ----------
async function main() {
  const fecha = hoyMadrid();
  let anterior = null;
  try { anterior = JSON.parse(await readFile("data/hoy.json", "utf8")); } catch {}
  if (!FORCE) {
    if (fecha.hora < 6) { console.log(`Son las ${fecha.hora}:xx en Madrid. La edición se cierra a las 06:00. Salgo.`); return; }
    if (anterior?.fecha === fecha.ymd) { console.log(`La edición de ${fecha.ymd} ya existe. Salgo.`); return; }
  }
  console.log(`Edición ${fecha.ymd} (nº ${fecha.numero}) · modelo ${MODEL}`);
  const [{ titulares, fuentes }, horos, tiempo] = await Promise.all([portadas(), horoscopos(), tiempoCapitales()]);
  if (titulares.length < 4) throw new Error(`Solo ${titulares.length} titulares. No hay edición sin portadas.`);
  console.log(`${titulares.length} titulares de ${fuentes.join(", ")} · horóscopos de ${horos.map((h) => h.src).join(", ") || "ninguna fuente"} · tiempo de ${tiempo.length} capitales`);

  const j = await redactar({ fecha, titulares, horos, tiempo });
  for (const s of SIGNOS) if (!j.signos[s]) throw new Error("Falta el signo " + s);
  const media = Math.round(SIGNOS.reduce((a, s) => a + j.signos[s].coin, 0) / SIGNOS.length);

  const edicion = {
    fecha: fecha.ymd, fecha_legible: fecha.legible, numero: fecha.numero, cerrada: fecha.cerrada, modelo: MODEL,
    fuentes_portadas: fuentes, fuentes_horoscopo: horos.map((h) => h.src), horoscopos_reconstruidos: horos.length === 0,
    titulares, tiempo_capitales: tiempo, media_coin: media,
    editorial: j.editorial, sol: j.sol, signos: j.signos, grupos: j.grupos,
  };
  await mkdir("data/ediciones", { recursive: true });
  const txt = JSON.stringify(edicion, null, 1);
  await writeFile("data/hoy.json", txt);
  await writeFile(`data/ediciones/${fecha.ymd}.json`, txt);
  console.log(`Escrita data/hoy.json · coincidencia media ${media} %`);
}

main().catch((e) => { console.error(e); process.exit(1); });
