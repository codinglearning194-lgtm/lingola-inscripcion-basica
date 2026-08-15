/**
 * =========================================================
 * LINGOLA — Prueba de concurrencia contra el backend real
 * =========================================================
 *
 * Lanza N solicitudes HTTP verdaderamente simultáneas contra el Web App de
 * Apps Script para comprobar cómo se comporta bajo carga. A diferencia de
 * las funciones de prueba del editor, aquí sí hay paralelismo real: es la
 * única forma de observar el bloqueo, la cola y el límite de 30 ejecuciones
 * simultáneas que impone Google.
 *
 * ─────────────────────────────────────────────────────────
 * USO
 * ─────────────────────────────────────────────────────────
 *
 *   Modo lectura (seguro, por defecto) — NO escribe ni envía correos:
 *     node pruebas-concurrencia.js
 *     node pruebas-concurrencia.js --n=100
 *
 *   Modo escritura — SÍ registra inscripciones y SÍ envía correos:
 *     node pruebas-concurrencia.js --escribir --n=20 --confirmo
 *
 * ─────────────────────────────────────────────────────────
 * ⚠️  ANTES DE USAR EL MODO ESCRITURA
 * ─────────────────────────────────────────────────────────
 *   • Cada inscripción con éxito consume DOS correos de la cuota diaria
 *     (100/día en una cuenta Gmail personal). 20 inscripciones = 40 correos.
 *   • Las filas se escriben en la hoja real. Ejecuta setup() en Apps Script
 *     después para dejarla limpia, o usa una copia del documento.
 *   • Los cupos son 15 por grupo: por encima de eso las respuestas serán
 *     CUPO_LLENO, lo cual es correcto y esperado.
 *
 * Requiere Node 18 o superior (usa fetch nativo).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Argumentos ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.some(a => a === '--' + n);
const valor = (n, def) => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=')[1] : def;
};

const TOTAL     = parseInt(valor('n', '100'), 10);
const ESCRIBIR  = flag('escribir');
const CONFIRMO  = flag('confirmo');
const URL_MANUAL = valor('url', '');

// Peticiones en vuelo a la vez. Por debajo de las 30 ejecuciones simultáneas
// de Apps Script y, sobre todo, por debajo del umbral con el que Google
// estrangula las ráfagas procedentes de una sola IP (ver conLimite).
const CONCURRENCIA = parseInt(valor('concurrencia', '25'), 10);

// ── URL del backend ───────────────────────────────────────────────────────
function leerUrlDeConfig() {
  try {
    const texto = fs.readFileSync(path.join(__dirname, 'lingola-config.js'), 'utf8');
    const m = texto.match(/gasWebAppUrl:\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

const URL = URL_MANUAL || leerUrlDeConfig();

if (!URL || !URL.includes('/macros/s/') || !URL.endsWith('/exec')) {
  console.error('❌ No se encontró una URL válida del Web App.');
  console.error('   Revisa lingola-config.js o pasa --url=https://script.google.com/macros/s/.../exec');
  process.exit(1);
}

if (ESCRIBIR && !CONFIRMO) {
  console.error('❌ El modo escritura registra inscripciones reales y envía correos reales.');
  console.error('   Si es lo que quieres, añade --confirmo:');
  console.error('     node pruebas-concurrencia.js --escribir --n=20 --confirmo');
  process.exit(1);
}

// ── Datos de prueba ───────────────────────────────────────────────────────
const GRUPOS = [
  ['Lunes y Jueves',   'Primer grupo de la mañana',  '9:00 AM – 10:30 AM'],
  ['Lunes y Jueves',   'Segundo grupo de la mañana', '11:00 AM – 12:30 PM'],
  ['Lunes y Jueves',   'Primer grupo de la tarde',   '2:00 PM – 3:30 PM'],
  ['Lunes y Jueves',   'Segundo grupo de la tarde',  '4:00 PM – 5:30 PM'],
  ['Martes y Viernes', 'Primer grupo de la mañana',  '9:00 AM – 10:30 AM'],
  ['Martes y Viernes', 'Segundo grupo de la mañana', '11:00 AM – 12:30 PM'],
  ['Martes y Viernes', 'Primer grupo de la tarde',   '2:00 PM – 3:30 PM'],
  ['Martes y Viernes', 'Segundo grupo de la tarde',  '4:00 PM – 5:30 PM']
];

const LETRAS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const enLetras = (n) => String(n).split('').map(d => LETRAS[Number(d)]).join(' ');

const SELLO = Date.now().toString(36);

function construirPayload(i, token) {
  const g = GRUPOS[i % GRUPOS.length];
  return {
    nivel: 'Inglés Básico',
    nombre: 'Prueba Carga ' + enLetras(i),
    whatsapp: '809555' + String(1000 + i),
    email: 'carga-' + SELLO + '-' + i + '@ejemplo-pruebas.test',
    dias: g[0],
    grupo: g[1],
    horario: g[2],
    aceptoTerminos: true,
    submissionId: 'carga-' + SELLO + '-' + i,
    token: token || ''
  };
}

// ── Llamadas al backend ───────────────────────────────────────────────────
async function medir(fn) {
  const t0 = Date.now();
  try {
    const dato = await fn();
    return { ok: true, ms: Date.now() - t0, dato };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
}

/**
 * Ejecuta las tareas con un número máximo de peticiones en vuelo.
 *
 * ⚠️ POR QUÉ EXISTE ESTO
 * Lanzar 100 fetch simultáneos desde una sola máquina NO simula a 100
 * usuarios: simula a un atacante. Medido contra el backend real, la primera
 * ráfaga de 100 pasó entera (5,6 s), pero una segunda ráfaga inmediata
 * falló al 100% con "fetch failed" — Google estrangula por origen, no por
 * script. El endpoint se recuperó de inmediato para peticiones normales.
 *
 * Es decir: sin este límite la prueba mide el estrangulamiento de Google
 * desde tu IP, no la capacidad del backend. Cien usuarios reales llegan
 * desde cien redes distintas y no disparan esa protección.
 *
 * CONCURRENCIA por defecto = 25, por debajo del límite de 30 ejecuciones
 * simultáneas de Apps Script. Súbelo solo si sabes lo que estás midiendo.
 *
 * @param {Array<Function>} tareas - Funciones que devuelven una promesa.
 * @param {number} limite - Máximo de peticiones en vuelo a la vez.
 * @param {number} pausaMs - Pausa entre tandas, para no encadenar ráfagas.
 */
async function conLimite(tareas, limite, pausaMs) {
  const resultados = new Array(tareas.length);
  let siguiente = 0;

  async function trabajador() {
    while (siguiente < tareas.length) {
      const idx = siguiente++;
      resultados[idx] = await tareas[idx]();
      if (pausaMs) await new Promise(r => setTimeout(r, pausaMs));
    }
  }

  const trabajadores = [];
  for (let i = 0; i < Math.min(limite, tareas.length); i++) {
    trabajadores.push(trabajador());
  }
  await Promise.all(trabajadores);

  return resultados;
}

async function pedirToken() {
  const r = await fetch(URL + '?action=token&t=' + Math.random());
  const j = await r.json();
  if (j.status !== 'success' || !j.token) {
    const e = new Error(j.message || 'sin token');
    e.code = j.code;
    throw e;
  }
  return j.token;
}

async function consultarDisponibilidad() {
  const r = await fetch(URL + '?action=disponibilidad&t=' + Math.random());
  return r.json();
}

async function inscribir(payload) {
  const r = await fetch(URL, {
    method: 'POST',
    redirect: 'follow',
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── Informe ───────────────────────────────────────────────────────────────
function percentil(valores, p) {
  if (!valores.length) return 0;
  const orden = valores.slice().sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor(orden.length * p / 100))];
}

function resumirTiempos(titulo, ms) {
  if (!ms.length) { console.log('   ' + titulo + ': sin datos'); return; }
  const media = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  console.log('   ' + titulo + ': media ' + media + ' ms · p50 ' + percentil(ms, 50) +
              ' ms · p95 ' + percentil(ms, 95) + ' ms · máx ' + Math.max(...ms) + ' ms');
}

function agrupar(lista, clave) {
  const m = {};
  lista.forEach(x => { const k = clave(x); m[k] = (m[k] || 0) + 1; });
  return m;
}

// ── Programa principal ────────────────────────────────────────────────────
(async function main() {
  console.log('');
  console.log('═'.repeat(72));
  console.log(' PRUEBA DE CONCURRENCIA — Backend Lingola');
  console.log('═'.repeat(72));
  console.log(' Endpoint : ' + URL.slice(0, 60) + '…');
  console.log(' Modo     : ' + (ESCRIBIR ? '⚠️  ESCRITURA (registra y envía correos)' : 'lectura (no escribe nada)'));
  console.log(' Peticiones simultáneas: ' + TOTAL);
  console.log('');

  // ── Estado inicial ──
  const inicial = await medir(consultarDisponibilidad);
  if (!inicial.ok) {
    console.error('❌ El backend no responde: ' + inicial.error);
    process.exit(1);
  }
  const ocupadosAntes = inicial.dato.grupos.reduce((a, g) => a + g.inscritos, 0);
  console.log('▸ Estado inicial: ' + ocupadosAntes + ' inscritos en total');
  console.log('  (primera consulta de disponibilidad: ' + inicial.ms + ' ms)');

  // ── FASE A: avalancha de lecturas ──
  console.log('\n▸ FASE A — ' + TOTAL + ' consultas de disponibilidad simultáneas');
  console.log('  Comprueba que la caché del servidor absorbe la carga de lectura.');
  const tA = Date.now();
  const lecturas = await conLimite(
    Array.from({ length: TOTAL }, () => () => medir(consultarDisponibilidad)),
    CONCURRENCIA, 0
  );
  const okLecturas = lecturas.filter(r => r.ok && r.dato && r.dato.status === 'success');
  console.log('  Respuestas correctas: ' + okLecturas.length + ' de ' + TOTAL +
              ' · total ' + (Date.now() - tA) + ' ms');
  resumirTiempos('Latencia', lecturas.filter(r => r.ok).map(r => r.ms));
  const fallosA = lecturas.filter(r => !r.ok);
  if (fallosA.length) console.log('  ⚠️  Fallos de red/HTTP: ' + fallosA.length +
                                  ' → ' + JSON.stringify(agrupar(fallosA, f => f.error)));

  // ── FASE B: avalancha de tokens ──
  console.log('\n▸ FASE B — ' + TOTAL + ' emisiones de token simultáneas');
  const tB = Date.now();
  const tokens = await conLimite(
    Array.from({ length: TOTAL }, () => () => medir(pedirToken)),
    CONCURRENCIA, 0
  );
  const tokensOk = tokens.filter(t => t.ok);
  console.log('  Tokens emitidos: ' + tokensOk.length + ' de ' + TOTAL +
              ' · total ' + (Date.now() - tB) + ' ms');
  resumirTiempos('Latencia', tokensOk.map(r => r.ms));

  const distintos = new Set(tokensOk.map(t => t.dato));
  console.log('  Tokens distintos entre sí: ' + distintos.size + ' de ' + tokensOk.length +
              (distintos.size === tokensOk.length ? ' ✅' : ' ❌ ¡se repitieron!'));

  if (!ESCRIBIR) {
    console.log('\n' + '─'.repeat(72));
    console.log(' Modo lectura completado. Nada se escribió en Google Sheets.');
    console.log(' Para probar el registro real bajo carga:');
    console.log('   node pruebas-concurrencia.js --escribir --n=20 --confirmo');
    console.log('─'.repeat(72) + '\n');
    return;
  }

  // ── FASE C: avalancha de inscripciones ──
  console.log('\n▸ FASE C — ' + TOTAL + ' inscripciones simultáneas');
  console.log('  Todas se lanzan a la vez: el backend debe serializarlas con el bloqueo.');

  const tC = Date.now();
  const envios = await conLimite(
    Array.from({ length: TOTAL }, (_, i) => () =>
      medir(() => inscribir(construirPayload(i, tokensOk[i] ? tokensOk[i].dato : '')))
    ),
    CONCURRENCIA, 0
  );
  const duracionC = Date.now() - tC;

  const conRespuesta = envios.filter(e => e.ok && e.dato);
  const exitos     = conRespuesta.filter(e => e.dato.status === 'success' && !e.dato.duplicado);
  const duplicados = conRespuesta.filter(e => e.dato.status === 'success' && e.dato.duplicado);
  const rechazos   = conRespuesta.filter(e => e.dato.status === 'error');
  const caidas     = envios.filter(e => !e.ok);

  console.log('\n  ── Resultado ──');
  console.log('  Registradas : ' + exitos.length);
  console.log('  Duplicadas  : ' + duplicados.length);
  console.log('  Rechazadas  : ' + rechazos.length +
              (rechazos.length ? ' → ' + JSON.stringify(agrupar(rechazos, r => r.dato.code)) : ''));
  console.log('  Sin respuesta (red/HTTP): ' + caidas.length +
              (caidas.length ? ' → ' + JSON.stringify(agrupar(caidas, c => c.error)) : ''));
  console.log('  Duración total: ' + duracionC + ' ms');
  resumirTiempos('Latencia', envios.filter(e => e.ok).map(e => e.ms));

  // ── Verificación de integridad ──
  console.log('\n  ── Verificación de integridad ──');

  const filas = exitos.map(e => e.dato.fila).filter(f => f > 0);
  const filasUnicas = new Set(filas);
  console.log('  ' + (filasUnicas.size === filas.length ? '✅' : '❌') +
              ' Filas asignadas sin colisión: ' + filasUnicas.size + ' distintas de ' + filas.length);

  // La disponibilidad se cachea unos segundos: se espera a que caduque.
  console.log('  (esperando a que caduque la caché de disponibilidad…)');
  await new Promise(r => setTimeout(r, 25000));

  const final = await medir(consultarDisponibilidad);
  if (final.ok) {
    const ocupadosDespues = final.dato.grupos.reduce((a, g) => a + g.inscritos, 0);
    const esperado = ocupadosAntes + exitos.length;
    console.log('  ' + (ocupadosDespues === esperado ? '✅' : '❌') +
                ' Inscritos en la hoja: ' + ocupadosDespues +
                ' (esperado ' + esperado + ')');

    const excedidos = final.dato.grupos.filter(g => g.inscritos > g.limite);
    console.log('  ' + (excedidos.length === 0 ? '✅' : '❌') +
                ' Ningún grupo por encima del límite de ' + final.dato.limite);
  }

  // ── Idempotencia: se repite el primer envío ──
  console.log('\n  ── Idempotencia ──');
  const repetido = await medir(() => inscribir(construirPayload(0, '')));
  if (repetido.ok && repetido.dato.status === 'success' && repetido.dato.duplicado) {
    console.log('  ✅ Reenviar el mismo submissionId devuelve "duplicado", sin crear otra fila');
  } else if (repetido.ok) {
    console.log('  ℹ️  Respuesta al reenvío: ' + JSON.stringify(repetido.dato).slice(0, 160));
  }

  console.log('\n' + '─'.repeat(72));
  console.log(' ⚠️  Se escribieron ' + exitos.length + ' filas y se enviaron ~' +
              (exitos.length * 2) + ' correos.');
  console.log('    Ejecuta setup() en el editor de Apps Script para limpiar la hoja.');
  console.log('─'.repeat(72) + '\n');
})().catch(err => {
  console.error('\n❌ Error inesperado en la prueba: ' + err.message);
  process.exit(1);
});
