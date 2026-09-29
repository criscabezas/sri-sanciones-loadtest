// Smoke: 1 VU, 1 iteracion, sin think time.
// Objetivo: confirmar token, rutas y contrato de respuesta antes de tocar carga.
// Imprime los cuerpos completos: ese es el paso que sirve para capturar el JSON
// real del POST y resolver el codigo de "sin resultados" del GET.

import http from 'k6/http';
import { check } from 'k6';
// Solo existe el default export de k6/execution. El named `{ exec }` es
// undefined en k6 2.x y rompe en tiempo de ejecucion con
// "Cannot read property 'scenario' of undefined".
import exec from 'k6/execution';

import { login, authHeader, getEstado, setEstado, validarCredenciales } from './lib/auth.js';
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

function estadosOK(clave, porDefecto) {
  return (__ENV[clave] || porDefecto)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

const OK_GET = estadosOK('OK_GET_STATUSES', '200');
const OK_POST = estadosOK('OK_POST_STATUSES', '200');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1.00'],
  },
};

export function setup() {
  console.log('### API objetivo: ' + API);
  console.log('### Casos de interes cargados: ' + getCasos().length);
  getAvisos().forEach((a) => console.log('### ' + a));
  const info = validarCredenciales();
  console.log('### Login OK. expires_in=' + info.expires_in + 's expira=' + info.expires_at);
  return { auth: info };
}

export default function () {
  const token = login();
  setEstado(token);
  console.log('### expires_at (VU ' + __VU + '): ' + new Date(token.expires_at).toISOString());

  const caso = seleccionarCaso(__VU, exec.scenario.iterationInTest);
  const getPath = interesPath(caso);
  console.log('\n### GET ' + API + '/' + getPath);
  const resGet = http.get(API + '/' + getPath, {
    headers: authHeader(getEstado()),
    tags: { endpoint: 'interes' },
    responseType: 'text',
    timeout: '30s',
  });
  console.log('### GET status=' + resGet.status + ' duracion=' + resGet.timings.duration + 'ms');
  console.log('### GET body: ' + resGet.body);
  check(resGet, {
    'GET interes status esperado': (r) => OK_GET.indexOf(r.status) !== -1,
  });

  if ((__ENV.ENABLE_POST || '0') === '0') {
    console.log('### ENABLE_POST=0: se omite el POST');
    return;
  }

  const body = construirBodyPost();
  const postPath = 'rest/multaInteresRest/multaDeclaracion';
  console.log('\n### POST ' + API + '/' + postPath);
  console.log('### POST body enviado: ' + body);
  const resPost = http.post(API + '/' + postPath, body, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader(getEstado())),
    tags: { endpoint: 'multaDeclaracion' },
    timeout: '30s',
  });
  console.log('### POST status=' + resPost.status + ' duracion=' + resPost.timings.duration + 'ms');
  console.log('### POST body: ' + resPost.body);
  check(resPost, {
    'POST multaDeclaracion status esperado': (r) => OK_POST.indexOf(r.status) !== -1,
  });
}

export function teardown() {
  if ((__ENV.ENABLE_POST || '0') === '0') {
    console.log('### Smoke finalizado. Alcance: solo GET interes (ENABLE_POST=0).');
    return;
  }
  console.log('### Smoke finalizado. Copia el cuerpo real del POST y reemplaza data/multaDeclaracion.json.');
}
