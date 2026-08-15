/**
 * FASE 4 y 5 — Batería de pruebas del backend Lingola.
 * Ejecuta el código real de backend-ingles-basico.gs sobre los servicios
 * simulados de harness.js.
 */

const { sandbox, stats, lockState, libro, cache, propiedades } = require('./simulador-apps-script.js');

let pasadas = 0, fallidas = 0;
const fallos = [];

function ok(cond, titulo, detalle) {
  if (cond) { pasadas++; console.log('   ✅ ' + titulo); }
  else {
    fallidas++; fallos.push(titulo);
    console.log('   ❌ ' + titulo + (detalle !== undefined ? '  → ' + JSON.stringify(detalle) : ''));
  }
}

function seccion(t) { console.log('\n' + '═'.repeat(70) + '\n ' + t + '\n' + '═'.repeat(70)); }

function reiniciar() {
  cache.mapa.clear();
  stats.vigilarLock = false;
  stats.mutacionesSinLock = [];
  sandbox.setup();
}

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

/** Convierte un número en letras para generar nombres válidos ("uno-dos-tres"). */
const LETRAS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
function enLetras(n) {
  return String(n).split('').map(d => LETRAS[Number(d)]).join(' ');
}

function payload(i, idxGrupo) {
  const g = GRUPOS[idxGrupo % GRUPOS.length];
  return {
    nombre: 'Estudiante ' + enLetras(i),
    whatsapp: '809555' + String(1000 + i),
    correo: 'alumno' + i + '@ejemplo.com',
    dias: g[0], grupo: g[1], horario: g[2],
    aceptoTerminos: true,
    submissionId: 'env-' + i
  };
}

const enviar = (d, o) => sandbox.procesarInscripcion_(d, o || { omitirToken: true });

function intentar(d, o) {
  try { return { ok: true, r: enviar(d, o) }; }
  catch (e) { return { ok: false, code: e.codigoLingola, message: e.message, err: e }; }
}

/** Lee todas las filas de estudiantes escritas en la hoja simulada. */
function filasEscritas() {
  const hoja = libro.getSheetByName('Inscripciones Básico');
  const snap = sandbox.leerSnapshot_(hoja, true);
  const filas = [];
  for (const clave of snap.orden) {
    const s = snap.secciones[clave];
    for (let r = s.filaInicio; r < s.filaProximoEncabezado; r++) {
      if (String(hoja.leer(r, 1)).trim()) {
        filas.push({ fila: r, grupo: clave, nombre: hoja.leer(r, 3),
                     whatsapp: hoja.leer(r, 4), correo: hoja.leer(r, 5) });
      }
    }
  }
  return filas;
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 1 — Solicitud normal');
reiniciar();
{
  const antes = stats.llamadasSheets;
  const r = enviar(payload(1, 0));
  const llamadas = stats.llamadasSheets - antes;

  ok(r.status === 'success', 'La inscripción se registra con status success');
  ok(r.duplicado === false, 'No se marca como duplicada');
  ok(r.inscritos === 1 && r.disponibles === 14, 'El recuento de cupos es correcto', r);
  // El aviso al administrador está desactivado (CONFIG.correos), así que
  // cada inscripción gasta UN solo correo de la cuota diaria en lugar de dos.
  ok(r.correos.estudiante, 'Se envía la confirmación al estudiante');
  ok(r.correos.administrador === false,
     'NO se envía aviso al administrador: solo 1 correo de cuota por inscripción');

  const f = filasEscritas();
  ok(f.length === 1, 'Existe exactamente una fila en la hoja', f.length);
  ok(f[0].correo === 'alumno1@ejemplo.com', 'El correo se guardó correctamente', f[0]);
  console.log('   ℹ️  Llamadas a SpreadsheetApp en esta inscripción: ' + llamadas);
}

// ══════════════════════════════════════════════════════════════════════════
// El interruptor del aviso al administrador funciona en ambos sentidos
// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 1B — Interruptor del correo al administrador');
reiniciar();
{
  const correosAntes = stats.correosEnviados;
  enviar(payload(50, 0));
  ok(stats.correosEnviados - correosAntes === 1,
     'Con notificarAdministrador=false se gasta 1 correo por inscripción',
     stats.correosEnviados - correosAntes);

  // Se reactiva para comprobar que la plantilla del administrador sigue viva.
  sandbox.CONFIG.correos.notificarAdministrador = true;
  reiniciar();
  const conAviso = stats.correosEnviados;
  const r2 = enviar(payload(51, 0));
  ok(r2.correos.estudiante && r2.correos.administrador,
     'Al reactivarlo vuelven a enviarse los dos correos');
  ok(stats.correosEnviados - conAviso === 2,
     'Con notificarAdministrador=true se gastan 2 correos por inscripción',
     stats.correosEnviados - conAviso);

  sandbox.CONFIG.correos.notificarAdministrador = false; // se deja como en producción
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 2 — Datos inválidos y manipulados');
reiniciar();
{
  const base = (extra) => Object.assign(payload(90, 0), extra);
  const casos = [
    ['payload nulo', null],
    ['payload array', []],
    ['payload string', 'hola'],
    ['nombre numérico', base({ nombre: 12345 })],
    ['nombre objeto', base({ nombre: { $ne: null } })],
    ['nombre de 2 letras', base({ nombre: 'Al' })],
    ['nombre de 500 caracteres', base({ nombre: 'a'.repeat(500) })],
    ['nombre con fórmula', base({ nombre: '=IMPORTXML("http://x","//a")' })],
    ['nombre con script', base({ nombre: '<script>alert(1)</script>' })],
    ['whatsapp vacío', base({ whatsapp: '' })],
    ['whatsapp con letras', base({ whatsapp: 'llamame' })],
    ['whatsapp de 3 dígitos', base({ whatsapp: '123' })],
    ['whatsapp de 40 dígitos', base({ whatsapp: '1'.repeat(40) })],
    ['correo ausente', base({ correo: '', email: '' })],
    ['correo malformado', base({ correo: 'ana@@ejemplo' })],
    ['correo sin dominio', base({ correo: 'ana@ejemplo' })],
    ['correo de 300 caracteres', base({ correo: 'a'.repeat(290) + '@x.com' })],
    ['días inventados', base({ dias: 'SABADOS Y DOMINGOS' })],
    ['días vacíos', base({ dias: '' })],
    ['grupo inexistente', base({ grupo: 'zzz', horario: '' })],
    ['grupo = "constructor"', base({ grupo: 'constructor', horario: '' })],
    ['grupo = "toString"', base({ grupo: 'toString', horario: '' })],
    ['sin aceptar términos', base({ aceptoTerminos: false })],
    ['términos ausentes', base({ aceptoTerminos: undefined })],
    ['submissionId con rutas', base({ submissionId: '../../etc/passwd' })]
  ];

  let rechazados = 0, noControlados = 0;
  for (const [titulo, datos] of casos) {
    const res = intentar(datos);
    if (res.ok) { console.log('   ❌ ACEPTADO indebidamente: ' + titulo); fallidas++; }
    else if (res.code === 'DATOS_INVALIDOS') rechazados++;
    else { console.log('   ❌ Error NO controlado en "' + titulo + '": ' + res.message); noControlados++; fallidas++; }
  }
  ok(rechazados === casos.length, 'Las ' + casos.length + ' entradas inválidas se rechazan con DATOS_INVALIDOS',
     { rechazados, noControlados });
  ok(filasEscritas().length === 0, 'Ninguna entrada inválida llegó a escribir en la hoja');
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 3 — Bug corregido: grupo mal resuelto');
reiniciar();
{
  // Antes: horario vacío + grupo basura → indexOf('') coincidía con la
  // primera clave y el estudiante acababa en "Primer grupo de la mañana".
  const res = intentar({
    nombre: 'Intruso Silencioso', whatsapp: '8095551234',
    correo: 'intruso@ejemplo.com', dias: 'LUNES Y JUEVES',
    grupo: 'zzz', horario: '', aceptoTerminos: true
  });
  ok(!res.ok && res.code === 'DATOS_INVALIDOS', 'Un grupo desconocido con horario vacío se rechaza', res);
  ok(filasEscritas().length === 0, 'No se registró a nadie en un grupo que no eligió');
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 4 — Inyección de fórmulas en Google Sheets');
reiniciar();
{
  // El nombre no admite "=" (queda descartado en la validación), pero el
  // WhatsApp sí empieza legítimamente por "+": debe quedar neutralizado.
  enviar(Object.assign(payload(2, 0), { whatsapp: '+1 809-555-0002' }));
  const f = filasEscritas()[0];
  ok(String(f.whatsapp).charAt(0) === "'",
     'El WhatsApp con "+" se guarda como texto, no como fórmula', f.whatsapp);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 5 — Duplicados');
reiniciar();
{
  const d = payload(3, 0);

  const r1 = enviar(d);
  ok(r1.duplicado === false, 'Primer envío: se registra');

  // a) Mismo submissionId (doble clic / reintento de red)
  const r2 = enviar(d);
  ok(r2.duplicado === true && r2.fila === r1.fila, 'Mismo submissionId → misma respuesta, sin nueva fila');
  ok(r2.correos.estudiante === false, 'Un reenvío no vuelve a enviar correos');

  // b) Mismo correo, submissionId distinto, mismo grupo
  const r3 = enviar(Object.assign({}, d, { submissionId: 'otro-1' }));
  ok(r3.duplicado === true, 'Mismo correo en el mismo grupo → duplicado');

  // c) Mismo correo en OTRO grupo (deduplicación global)
  const otro = Object.assign({}, payload(3, 3), { submissionId: 'otro-2' });
  const r4 = enviar(otro);
  ok(r4.duplicado === true, 'Mismo correo en otro grupo → duplicado (alcance global)');

  ok(filasEscritas().length === 1, 'Tras 4 envíos solo existe 1 fila', filasEscritas().length);

  // d) La caché se vacía (simula expiración): la hoja sigue protegiendo
  cache.mapa.clear();
  const r5 = enviar(Object.assign({}, d, { submissionId: 'otro-3' }));
  ok(r5.duplicado === true, 'Sin caché, la hoja sigue detectando el duplicado');
  ok(filasEscritas().length === 1, 'Sigue habiendo una sola fila');
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 6 — Límite de cupos');
reiniciar();
{
  for (let i = 0; i < 15; i++) enviar(payload(100 + i, 0));
  const lleno = intentar(payload(200, 0));

  ok(!lleno.ok && lleno.code === 'CUPO_LLENO', 'El estudiante 16 recibe CUPO_LLENO', lleno.code);
  ok(filasEscritas().length === 15, 'El grupo tiene exactamente 15 filas', filasEscritas().length);

  const disp = sandbox.obtenerDisponibilidad_();
  ok(disp[0].lleno === true && disp[0].disponibles === 0, 'La disponibilidad refleja el grupo lleno', disp[0]);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 7 — Token temporal');
reiniciar();
{
  const t1 = sandbox.emitirToken_();
  ok(typeof t1 === 'string' && t1.indexOf('.') > 0, 'Se emite un token con firma');

  // a) Token válido
  const rOk = intentar(Object.assign(payload(4, 0), { token: t1 }), {});
  ok(rOk.ok && rOk.r.status === 'success', 'Un token válido permite la inscripción', rOk.code);

  // b) Reutilización del mismo token
  const rReuso = intentar(Object.assign(payload(5, 0), { token: t1 }), {});
  ok(!rReuso.ok && rReuso.code === 'TOKEN_INVALIDO', 'El token no puede reutilizarse', rReuso.code);

  // c) Sin token
  const rSin = intentar(Object.assign(payload(6, 0), { token: '' }), {});
  ok(!rSin.ok && rSin.code === 'TOKEN_INVALIDO', 'Sin token se rechaza la solicitud', rSin.code);

  // d) Token falsificado (firma alterada)
  const falso = sandbox.emitirToken_().split('.')[0] + '.firmaInventada';
  const rFalso = intentar(Object.assign(payload(7, 0), { token: falso }), {});
  ok(!rFalso.ok && rFalso.code === 'TOKEN_INVALIDO', 'Un token con firma inválida se rechaza', rFalso.code);

  // e) Token con carga manipulada (intento de alargar la caducidad)
  const cuerpoFalso = Buffer.from(JSON.stringify({ n: 'x', t: Date.now() + 99999999 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const rManip = intentar(Object.assign(payload(8, 0), { token: cuerpoFalso + '.' + 'aaa' }), {});
  ok(!rManip.ok && rManip.code === 'TOKEN_INVALIDO', 'Una carga manipulada se rechaza', rManip.code);

  // f) Token caducado
  const original = sandbox.CONFIG.seguridad.tokenTtlSegundos;
  sandbox.CONFIG.seguridad.tokenTtlSegundos = -1;   // todo token queda vencido
  const rVencido = intentar(Object.assign(payload(9, 0), { token: sandbox.emitirToken_() }), {});
  sandbox.CONFIG.seguridad.tokenTtlSegundos = original;
  ok(!rVencido.ok && rVencido.code === 'TOKEN_EXPIRADO', 'Un token caducado se rechaza', rVencido.code);

  ok(filasEscritas().length === 1, 'Solo la solicitud con token válido escribió en la hoja', filasEscritas().length);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 8 — Solicitudes excesivas (anti-spam)');
reiniciar();
{
  // Mismo correo una y otra vez, cambiando el submissionId para esquivar
  // la idempotencia: es el patrón de un script automatizado.
  let bloqueado = null, intentos = 0;
  for (let i = 0; i < 20 && !bloqueado; i++) {
    intentos++;
    const res = intentar(Object.assign(payload(10, 0), {
      correo: 'spam@ejemplo.com', submissionId: 'spam-' + i
    }), { omitirToken: true });
    if (!res.ok && res.code === 'DEMASIADAS_SOLICITUDES') bloqueado = i;
  }
  ok(bloqueado !== null, 'El envío repetido acaba bloqueado por rate limiting', { intentos });
  ok(bloqueado <= sandbox.CONFIG.seguridad.limitePorCorreo + 1,
     'Se bloquea dentro del límite configurado (' + sandbox.CONFIG.seguridad.limitePorCorreo + ')', bloqueado);

  // Un usuario legítimo distinto NO queda afectado
  const legitimo = intentar(payload(11, 1));
  ok(legitimo.ok, 'Un estudiante legítimo distinto sigue pudiendo inscribirse', legitimo.code);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 9 — Fallos de Google Sheets y errores inesperados');
reiniciar();
{
  const hoja = libro.getSheetByName('Inscripciones Básico');

  // a) Sheets lanza una excepción durante la lectura
  const originalGetRange = hoja.getRange;
  hoja.getRange = () => { throw new Error('Service Spreadsheets timed out at line 812'); };
  const rFallo = intentar(payload(12, 0));
  hoja.getRange = originalGetRange;

  ok(!rFallo.ok, 'Un fallo de Sheets no devuelve éxito');
  const respuesta = sandbox.construirRespuestaDeError_(rFallo.err);
  ok(respuesta.code === 'ERROR', 'Se traduce a código ERROR genérico', respuesta.code);
  ok(respuesta.message.indexOf('Spreadsheets') === -1 &&
     respuesta.message.indexOf('line 812') === -1,
     'El mensaje NO expone el detalle interno de Google', respuesta.message);
  ok(!lockState.held, 'El bloqueo se liberó pese a la excepción');

  // b) La solicitud siguiente funciona con normalidad
  const rDespues = intentar(payload(13, 0));
  ok(rDespues.ok, 'Tras el fallo, el backend sigue atendiendo solicitudes', rDespues.code);

  // c) La hoja no existe
  const guardada = libro.hojas.get('Inscripciones Básico');
  libro.hojas.delete('Inscripciones Básico');
  const rSinHoja = intentar(payload(14, 0));
  libro.hojas.set('Inscripciones Básico', guardada);
  const rSinHojaResp = sandbox.construirRespuestaDeError_(rSinHoja.err);
  ok(rSinHojaResp.message.indexOf('setup()') === -1,
     'Si falta la hoja, no se le sugiere "ejecuta setup()" al estudiante', rSinHojaResp.message);

  // d) El servicio de correo falla: la inscripción debe conservarse
  const antes = filasEscritas().length;
  sandbox.__fallarCorreo = true;
  const rCorreo = intentar(payload(15, 0));
  sandbox.__fallarCorreo = false;
  ok(rCorreo.ok && rCorreo.r.status === 'success', 'Un fallo de correo no invalida la inscripción');
  ok(rCorreo.r.correos.estudiante === false, 'Se informa de que el correo no salió');
  ok(filasEscritas().length === antes + 1, 'La fila se guardó igualmente');

  // e) Cuota de correo agotada
  sandbox.__cuotaCorreo = 0;
  cache.remove('cuota_correo');
  const rCuota = intentar(payload(16, 0));
  sandbox.__cuotaCorreo = undefined;
  cache.remove('cuota_correo');
  ok(rCuota.ok && rCuota.r.status === 'success', 'Sin cuota de correo, la inscripción se completa igual');
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 10 — Condición de carrera: demostración del riesgo');
reiniciar();
{
  const hoja = libro.getSheetByName('Inscripciones Básico');

  // Se reproduce el intercalado clásico SIN bloqueo:
  //   A lee → B lee → A escribe → B escribe
  const dA = sandbox.normalizarDatos_(payload(20, 0));
  const dB = sandbox.normalizarDatos_(payload(21, 0));

  const snapA = sandbox.leerSnapshot_(hoja, true);
  const snapB = sandbox.leerSnapshot_(hoja, true);
  const claveA = sandbox.claveGrupo_(dA.diaNormalizado, dA.grupoNombre);
  const filaA = sandbox.filaDeInsercion_(snapA.secciones[claveA]);
  const filaB = sandbox.filaDeInsercion_(snapB.secciones[claveA]);

  ok(filaA === filaB,
     'Sin bloqueo, dos lecturas simultáneas eligen LA MISMA fila → se perdería un registro',
     { filaA, filaB });

  // Con el flujo real (bloqueo + relectura) las filas son distintas.
  reiniciar();
  const r1 = enviar(payload(20, 0));
  const r2 = enviar(payload(21, 0));
  ok(r1.fila !== r2.fila, 'Con el flujo real, cada inscripción ocupa una fila distinta', { f1: r1.fila, f2: r2.fila });
}

// ══════════════════════════════════════════════════════════════════════════
seccion('FASE 5 — 100 solicitudes en avalancha');
reiniciar();
{
  stats.vigilarLock = true;
  stats.mutacionesSinLock = [];
  // Se pone a cero tras setup(): solo interesan las inserciones que
  // provoquen las inscripciones, no las del montaje de la hoja.
  stats.insercionesDeFilas = 0;
  const llamadasAntes = stats.llamadasSheets;
  const correosAntes = stats.correosEnviados;
  const inicio = Date.now();

  const resultados = [];
  for (let i = 0; i < 100; i++) {
    // Se reparten entre los 8 grupos, como haría un grupo real de alumnos.
    resultados.push(intentar(payload(1000 + i, i % 8)));
  }

  const duracion = Date.now() - inicio;
  stats.vigilarLock = false;

  const exitos    = resultados.filter(r => r.ok && r.r.status === 'success' && !r.r.duplicado);
  const duplicados = resultados.filter(r => r.ok && r.r.duplicado);
  const errores   = resultados.filter(r => !r.ok);

  console.log('\n   Éxitos: ' + exitos.length + ' · duplicados: ' + duplicados.length +
              ' · errores: ' + errores.length);
  if (errores.length) {
    const porCodigo = {};
    errores.forEach(e => { porCodigo[e.code || 'SIN_CODIGO'] = (porCodigo[e.code || 'SIN_CODIGO'] || 0) + 1; });
    console.log('   Errores por código: ' + JSON.stringify(porCodigo));
  }

  const filas = filasEscritas();

  // ── Invariantes ──
  ok(exitos.length === 100, 'Las 100 solicitudes legítimas se registran', exitos.length);
  ok(filas.length === 100, 'La hoja contiene exactamente 100 filas: no se perdió ningún registro', filas.length);

  const filasUnicas = new Set(filas.map(f => f.grupo + '#' + f.fila));
  ok(filasUnicas.size === filas.length, 'Ninguna fila fue sobrescrita por otra solicitud');

  const correos = filas.map(f => f.correo);
  ok(new Set(correos).size === correos.length, 'No hay correos repetidos: cero duplicados accidentales');

  const filasDevueltas = exitos.map(r => r.r.fila);
  ok(new Set(filasDevueltas).size === filasDevueltas.length,
     'Cada solicitud recibió un número de fila distinto');

  const porGrupo = {};
  filas.forEach(f => { porGrupo[f.grupo] = (porGrupo[f.grupo] || 0) + 1; });
  const excedidos = Object.keys(porGrupo).filter(k => porGrupo[k] > 15);
  ok(excedidos.length === 0, 'Ningún grupo superó el límite de 15 cupos', porGrupo);

  ok(stats.mutacionesSinLock.length === 0,
     'TODAS las escrituras en la hoja ocurrieron con el bloqueo adquirido',
     stats.mutacionesSinLock.slice(0, 5));

  ok(!lockState.held, 'El bloqueo quedó liberado al terminar');

  // ── Integridad de los datos escritos ──
  const corruptas = filas.filter(f => !f.nombre || !f.correo ||
    String(f.correo).indexOf('@') === -1 || String(f.nombre).indexOf('Estudiante ') !== 0);
  ok(corruptas.length === 0, 'Ninguna fila quedó con datos corruptos o mezclados', corruptas.slice(0, 3));

  // ── Coste por solicitud ──
  const llamadas = stats.llamadasSheets - llamadasAntes;
  const insercionesFilas = stats.insercionesDeFilas;
  console.log('\n   ── Coste medido ──');
  console.log('   Llamadas a SpreadsheetApp: ' + llamadas + ' en total → ' +
              (llamadas / 100).toFixed(1) + ' por inscripción');
  console.log('   Inserciones de filas (la operación más cara): ' + insercionesFilas);
  const correosGastados = stats.correosEnviados - correosAntes;
  console.log('   Correos generados: ' + correosGastados + ' → ' +
              (correosGastados / 100).toFixed(1) + ' por inscripción ' +
              '(cuota Gmail personal: 100/día)');
  console.log('   Tiempo del simulador: ' + duracion + ' ms (sin latencia de red)');

  ok(correosGastados === 100,
     '100 inscripciones caben en la cuota diaria de una cuenta Gmail personal',
     correosGastados);

  ok(insercionesFilas === 0,
     'No hizo falta insertar filas: los bloques preasignados absorbieron las 100 inscripciones',
     insercionesFilas);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 11 — Caché de disponibilidad');
reiniciar();
{
  const antes1 = stats.llamadasSheets;
  sandbox.obtenerDisponibilidad_();
  const primera = stats.llamadasSheets - antes1;

  const antes2 = stats.llamadasSheets;
  for (let i = 0; i < 50; i++) sandbox.obtenerDisponibilidad_();
  const siguientes = stats.llamadasSheets - antes2;

  ok(siguientes === 0, '50 consultas más de disponibilidad no tocan la hoja (se sirven de caché)', siguientes);
  console.log('   ℹ️  Primera consulta: ' + primera + ' llamadas · 50 siguientes: ' + siguientes);

  // Tras registrar a alguien, la caché debe reflejar el cambio
  enviar(payload(30, 0));
  const disp = sandbox.obtenerDisponibilidad_();
  ok(disp[0].inscritos === 1, 'La caché se invalida al registrar una inscripción', disp[0].inscritos);
}

// ══════════════════════════════════════════════════════════════════════════
seccion('PRUEBA 12 — El almacén de propiedades ya no crece sin control');
reiniciar();
{
  const antes = Object.keys(propiedades.getProperties()).length;
  for (let i = 0; i < 50; i++) enviar(payload(400 + i, i % 8));
  const despues = Object.keys(propiedades.getProperties()).length;

  ok(despues === antes, '50 inscripciones NO añaden propiedades permanentes', { antes, despues });
  console.log('   ℹ️  Propiedades almacenadas: ' + despues + ' (solo el secreto de firma)');
}

// ══════════════════════════════════════════════════════════════════════════
seccion('RESUMEN');
console.log('   Comprobaciones superadas: ' + pasadas);
console.log('   Comprobaciones fallidas:  ' + fallidas);
if (fallidas) { console.log('\n   Fallos:'); fallos.forEach(f => console.log('     · ' + f)); }
console.log('');
process.exit(fallidas ? 1 : 0);
