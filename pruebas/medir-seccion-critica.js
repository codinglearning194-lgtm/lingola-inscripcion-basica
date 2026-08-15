/**
 * =========================================================
 * LINGOLA — Medición de la sección crítica
 * =========================================================
 *
 * Responde a la única pregunta que decide si 100 inscripciones simultáneas
 * salen adelante: ¿cuántas llamadas a Google Sheets ocurren MIENTRAS se
 * mantiene el bloqueo?
 *
 * Esas llamadas son las que se serializan. Todo lo demás (validación, token,
 * rate limiting, correos) sucede en paralelo y no forma cola.
 *
 *   tiempo de bloqueo por inscripción = llamadas dentro del lock × latencia
 *   caudal = 1 / tiempo de bloqueo
 *
 * El simulador no tiene latencia de red, así que aquí se CUENTAN las llamadas
 * y el tiempo se proyecta con latencias reales observadas en Apps Script.
 *
 *   node pruebas/medir-seccion-critica.js
 */

const { sandbox, stats, lockState, libro, cache } = require('./simulador-apps-script.js');

// ── Se instrumenta el contador para separar dentro/fuera del bloqueo ──
let dentroDelLock = 0;
let fueraDelLock  = 0;

const statsOriginal = Object.getOwnPropertyDescriptor(stats, 'llamadasSheets');
let _valor = stats.llamadasSheets;
Object.defineProperty(stats, 'llamadasSheets', {
  get() { return _valor; },
  set(v) {
    if (v > _valor && lockState.held) dentroDelLock++;
    else if (v > _valor) fueraDelLock++;
    _valor = v;
  },
  configurable: true
});

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

const LETRAS = ['cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve'];
const enLetras = n => String(n).split('').map(d => LETRAS[Number(d)]).join(' ');

function payload(i) {
  const g = GRUPOS[i % GRUPOS.length];
  return {
    nombre: 'Estudiante ' + enLetras(i),
    whatsapp: '809555' + String(1000 + i),
    correo: 'alumno' + i + '@ejemplo.com',
    dias: g[0], grupo: g[1], horario: g[2],
    aceptoTerminos: true,
    submissionId: 'medir-' + i
  };
}

cache.mapa.clear();
sandbox.setup();

// setup() también toca la hoja: se descuenta.
dentroDelLock = 0;
fueraDelLock  = 0;

const N = 100;
for (let i = 1; i <= N; i++) {
  sandbox.procesarInscripcion_(payload(i), { omitirToken: true });
}

const porInscripcionDentro = dentroDelLock / N;
const porInscripcionFuera  = fueraDelLock / N;

console.log('\n' + '═'.repeat(70));
console.log(' MEDICIÓN DE LA SECCIÓN CRÍTICA — ' + N + ' inscripciones');
console.log('═'.repeat(70));
console.log('\n  Llamadas a Sheets DENTRO del bloqueo : ' + dentroDelLock +
            '  → ' + porInscripcionDentro.toFixed(2) + ' por inscripción  ← se serializan');
console.log('  Llamadas a Sheets FUERA del bloqueo  : ' + fueraDelLock +
            '  → ' + porInscripcionFuera.toFixed(2) + ' por inscripción  (en paralelo)');

// ── Proyección con latencias reales de la API de Sheets ──
// Rango observado habitualmente en Apps Script por llamada simple.
console.log('\n' + '─'.repeat(70));
console.log(' PROYECCIÓN: cuánto tarda en drenar la cola de 100');
console.log('─'.repeat(70));
console.log('\n  latencia/llamada │ bloqueo/inscr. │ caudal   │ 100 inscripciones');
console.log('  ─────────────────┼────────────────┼──────────┼──────────────────');

for (const latencia of [60, 100, 150, 200, 300]) {
  const bloqueo = porInscripcionDentro * latencia / 1000;
  const caudal  = 1 / bloqueo;
  const total   = bloqueo * N;
  const aviso   = total > 180 ? '  ⚠️' : '';
  console.log('  ' + String(latencia + ' ms').padStart(14) + '   │ ' +
              (bloqueo.toFixed(2) + ' s').padStart(13) + '  │ ' +
              (caudal.toFixed(1) + '/s').padStart(7) + '  │ ' +
              (total.toFixed(0) + ' s').padStart(6) + aviso);
}

const esperaLock = sandbox.CONFIG.seguridad.esperaLockMs / 1000;
console.log('\n  Espera máxima del bloqueo configurada: ' + esperaLock + ' s');
console.log('  Reintentos del frontend: 4 → ventana total de ~' +
            (esperaLock * 4 + 15).toFixed(0) + ' s por estudiante');
console.log('\n  Interpretación: si "100 inscripciones" cabe dentro de esa ventana,');
console.log('  nadie se queda fuera. Si la supera, los últimos agotan los reintentos.');
console.log('\n  ⚠️  Estas latencias son ESTIMADAS. El dato real solo se obtiene');
console.log('      ejecutando pruebas-concurrencia.js contra el backend desplegado.\n');
