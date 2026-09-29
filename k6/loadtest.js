// Escenario principal de carga contra los 2 endpoints de sri-sanciones.
// Todo el perfil (etapas, umbrales, think time) se lee de __ENV para reusar
// el mismo archivo con otros perfiles sin editar codigo.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { exec } from 'k6/execution';

import { ensureToken, authHeader, getEstado, validarCredenciales } from './lib/auth.js';
import {
  getAvisos,
  getCasos,
  seleccionarCaso,
  interesPath,
  construirBodyPost,
} from './lib/data.js';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const CONTEXT_PATH = (__ENV.CONTEXT_PATH || '').replace(/^\/+|\/+$/g, '');
const API = BASE_URL + (CONTEXT_PATH ? '/' + CONTEXT_PATH : '');
const POST_PATH = 'rest/multaInteresRest/multaDeclaracion';

function num(clave, porDefecto) {
  const v = parseFloat(__ENV[clave]);
  return isNaN(v) ? porDefecto : v;
}

function estadosOK(clave, porDefecto) {
  return (__ENV[clave] || porDefecto)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

const OK_GET = estadosOK('OK_GET_STATUSES', '200');
const OK_POST = estadosOK('OK_POST_STATUSES', '200');
const THINK_TIME = num('THINK_TIME', 0);
const ENABLE_POST = (__ENV.ENABLE_POST || '1') !== '0';

const rate429 = new Counter('rate_limited_429');
const reqFallas = new Counter('req_fallidas');

// Trend solo para el POST: el GET ya tiene http_req_duration por tag y un Trend
// propio duplicaria la memoria sin agregar informacion.
const postDuration = new Trend('post_multaDeclaracion_duration', true);

export const options = {
  stages: [
    { duration: __ENV.RAMP_UP || '30s', target: num('VUS_RAMP', 20) },
    { duration: __ENV.SOSTEN || '2m', target: num('VUS_MAX', 50) },
    { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<' + num('MAX_ERR_RATE', 0.01)],
    'http_req_duration{endpoint:interes}': [
      'p(95)<' + num('P95_MAX_MS', 2000),
      'p(99)<' + num('P99_MAX_MS', 5000),
    ],
    'http_req_duration{endpoint:multaDeclaracion}': [
      'p(95)<' + num('P95_MAX_MS', 2000),
      'p(99)<' + num('P99_MAX_MS', 5000),
    ],
    checks: ['rate>' + num('MIN_CHECK_RATE', 0.99)],
    // Los 401/403 no son "error" del servicio: se aíslan para no mezclar una
    // falla de token con una falla real del backend.
    'http_req_duration{endpoint:token}': ['p(95)<3000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  console.log('### API objetivo: ' + API);
  console.log('### Perfil: ' + JSON.stringify(options.stages));
  console.log('### THINK_TIME=' + THINK_TIME + ' ENABLE_POST=' + ENABLE_POST);
  console.log('### Casos de interes: ' + getCasos().length);
  getAvisos().forEach((a) => console.log('### ' + a));

  const info = validarCredenciales();
  console.log('### Login OK. expires_in=' + info.expires_in + 's');
  if (info.expires_in > 0 && info.expires_in < 180) {
    console.log(
      '### ATENCION: el access_token expira en ' + info.expires_in +
      's, menor que el tramo de sostén (' + (__ENV.SOSTEN || '2m') +
      '). El refresh proactivo es obligatorio en este escenario.'
    );
  }
  return { expires_in: info.expires_in };
}

export default function () {
  // Si ensureToken devuelve null, la corrida no se aborta: se contabiliza
  // auth_errors y se sale de la iteracion como check fallido.
  const token = ensureToken(getEstado());
  if (!token || !token.access_token) {
    check(null, { 'token disponible': () => false });
    return;
  }

  const caso = seleccionarCaso(__VU, exec.scenario.iterationInTest);
  const resGet = http.get(API + '/' + interesPath(caso), {
    headers: authHeader(token),
    tags: { endpoint: 'interes' },
    // No necesitamos el cuerpo: ahorra CPU del cliente y evita volcar datos
    // de contribuyentes a memoria o logs.
    responseType: 'none',
    timeout: '30s',
  });
  const getOk = check(resGet, {
    'GET interes status esperado': (r) => OK_GET.indexOf(r.status) !== -1,
  });
  if (resGet.status === 429) {
    rate429.add(1, { endpoint: 'interes' });
  }
  if (!getOk && resGet.status !== 0) {
    reqFallas.add(1, { endpoint: 'interes' });
  }

  if (ENABLE_POST) {
    const resPost = http.post(API + '/' + POST_PATH, construirBodyPost(), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader(token)),
      tags: { endpoint: 'multaDeclaracion' },
      responseType: 'text',
      timeout: '30s',
    });
    postDuration.add(resPost.timings.duration);
    const postOk = check(resPost, {
      'POST multaDeclaracion status esperado': (r) => OK_POST.indexOf(r.status) !== -1,
    });
    if (resPost.status === 429) {
      rate429.add(1, { endpoint: 'multaDeclaracion' });
    }
    if (!postOk) {
      reqFallas.add(1, { endpoint: 'multaDeclaracion' });
    }
  }

  if (THINK_TIME > 0) {
    sleep(THINK_TIME);
  }
}

export function teardown(data) {
  console.log('### Corrida finalizada.');
  console.log('### Revisar en el reporte: p95/p99 por endpoint, rate_limited_429, auth_errors.');
  console.log('### 429 o latencia en ascenso monotónico => criterio de corte, no bug del script.');
  if (data && data.expires_in) {
    console.log('### access_token expira en ' + data.expires_in + 's (info de arranque).');
  }
}
