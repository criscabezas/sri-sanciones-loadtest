# Plan: prueba de carga k6 — SRI sanciones (interes / multaDeclaracion)

## Objetivo
Medir el comportamiento de los 2 endpoints REST de `sri-sanciones-servicio-internet` bajo carga sostenida y entregar un veredicto contra umbrales de latencia y error.

## Decisiones tomadas
| Tema | Decisión |
|---|---|
| Herramienta | k6 (binario nativo Windows, JS, sin JVM) |
| Host | `https://srienlinea.sri.gob.ec` — **parametrizado** en variable `BASE_URL` (no hardcodeado) |
| Carga | Ramp-up 30s → 20 VU, sostén 2 min a 50 VU, bajada 30s (~3 min total) |
| Umbrales | p95 < 2 s, p99 < 5 s, error rate < 1 %, checks > 99 % |
| Auth | 1 login en `setup()`, refresh proactivo con jitter, fallback a re-login por VU |
| Datos GET | Rotar 5–8 casos reales de `data/interes-casos.json` |
| Datos POST | Payload capturado desde el navegador (F12 → Copy as fetch) |
| Think time | 0 s (lazo cerrado) — parámetro `THINK_TIME` listo para subirlos |
| Resultados | Consola + `results/summary-<timestamp>.json` |
| Monitoreo | Manual durante la corrida, con criterio de corte definido |

> El workspace actual (`code-with-quarkus`) es un tutorial sin relación. El script vive en un repo nuevo: `D:\dev\perf\sri-sanciones-loadtest\`.

## Estructura de archivos
```
D:\dev\perf\sri-sanciones-loadtest\
  k6/
    smoke.js                    # 1 VU / 1 iter: valida auth, rutas y contrato de respuesta
    loadtest.js                 # escenario principal
    lib/auth.js                 # login(), refresh(), ensureToken()
    lib/data.js                 # carga de data/*.json y selección de caso
    data/interes-casos.json     # 5-8 combinaciones reales de fecha/valor
    data/multaDeclaracion.json  # body del POST
  results/                      # summary-<timestamp>.json (gitignore)
  .env                          # credenciales reales (gitignore, NUNCA versionar)
  .env.example                  # plantilla sin secretos
  run.ps1                       # wrapper: valida pre-flight, ejecuta, archiva summary
  README.md                     # cómo ejecutar + Interpretation del reporte
```

## Tareas (en orden)

1. **Crear el repo** con la estructura de arriba y `.gitignore` (`.env`, `results/`).

2. **`lib/auth.js`** — contrato único de token:
   - `login(u, p)`: `POST {TOKEN_URL}` con `grant_type=password`, `client_id`, `scope` si aplica. Valida que la respuesta tenga `access_token`; si no, aborta la corrida con un error explícito (nunca seguir sin token).
   - Devuelve `{ access_token, refresh_token, expires_in, expires_at }`.
   - `ensureToken(estado)`: si `Date.now() > estado.expires_at - 60_000` → intenta refresh; si falla (`invalid_grant`, red, etc.) → re-login. Nunca lanza: un fallo de auth degrada a error de check, no a excepción no manejada.
   - **Jitter**: cada VU refresca en su propio umbral aleatorio (`60s + rand(0,30s)`) para que las renovaciones no ocurran en ráfaga al mismo instante.
   - Cachea por VU (el estado vive en el scope de la iteración, semilla desde `setup()`); no hay estado compartido escribible entre VUs en k6.

3. **`lib/data.js`** — cargar `interes-casos.json` con `open()` (contexto init) y exponer un selector pseudoaleatorio por iteración. Si el JSON es 1 solo elemento, registrar un warning en el reporte (sesgo por caché de BD).

4. **`smoke.js`** — 1 VU, 1 iteración, sin think time:
   - login → GET a un caso → POST con el payload.
   - Imprime los **cuerpos de respuesta completos** (es el paso que sirve para capturar el JSON real del POST y confirmar la forma de la respuesta).
   - Checks: solo `status === 200`.
   - Objetivo: confirmar que token, rutas y body funcionan antes de tocar carga.

5. **`loadtest.js`** — escenario principal:
   - `options.stages`: `[{30s→20 VU}, {2m→50 VU}, {30s→0}]`, todos los valores leídos de `__ENV` para poder reusar el mismo archivo con otros perfiles.
   - `thresholds`:
     ```js
     'http_req_failed': ['rate<0.01'],
     'http_req_duration{endpoint:interes}': ['p(95)<2000', 'p(99)<5000'],
     'http_req_duration{endpoint:multaDeclaracion}': ['p(95)<2000', 'p(99)<5000'],
     'checks': ['rate>0.99'],
     ```
   - GET `rest/multaInteresRest/interes/{f1}/{f2}/{f3}/{valor}` con `tags: { endpoint: 'interes' }` y `responseType: 'none'` (no necesitamos el cuerpo; ahorra CPU del cliente y evita volcar datos de contribuyentes a memoria/logs).
   - POST `rest/multaInteresRest/multaDeclaracion` con `tags: { endpoint: 'multaDeclaracion' }` y `Content-Type: application/json`.
   - Métricas propias: `Trend` por endpoint no hace falta (los tags bastan) + un `Counter` `auth_errors` para 401/403.
   - Check por respuesta:(status esperado)`; **verificar el código real de "sin resultados"** (200 con lista vacía vs 404) antes de fijar el umbral — ver Open Questions.

6. **`.env.example` + `run.ps1`**:
   ```dotenv
   BASE_URL=https://srienlinea.sri.gob.ec
   CONTEXT_PATH=/sri-sanciones-servicio-internet
   TOKEN_PATH=/auth/realms/Internet/protocol/openid-connect/token
   TOKEN_URL=   # vacio: se deriva de BASE_URL (mismo host en produccion)
   CLIENT_ID=app-sri-declaraciones-web-internet_cfcg
   SRI_USER=
   SRI_PASS=
   THINK_TIME=0
   ```
   `run.ps1` corre en dos pasos: `smoke` y `carga`; pasa `--env-from-file=.env`; **no acepta `-VUs` por encima de 50** (guardarraíl) y guarda el summary con timestamp en `results/`.

7. **Capturar el payload del POST**: con el token del usuario de pruebas, en el navegador sobre el ambiente de pruebas, DevTools → red → la petición `multaDeclaracion` → *Copy as fetch* → extraer el body a `data/multaDeclaracion.json`. Sanear: sustituir RUC, nombres, correos y códigos de=value por datos ficticios (LOPD).

## Pre-flight obligatorio (la carga va contra producción)
Ninguna corrida de carga sin esto, en este orden:
1. **Autorización y ventana** confirmadas con el equipo de infraestructura del SRI (fecha, hora,ip de salida, VU máximos acordados). Sin esto, no se ejecuta.
2. Alguien del lado del SRI pendiente durante toda la corrida.
3. `smoke.js` en verde (1 VU, 1 request a cada endpoint).
4. **Confirmar que el POST no persiste**: llamar 2 veces con el mismo payload, comparar respuestas y revisar que no aparece un registro nuevo en la UI de sanciones. Si sí persiste → el POST baja a 1 VU / 1 iteración y se documenta, o la prueba de escritura se mueve a homologación.
5. Calcular el RPS esperado y validarlo: en lazo cerrado sin think time, `RPS ≈ VU / latencia` → 50 VU a 200 ms ≈ **250 RPS**. Si eso excede lo acordado, setear `THINK_TIME=1` (≈25 RPS) sin tocar el código.
6. Verificar que la IP del generador no está bloqueada / en blacklist del WAF o balanceador.

## Criterios de corte (Ctrl+C) durante la corrida
- p95 > 5 s sostenido por > 30 s, o latencia en ascenso monotónico.
- Error rate > 5 % en ventana.
- Cualquier 403/429 del WAF o del servicio (el 429 es un hallazgo, no un bug del script: anotarlo y parar).
- Confirmación del equipo del SRI de que algo se degradó en otro consumidor.

## Validación
- `smoke.js` verde y cuerpos de respuesta inspeccionados a mano (contrato de GET y POST).
- Corrida de calibración: 2 VU / 30 s, solo para verificar que **no se dispara el refresh** (log del `expires_at` vs duración total). Si se dispara, es el comportamiento esperado del fallback.
- Verificar que `results/summary-<ts>.json` existe y contiene p95/p99 por endpoint.
- Rejecutar el escenario completo y comparar contra umbrales.
- Opcional: barrido progresivo 20 → 30 → 40 → 50 VU (mismo script, distintos `VUS`) para encontrar el **punto de saturación** y reportar el knee, no solo el pass/fail.

## Entregable
Reporte corto: objetivo, entorno y ventana autorizada, configuración, tabla de p50/p95/p99/max + RPS real + error rate por endpoint, veredicto contra umbrales, findings (punto de saturación, comportamiento ante 429, uso de refresh) y archivos de evidencia (`summary-<ts>.json`).

## Riesgos
1. **POST con efectos en producción** — la usuario-guarantee de que no persiste aún no está verificada. Mitigación: paso 4 del pre-flight.
2. **250 RPS sin think time** — decisión tomada, pero es la variable de mayor impacto en producción. Mitigación: `THINK_TIME` por env + confirmación previa del RPS.
3. **Expiración del access_token** (2–5 min) — si expira a mitad de corrida, el tramo final se llena de 401 y falsea p95/p99 y el error rate. Mitigación: refresh proactivo + fallback; el `Counter auth_errors` separa esa causa de un error real del servicio.
4. **Refresh token rotation en Keycloak 18+** — si rota, el refresh compartido entre VUs se invalida mutuamente y todos los refresh fallan. Mitigación: el fallback a re-login por VU lo cubre; verificar el comportamiento con dos refresh seguidos (ver Open Questions).
5. **WAF / rate limit** — puede cortar la IP del generador y falsear los resultados. Mitigación: paso 6 del pre-flight; tratar 403/429 como hallazgo.
6. **Datos sensibles** — `data/*.json` solo con datos ficticios; en la carga real el cuerpo del GET no se materializa (`responseType: 'none'`).
7. **Sesgo de caché de BD** — con un solo caso, p95 refleja caché y no consulta real. Mitigación: rotación de 5–8 casos.

## Open Questions (resolver antes de la corrida de carga)
1. ¿Cuál es el código de respuesta "correcto" cuando el GET no tiene datos: 200 con lista vacía o 404? Define el check.
2. ¿Keycloak rota el refresh token en el realm `Internet`? (refresh dos veces con el mismo token; si el 2º devuelve `invalid_grant`, está activo la rotación).
3. ~~¿El `TOKEN_URL` público es el de `10.12.4.61` (VPN) o hay URL pública equivalente?~~ **RESUELTA**: el realm cuelga del mismo host de producción. `TOKEN_URL` se deriva de `BASE_URL + TOKEN_PATH`; k6 no necesita acceso a la red interna.
4. ¿El context path en producción es `/sri-sanciones-servicio-internet`? Confirmar con la URL real del navegador.
5. ¿A partir de qué RPS el servicio degrada? (define hasta dónde tiene sentido escalar y si se pide el barrido progresivo).
