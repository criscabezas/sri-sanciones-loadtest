// Contrato unico de token OAuth (Keycloak, realm `Internet`).
//
// El estado del token vive en el ambito de modulo, que en k6 es una instancia
// por VU: no hay estado compartido escribible entre VUs. setup() solo valida
// que las credenciales funcionen; cada VU hace su propio login/refresh.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const authErrors = new Counter('auth_errors');
export const authRefreshes = new Counter('auth_refreshes');
export const authLogins = new Counter('auth_logins');
export const authRefreshDuration = new Trend('auth_refresh_duration', true);

// `parseInt(x || def)` convierte un 0 legitimo en el default: un margen de 0
// se transformaba silenciosamente en 60 s. Se separa undefined de 0.
function intEnv(clave, porDefecto) {
  if (__ENV[clave] === undefined || __ENV[clave] === '') return porDefecto;
  const v = parseInt(__ENV[clave], 10);
  return isNaN(v) ? porDefecto : v;
}

const MARGIN_MS = intEnv('TOKEN_REFRESH_MARGIN_S', 60) * 1000;
const JITTER_MS = intEnv('TOKEN_REFRESH_JITTER_S', 30) * 1000;

const TOKEN_URL = __ENV.TOKEN_URL;
const CLIENT_ID = __ENV.CLIENT_ID;
const USUARIO = __ENV.SRI_USER;
const PASSWORD = __ENV.SRI_PASS;

let estado = null;
// Jitter estable por VU: se calcula una vez y aplica a todos los refresh de
// ese VU, de modo que las renovaciones no caen en rafaga.
let refreshThresholdAt = 0;

function jitterDeVU() {
  let semilla = 0;
  try {
    semilla = typeof __VU === 'number' ? __VU : 0;
  } catch (e) {
    semilla = 0;
  }
  return (semilla * 2654435761 % 1000) / 1000 * JITTER_MS;
}

function paramsBase() {
  return { client_id: CLIENT_ID };
}

function credenciales() {
  if (!TOKEN_URL || !CLIENT_ID || !USUARIO || !PASSWORD) {
    throw new Error(
      'Faltan variables de entorno: se requieren TOKEN_URL, CLIENT_ID, SRI_USER y SRI_PASS. ' +
      'Copia .env.example a .env y completalo. Nunca corras el load test sin token.'
    );
  }
}

function aEstado(json) {
  if (!json || !json.access_token) return null;
  const expiresIn = parseInt(json.expires_in || '0', 10);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    id_token: json.id_token || null,
    expires_in: expiresIn,
    // Margen de red/horario: 5 s de tolerancia para no expirar en el vuelo.
    expires_at: Date.now() + (expiresIn - 5) * 1000,
  };
}

function describirError(res, json) {
  if (json && json.error) {
    return 'HTTP ' + res.status + ' ' + json.error +
      (json.error_description ? ' - ' + json.error_description : '');
  }
  return 'HTTP ' + res.status + ' sin access_token en la respuesta';
}

export function login(u, p) {
  credenciales();
  const usuario = u || USUARIO;
  const password = p || PASSWORD;
  const body = Object.assign({ grant_type: 'password', username: usuario, password: password }, paramsBase());
  if (__ENV.TOKEN_SCOPE) body.scope = __ENV.TOKEN_SCOPE;

  const res = http.post(TOKEN_URL, body, { tags: { endpoint: 'token' }, timeout: '30s' });
  let json = null;
  try {
    json = res.json();
  } catch (e) {
    json = null;
  }
  const nuevo = aEstado(json);
  if (!nuevo) {
    throw new Error('Login fallido: ' + describirError(res, json));
  }
  authLogins.add(1);
  return nuevo;
}

function refrescar(estadoActual) {
  if (!estadoActual || !estadoActual.refresh_token) return null;
  const body = Object.assign(
    { grant_type: 'refresh_token', refresh_token: estadoActual.refresh_token },
    paramsBase()
  );
  if (__ENV.TOKEN_SCOPE) body.scope = __ENV.TOKEN_SCOPE;

  const res = http.post(TOKEN_URL, body, { tags: { endpoint: 'token' }, timeout: '30s' });
  authRefreshDuration.add(res.timings.duration);
  let json = null;
  try {
    json = res.json();
  } catch (e) {
    json = null;
  }
  if (!aEstado(json)) {
    // invalid_grant tipicamente = refresh token rotado/invalidado: el
    // llamador cae a re-login. Cualquier otro fallo tambien.
    return null;
  }
  authRefreshes.add(1);
  return aEstado(json);
}

// Nunca lanza. Devuelve un token utilizable o null; un fallo de auth se
// degrada a error de check en la peticion de negocio, no a excepcion sin
// manejar que aborta el VU.
export function ensureToken(estadoActual) {
  try {
    if (!estadoActual || !estadoActual.access_token) {
      const nuevo = login();
      estado = nuevo;
      refreshThresholdAt = Date.now() + MARGIN_MS + jitterDeVU();
      return estado;
    }
    if (Date.now() < refreshThresholdAt && Date.now() < estadoActual.expires_at) {
      return estadoActual;
    }
    // Margen (60 s) + jitter propio del VU alcanzado.
    const porRefresh = refrescar(estadoActual);
    if (porRefresh) {
      estado = porRefresh;
      refreshThresholdAt = Date.now() + MARGIN_MS + jitterDeVU();
      return estado;
    }
    const porLogin = login();
    estado = porLogin;
    refreshThresholdAt = Date.now() + MARGIN_MS + jitterDeVU();
    return estado;
  } catch (e) {
    estado = null;
    refreshThresholdAt = 0;
    authErrors.add(1);
    return null;
  }
}

export function getEstado() {
  return estado;
}

export function setEstado(nuevo) {
  estado = nuevo;
  if (nuevo) refreshThresholdAt = Date.now() + MARGIN_MS + jitterDeVU();
}

export function getRefreshThresholdAt() {
  return refreshThresholdAt;
}

export function authHeader(estadoActual) {
  return { Authorization: 'Bearer ' + estadoActual.access_token };
}

// login de arranque: si falla, aborta la corrida completa con error explicito.
export function validarCredenciales() {
  const token = login();
  check(token, { 'login devuelve access_token': (t) => !!(t && t.access_token) });
  return {
    expires_in: token.expires_in,
    expires_at: new Date(token.expires_at).toISOString(),
    token_url: TOKEN_URL,
    client_id: CLIENT_ID,
  };
}
