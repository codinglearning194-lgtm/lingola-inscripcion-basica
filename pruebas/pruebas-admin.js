/**
 * Panel de administración: liberar un grupo lleno archivando sus inscripciones.
 *
 * Comprueba las tres cosas que importan de esta función:
 *   • que solo entre quien tiene la contraseña,
 *   • que ninguna fila se pierda por el camino,
 *   • que el grupo vuelva a admitir inscripciones después.
 */
const { sandbox, libro, cache, propiedades } = require('./simulador-apps-script.js');

let fallos = 0;
const ok = (c, t, d) => {
  if (c) console.log('   ✅ ' + t);
  else { fallos++; console.log('   ❌ ' + t + (d !== undefined ? ' → ' + JSON.stringify(d) : '')); }
};
const seccion = (t) => console.log('\n' + '═'.repeat(70) + '\n ' + t + '\n' + '═'.repeat(70));

const CLAVE = 'clave-de-prueba-123';
const GRUPO = { dias: 'Lunes y Jueves', grupo: 'Primer grupo de la mañana', horario: '9:00 AM – 10:30 AM' };
const OTRO  = { dias: 'Martes y Viernes', grupo: 'Segundo grupo de la tarde', horario: '4:00 PM – 5:30 PM' };

const post = (cuerpo) => JSON.parse(
  sandbox.doPost({ postData: { type: 'text/plain', contents: JSON.stringify(cuerpo) } }).texto
);

const liberar = (extra) => post(Object.assign({ action: 'liberar-grupo', clave: CLAVE }, GRUPO, extra || {}));

/** Cupos libres de un grupo, leídos como los lee el formulario. */
function disponiblesDe(g) {
  cache.remove('disp_v4');
  const grupos = sandbox.obtenerDisponibilidad_();
  const fila = grupos.filter(x => x.dias === g.dias.toUpperCase() && x.grupo === g.grupo)[0];
  return fila ? fila.disponibles : null;
}

/** El backend no admite dígitos en el nombre: "12" → "uno dos". */
const LETRAS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const enLetras = (n) => String(n).split('').map(d => LETRAS[Number(d)]).join(' ');

function inscribir(i, g) {
  return sandbox.procesarInscripcion_({
    nombre: 'Estudiante ' + enLetras(i),
    whatsapp: '809555' + String(1000 + i),
    correo: 'alumno' + i + '@ejemplo.com',
    dias: g.dias, grupo: g.grupo, horario: g.horario,
    aceptoTerminos: true,
    submissionId: 'env-' + g.grupo.slice(0, 6) + '-' + i
  }, { omitirToken: true });
}

/** Filas con datos de la hoja de archivo (sin la cabecera). */
function filasArchivadas() {
  const hoja = libro.getSheetByName('Archivo de inscripciones');
  if (!hoja) return [];
  const filas = [];
  for (let r = 2; r <= hoja.getLastRow(); r++) {
    const fila = [];
    for (let c = 1; c <= 9; c++) fila.push(hoja.leer(r, c));
    if (String(fila[0]).trim()) filas.push(fila);
  }
  return filas;
}

cache.mapa.clear();
propiedades.mapa.clear();
sandbox.setup();

console.log('\n═══ ADMINISTRACIÓN: liberar un grupo ═══');

// ── 1. Sin contraseña configurada, el panel no deja pasar ──
seccion('PRUEBA 1 — El panel está cerrado mientras no se configure una clave');
const sinClave = liberar();
ok(sinClave.status === 'error' && sinClave.code === 'NO_AUTORIZADO',
   'Sin contraseña guardada, liberar un grupo se rechaza', sinClave);

// ── 2. La contraseña se guarda como huella, nunca en claro ──
seccion('PRUEBA 2 — Registro de la contraseña');
let rechazoCorta = null;
try { sandbox.guardarClaveAdministrador('corta'); }
catch (e) { rechazoCorta = e.message; }
ok(rechazoCorta !== null, 'Una contraseña de menos de 8 caracteres se rechaza', rechazoCorta);

sandbox.guardarClaveAdministrador(CLAVE);
const guardado = propiedades.getProperty('LINGOLA_ADMIN_CLAVE');
ok(!!guardado, 'La contraseña queda registrada en las propiedades del script');
ok(guardado.indexOf(CLAVE) === -1, 'Lo guardado NO contiene la contraseña en claro', guardado);
ok(/^[^:]+:[0-9a-f]{64}$/.test(guardado), 'Se guarda como "sal:huella SHA-256"', guardado);

// ── 3. Un grupo lleno ──
seccion('PRUEBA 3 — Se llena el grupo hasta el tope');
for (let i = 1; i <= 15; i++) inscribir(i, GRUPO);
for (let i = 101; i <= 103; i++) inscribir(i, OTRO);
ok(disponiblesDe(GRUPO) === 0, 'El grupo queda sin cupos (0 de 15)', disponiblesDe(GRUPO));
ok(disponiblesDe(OTRO) === 12, 'Otro grupo tiene sus 3 inscripciones', disponiblesDe(OTRO));

// ── 4. Contraseña incorrecta: nada se toca ──
seccion('PRUEBA 4 — Contraseña incorrecta');
const malaClave = post(Object.assign({ action: 'liberar-grupo', clave: 'no-es-la-clave' }, GRUPO));
ok(malaClave.status === 'error' && malaClave.code === 'NO_AUTORIZADO',
   'Una contraseña incorrecta se rechaza', malaClave);
ok(disponiblesDe(GRUPO) === 0, 'El grupo sigue lleno tras el intento fallido', disponiblesDe(GRUPO));
ok(filasArchivadas().length === 0, 'No se archivó nada');

// ── 5. Por GET no se acepta: la contraseña no puede ir en una URL ──
seccion('PRUEBA 5 — La acción no existe por GET');
const porGet = JSON.parse(sandbox.doGet({
  parameter: { action: 'liberar-grupo', clave: CLAVE, dias: GRUPO.dias, grupo: GRUPO.grupo, horario: GRUPO.horario }
}).texto);
ok(porGet.status === 'error' && porGet.code === 'NO_AUTORIZADO',
   'Liberar por GET se rechaza aunque la contraseña sea correcta', porGet);
ok(disponiblesDe(GRUPO) === 0, 'El grupo sigue lleno tras el intento por GET', disponiblesDe(GRUPO));

// ── 6. Liberación correcta ──
seccion('PRUEBA 6 — Liberación con la contraseña correcta');
const resultado = liberar();
ok(resultado.status === 'success', 'La liberación se completa', resultado);
ok(resultado.movidos === 15, 'Se movieron las 15 inscripciones', resultado.movidos);
ok(disponiblesDe(GRUPO) === 15, 'El grupo vuelve a 15 cupos libres', disponiblesDe(GRUPO));
ok(disponiblesDe(OTRO) === 12, 'Los demás grupos no se tocaron', disponiblesDe(OTRO));

// ── 7. Ninguna fila se perdió ──
seccion('PRUEBA 7 — Los datos siguen existiendo en la hoja de archivo');
const archivadas = filasArchivadas();
ok(archivadas.length === 15, 'La hoja de archivo tiene las 15 filas', archivadas.length);

const correos = archivadas.map(f => f[6]).sort();
const esperados = [];
for (let i = 1; i <= 15; i++) esperados.push('alumno' + i + '@ejemplo.com');
ok(JSON.stringify(correos) === JSON.stringify(esperados.sort()),
   'Los 15 correos se conservan intactos', correos.slice(0, 3));

ok(archivadas.every(f => f[1] === 'LUNES Y JUEVES — Primer grupo de la mañana'),
   'Cada fila archivada dice de qué grupo salió', archivadas[0] && archivadas[0][1]);
ok(archivadas.every(f => /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(String(f[0]))),
   'Cada fila archivada lleva la fecha en que se liberó', archivadas[0] && archivadas[0][0]);
ok(archivadas.every(f => f[3] === 'Inglés Básico'),
   'El nivel archivado es el del servidor', archivadas[0] && archivadas[0][3]);

// ── 8. El grupo vuelve a admitir inscripciones ──
seccion('PRUEBA 8 — El formulario vuelve a aceptar ese grupo');
const nuevo = inscribir(200, GRUPO);
ok(nuevo && nuevo.status === 'success', 'Se puede inscribir a alguien nuevo en el grupo liberado', nuevo);
ok(disponiblesDe(GRUPO) === 14, 'El recuento arranca de cero (14 libres)', disponiblesDe(GRUPO));

// Un correo ya archivado deja de contar como duplicado global.
const repetido = sandbox.procesarInscripcion_({
  nombre: 'Estudiante uno', whatsapp: '8095551001',
  correo: 'alumno1@ejemplo.com', dias: GRUPO.dias, grupo: GRUPO.grupo, horario: GRUPO.horario,
  aceptoTerminos: true, submissionId: 'reinscripcion-1'
}, { omitirToken: true });
ok(repetido.duplicado === false, 'Alguien archivado puede volver a inscribirse', repetido);

// ── 9. Liberar dos veces seguidas no rompe nada ──
seccion('PRUEBA 9 — Liberar un grupo ya vacío');
liberar();                       // deja el grupo vacío otra vez
const vacio = liberar();         // y ahora ya no hay nada que mover
ok(vacio.status === 'success' && vacio.movidos === 0,
   'Liberar un grupo vacío responde sin error y sin mover nada', vacio);

// ── 10. Los intentos de contraseña están limitados ──
seccion('PRUEBA 10 — Límite de intentos');
cache.mapa.clear();
let bloqueado = null;
for (let i = 0; i < 12 && !bloqueado; i++) {
  const r = post(Object.assign({ action: 'liberar-grupo', clave: 'intento-' + i }, GRUPO));
  if (r.code === 'DEMASIADAS_SOLICITUDES') bloqueado = i + 1;
}
ok(bloqueado !== null, 'Probar contraseñas en bucle acaba bloqueado', bloqueado);
ok(bloqueado <= 9, 'El bloqueo llega dentro del límite configurado (8)', bloqueado);

console.log('\n' + (fallos === 0 ? '✅ Administración: todo correcto.' : '❌ ' + fallos + ' fallo(s).') + '\n');
process.exit(fallos ? 1 : 0);
