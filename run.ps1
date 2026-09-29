<#
.SYNOPSIS
    Wrapper de la prueba de carga de sri-sanciones.

.DESCRIPTION
    Modo `smoke`  -> 1 VU / 1 iteracion, imprime cuerpos de respuesta.
    Modo `carga`  -> escenario completo con etapas y umbrales, archiva el
                      summary en results/summary-<timestamp>.json.

    NUNCA sube VUS_MAX por encima del techo acordado con infraestructura del
    SRI (parametro -MaxVus, hard cap 50 en el codigo del script).

.EXAMPLE
    .\run.ps1 smoke
.EXAMPLE
    .\run.ps1 carga -Vus 50 -Sosten 2m
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('smoke', 'carga', 'calibracion')]
    [string]$Modo = 'smoke',

    [int]$Vus = 0,
    [string]$Sosten = '',
    [string]$RampUp = '',
    [string]$RampDown = '',
    [double]$ThinkTime = -1,
    [string]$BaseUrl = '',
    [switch]$SaltarPreflight,

    # Techo de VU. Valores sobre 50 requieren autorizacion expresa y no deben
    # usarse contra produccion.
    [int]$MaxVus = 50
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root '.env'
$k6 = Get-Command k6 -ErrorAction SilentlyContinue

function Fail($msg) {
    Write-Host "[FAIL] $msg" -ForegroundColor Red
    exit 1
}

function Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }

if (-not $k6) { Fail 'k6 no esta en el PATH. Descargalo de https://grafana.com/docs/k6/latest/set-up/install-k6/ (binario nativo Windows).' }
Ok "k6: $($k6.Source)"

if (-not (Test-Path -LiteralPath $envFile)) {
    Fail "No existe $envFile. Copia .env.example a .env y completa SRI_USER / SRI_PASS."
}

# --- Pre-flight ---------------------------------------------------------------
if (-not $SaltarPreflight) {
    Info 'Pre-flight: la carga va contra produccion. Confirmar:'
    $preflight = @(
        '1. Autorizacion y ventana confirmadas con infraestructura del SRI (fecha, hora, IP de salida, VU maximos).'
        '2. Alguien del SRI pendiente durante toda la corrida.'
        '3. smoke.js en verde.'
        '4. POST confirmado como NO persistente (llamar 2 veces y revisar la UI de sanciones).'
        '5. RPS esperado validado: lazo cerrado => RPS ~= VU / latencia.'
        '6. IP del generador no bloqueada por WAF / balanceador.'
    )
    $preflight | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $resp = Read-Host 'Confirma el pre-flight (SI/NO)'
    if ($resp -notmatch '^(SI|S|s|Y|y|yes)$') { Fail 'Pre-flight no confirmado. Abortando.' }
    Ok 'Pre-flight confirmado'
}

# --- Parametros de corrida ----------------------------------------------------
$vars = @{}
if ($Vus -gt 0) {
    if ($Vus -gt $MaxVus) { Fail "Vus=$Vus excede el techo acordado ($MaxVus). Pide autorizacion expresa antes de subirlo." }
    $vars['VUS_MAX'] = "$Vus"
    $vars['VUS_RAMP'] = "$([Math]::Max(1, [Math]::Floor($Vus / 2.5)))"
}
if ($Sosten)     { $vars['SOSTEN'] = $Sosten }
if ($RampUp)     { $vars['RAMP_UP'] = $RampUp }
if ($RampDown)   { $vars['RAMP_DOWN'] = $RampDown }
if ($ThinkTime -ge 0) { $vars['THINK_TIME'] = "$ThinkTime" }
if ($BaseUrl)    { $vars['BASE_URL'] = $BaseUrl }

# --- Calculo de RPS para que el operador lo vea antes de disparar ------------
if ($Modo -eq 'carga' -and -not $vars.ContainsKey('THINK_TIME')) {
    $tt = [double]((Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*THINK_TIME=' } | Select-Object -First 1) -replace '^\s*THINK_TIME=', '').Trim()
    if ($tt -is [double] -and $tt -gt 0) {
        Warn "RPS estimado ~= VU / (latencia 0.2s + think ${tt}s). Verificar contra lo autorizado."
    } else {
        Warn 'Lazo cerrado (THINK_TIME=0): RPS ~= VU / latencia. 50 VU a 200ms => ~250 RPS. Si excede lo acordado, usa -ThinkTime 1.'
    }
}

$results = Join-Path $root 'results'
if (-not (Test-Path -LiteralPath $results)) { New-Item -ItemType Directory -Path $results | Out-Null }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$k6Args = @()
switch ($Modo) {
    'smoke'       { $script = 'k6\smoke.js';    $out = $null }
    'carga'       { $script = 'k6\loadtest.js'; $out = Join-Path $results "summary-$ts.json" }
    'calibracion' {
        # 2 VU / 30 s: verifica que el refresh NO se dispara durante el tramo.
        $script = 'k6\loadtest.js'
        $vars['RAMP_UP'] = '5s'; $vars['VUS_RAMP'] = '2'
        $vars['SOSTEN'] = '30s'; $vars['VUS_MAX'] = '2'
        $vars['RAMP_DOWN'] = '5s'
        $out = Join-Path $results "summary-calib-$ts.json"
    }
}
if ($out) { $k6Args += @('--summary-export', $out) }
$k6Args += @('--env-from-file=.env')
foreach ($k in $vars.Keys) { $k6Args += @('-e', "$k=$($vars[$k])") }
$k6Args += $script

Info "Modo: $Modo"
Info "k6 $($k6Args -join ' ')"
Info 'Umbrales: p95<2s, p99<5s, error<1%, checks>99%. Ctrl+C si p95>5s, error>5%, o hay 403/429.'

& $k6.Source @k6Args
$code = $LASTEXITCODE

if ($out) {
    if (Test-Path -LiteralPath $out) {
        Ok "Summary archivado en $out"
    } else {
        Warn "k6 termino con codigo $code pero no genero $out"
    }
}
exit $code
