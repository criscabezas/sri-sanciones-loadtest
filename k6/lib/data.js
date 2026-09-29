// Carga de datos de prueba y seleccion de caso por iteracion.
//
// Los `open()` se ejecutan en el contexto de init (una sola vez por VU);
// a partir de ahi el objeto queda serializado en la instancia del VU y las
// funciones exportadas corren en el contexto de VU sin volver a tocar disco.

const CASOS_PATH = __ENV.CASOS_PATH || '../data/interes-casos.json';
const POSTA_PATH = __ENV.POSTA_PATH || '../data/multaDeclaracion.json';

function leerJson(path, etiqueta) {
  let crudo;
  try {
    crudo = open(path);
  } catch (e) {
    throw new Error(
      'No se pudo abrir ' + path + ' (' + etiqueta + '). ' +
      'Verifica la ruta relativa al script k6/ y que el archivo exista.'
    );
  }
  try {
    return JSON.parse(crudo);
  } catch (e) {
    throw new Error('JSON invalido en ' + path + ': ' + e.message);
  }
}

const casosDoc = leerJson(CASOS_PATH, 'casos de consulta de interes');
const casos = Array.isArray(casosDoc) ? casosDoc : casosDoc.casos || [];

const postTemplateRaw = leerJson(POSTA_PATH, 'body de multaDeclaracion');

function sanearTemplate(doc) {
  const out = {};
  Object.keys(doc).forEach(function (k) {
    if (k.charAt(0) !== '_') out[k] = doc[k];
  });
  return out;
}

const postTemplate = sanearTemplate(postTemplateRaw);

// --- Diagnosticos de sesgo (se consultan desde smoke/setup y se imprimen una vez) ---
let avisos = [];
if (!Array.isArray(casos) || casos.length === 0) {
  throw new Error(
    'data/interes-casos.json no contiene casos. Agrega al menos uno ' +
    '(array plano o { "casos": [...] }).'
  );
}
if (casos.length === 1) {
  avisos.push(
    'ATENCION: interes-casos.json tiene 1 solo caso. p95 reflects cache de BD, ' +
    'no consulta real. Se requieren 5-8 casos.'
  );
}
if (casos.length < 5) {
  avisos.push(
    'ATENCION: interes-casos.json tiene ' + casos.length + ' casos (< 5). ' +
    'Riesgo de sesgo por cache.'
  );
}

export function getAvisos() {
  return avisos;
}

export function getCasos() {
  return casos;
}

export function getPostTemplate() {
  return postTemplate;
}

// Seleccion por rotacion: garantiza cobertura de todos los casos en el primer
// ciclo completo en lugar de concentrarlos por azar. El desempate con __VU
// reparte los VUs entre casos desde el inicio.
export function seleccionarCaso(vu, iter) {
  const v = typeof vu === 'number' ? vu : 0;
  const i = typeof iter === 'number' ? iter : 0;
  return casos[(v + i) % casos.length];
}

export function interesPath(caso) {
  return (
    'rest/multaInteresRest/interes/' +
    encodeURIComponent(caso.dia) + '/' +
    encodeURIComponent(caso.mes) + '/' +
    encodeURIComponent(caso.anio) + '/' +
    encodeURIComponent(caso.valor)
  );
}

// El body del POST se deriva de la plantilla + overrides de __ENV para poder
// variar fechas/valor sin editar el JSON en cada corrida.
export function construirBodyPost() {
  const body = {};
  Object.keys(postTemplate).forEach(function (k) {
    body[k] = postTemplate[k];
  });

  const overrides = [
    ['POST_DIA', 'dia'],
    ['POST_MES', 'mes'],
    ['POST_ANIO', 'anio'],
    ['POST_VALOR_INTERES', 'valor'],
  ];
  overrides.forEach(function (par) {
    const envKey = par[0];
    const campo = par[1];
    if (__ENV[envKey] !== undefined && __ENV[envKey] !== '') {
      if (campo === 'anio') body.periodo = __ENV[envKey];
      body[campo] = __ENV[envKey];
    }
  });
  if (__ENV.POSTA_OBSERVACION) {
    body.observacion = __ENV.POSTA_OBSERVACION;
  }
  return JSON.stringify(body);
}
