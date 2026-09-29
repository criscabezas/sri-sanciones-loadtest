# k6 load test — SRI sanciones (`interes` / `multaDeclaracion`)

Prueba de carga de los 2 endpoints REST de `sri-sanciones-servicio-internet`
sobre `https://srienlinea.sri.gob.ec`.

> **La carga va contra producción.** No ejecutes `carga` sin la autorización y
> la ventana confirmadas con infraestructura del SRI. `run.ps1` te pide
> confirmar el pre-flight; el guardarraíl de VU es una ayuda, no un permiso.

## Estructura

```
k6/
  smoke.js              1 VU / 1 iter: valida auth, rutas y contrato de respuesta
  loadtest.js           escenario principal (etapas y umbrales por __ENV)
  lib/auth.js           login() / refresh() / ensureToken() con jitter por VU
  lib/data.js           carga de data/*.json y selección de caso
data/
  interes-casos.json    5-8 combinaciones reales de fecha/valor
  multaDeclaracion.json body del POST
results/                summary-<timestamp>.json (gitignored)
.env                    credenciales (gitignored, NUNCA versionar)
.env.example            plantilla sin secretos
run.ps1                 wrapper con pre-flight y archivado del summary
```

## Preparación

```powershell
Copy-Item .env.example .env
# Editar .env: SRI_USER, SRI_PASS, y confirmar TOKEN_URL (¿10.12.4.61 por VPN
# o hay URL pública?).
```

1. **Capturar el payload real del POST**: en el ambiente de pruebas, con la
   sesión del usuario de pruebas, DevTools → red → petición `multaDeclaracion`
   → *Copy as fetch* → extraer el body a `data/multaDeclaracion.json`.
   **Sanear** (LOPD): RUC ficticio, nombres, correos y códigos.
2. **Cargar 5-8 casos reales** en `data/interes-casos.json`. Con un solo caso,
   p95 mide caché de BD y no consulta real; `data.js` emite un warning.

## Ejecución

```powershell
.\run.ps1 smoke          # 1 VU, imprime cuerpos completos de GET y POST
.\run.ps1 carga          # escenario completo con el perfil de .env
.\run.ps1 carga -Vus 30 -Sosten 2m -ThinkTime 1
.\run.ps1 calibracion    # 2 VU / 30 s: verifica que el refresh no se dispara
```

`-Vus` por encima de 50 es rechazado por el guardarraíl.

## Configuración (todo vía `.env`)

| Variable | Default | Notas |
|---|---|---|
| `BASE_URL` | `https://srienlinea.sri.gob.ec` | host, parametrizado |
| `CONTEXT_PATH` | `/sri-sanciones-servicio-internet` | confirmar con la URL real |
| `TOKEN_URL` | `10.12.4.61` (VPN) | ver Open Question 3 |
| `CLIENT_ID` | `app-sri-declaraciones-web-internet_cfcg` | |
| `RAMP_UP` / `VUS_RAMP` | `30s` / `20` | |
| `SOSTEN` / `VUS_MAX` | `2m` / `50` | |
| `RAMP_DOWN` | `30s` | |
| `THINK_TIME` | `0` | 0 = lazo cerrado (~250 RPS a 50 VU / 200 ms) |
| `P95_MAX_MS` / `P99_MAX_MS` | `2000` / `5000` | |
| `MAX_ERR_RATE` / `MIN_CHECK_RATE` | `0.01` / `0.99` | |
| `TOKEN_REFRESH_MARGIN_S` | `60` | margen antes de expirar |
| `TOKEN_REFRESH_JITTER_S` | `30` | anti-ráfaga de refresh |
| `OK_GET_STATUSES` | `200` | agregar `404` si "sin resultados" es 404 |
| `ENABLE_POST` | `1` | `0` = solo GET (modo seguro) |

## Auth en la práctica

- `setup()` valida credenciales y aborta la corrida con error explícito si no
  hay `access_token`. Nunca se sigue sin token.
- El estado del token vive en el ámbito de módulo, que en k6 es una instancia
  **por VU**: no hay estado compartido escribible entre VUs.
- `ensureToken()` refresca en `60 s + jitter(0-30 s)` propio de cada VU; si el
  refresh falla (`invalid_grant`, red) cae a re-login. **Nunca lanza**: un fallo
  de auth se degrada a check fallido, no a excepción sin manejar.
- `Counter auth_errors` aísla esa causa de un error real del servicio, para no
  que un token expirado falsee p95/p99.

## Métricas y umbrales

Thresholds configurados:

```
http_req_failed                                     rate < 1 %
http_req_duration{endpoint:interes}                 p95 < 2 s, p99 < 5 s
http_req_duration{endpoint:multaDeclaracion}       p95 < 2 s, p99 < 5 s
http_req_duration{endpoint:token}                   p95 < 3 s
checks                                             rate > 99 %
```

Métricas propias: `auth_logins`, `auth_refreshes`, `auth_errors`,
`auth_refresh_duration`, `post_multaDeclaracion_duration`, `rate_limited_429`,
`req_fallidas`.

## Criterios de corte (Ctrl+C)

- p95 > 5 s sostenido por más de 30 s, o latencia en ascenso monotónico.
- Error rate > 5 % en ventana.
- Cualquier 403/429 del WAF o del servicio (el 429 es un hallazgo, no un bug).
- Confirmación del SRI de que algo se degradó en otro consumidor.

## Interpretation del reporte

1. Abrir `results/summary-<ts>.json` y la tabla final de k6.
   **Nota k6 >= 2.x**: el `--summary-export` aplana los valores, no hay un
   nivel `values` intermedio. Es `metrics.http_reqs.count`, no
   `metrics.http_reqs.values.count`. Los contadores que quedaron en cero
   (`auth_errors`, `rate_limited_429`, `req_fallidas`) **no aparecen** en el
   archivo; su ausencia es la señal de que no ocurrieron, no un dato faltante.
   Los percentiles van en claves con paréntesis, incomodables de leer en
   PowerShell: usar `jq` o el reporte de consola.
2. **Veredicto por endpoint**: p50/p95/p99/max contra los umbrales. El veredicto
   es el peor de los dos endpoints, no el promedio.
3. **Error rate** de `http_req_failed` descompuesto por tag. Si
   `auth_errors > 0` y el tramo final concentra 401, el token expiró: es un
   problema del generador, no del servicio. Repetir con
   `TOKEN_REFRESH_MARGIN_S` mayor.
4. **`rate_limited_429`**: el servicio está aplicando rate limit. Anotar el
   RPS al que aparece — es un dato de capacidad, y la corrida debe parar.
5. **Punto de saturación**: con el barrido progresivo (20 → 30 → 40 → 50 VU) el
   knee es el VU donde p95 deja de crecer linealmente. Reportar el knee, no
   solo pass/fail.
6. **Sesgo de caché**: si `data/interes-casos.json` tiene menos de 5 casos, p95
   refleja caché. El warning de `data.js` aparece en consola al arrancar.
7. RPS real = `http_reqs` / duración total. Comparar con lo autorizado.

## Pre-flight (obligatorio, en orden)

1. Autorización y ventana confirmadas con infraestructura del SRI (fecha, hora,
   IP de salida, VU máximos). Sin esto, no se ejecuta.
2. Alguien del SRI pendiente durante toda la corrida.
3. `smoke.js` en verde (1 request a cada endpoint).
4. **Confirmar que el POST no persiste**: llamar 2 veces con el mismo payload,
   comparar respuestas y revisar que no aparece un registro nuevo en la UI de
   sanciones. Si persiste → el POST baja a 1 VU / 1 iteración y se documenta, o
   la prueba de escritura se mueve a homologación.
5. RPS esperado validado. En lazo cerrado, `RPS ≈ VU / latencia` → 50 VU a
   200 ms ≈ **250 RPS**. Si excede lo acordado, `THINK_TIME=1` (≈25 RPS).
6. IP del generador no bloqueada por el WAF o el balanceador.

## Open Questions (resolver antes de la corrida de carga)

1. ¿Cuál es el código correcto cuando el GET no tiene datos: 200 con lista
   vacía o 404? Define `OK_GET_STATUSES`.
2. ¿Keycloak rota el refresh token en el realm `Internet`? (dos refresh
   seguidos con el mismo token; si el 2º da `invalid_grant`, hay rotación.)
3. ¿El `TOKEN_URL` público es el de `10.12.4.61` (VPN) o hay equivalente
   público? De esto depende si k6 necesita red interna.
4. ¿El context path en producción es `/sri-sanciones-servicio-internet`?
5. ¿A partir de qué RPS el servicio degrada? Define hasta dónde escalar y si se
   pide el barrido progresivo.

## Riesgos

1. **POST con efectos en producción** — no verificado que no persista.
   Mitigación: paso 4 del pre-flight.
2. **250 RPS sin think time** — variable de mayor impacto en producción.
   Mitigación: `THINK_TIME` por env + confirmación previa.
3. **Expiración del access_token** (2–5 min) — si expira a mitad de corrida,
   el tramo final se llena de 401 y falsea p95/p99. Mitigación: refresh
   proactivo con jitter + `Counter auth_errors`.
4. **Refresh token rotation en Keycloak 18+** — si rota, un refresh
   compartido se invalida mutuamente. Mitigación: cada VU tiene su propio
   token y el fallback a re-login.
5. **WAF / rate limit** — puede cortar la IP del generador y falsear
   resultados. Mitigación: paso 6; tratar 403/429 como hallazgo.
6. **Datos sensibles** — `data/*.json` solo con datos ficticios; el cuerpo del
   GET no se materializa en la carga (`responseType: 'none'`).
7. **Sesgo de caché de BD** — mitigación: rotación de 5–8 casos.
