/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  Lingola English Teaching — Programa Inglés Básico                      ║
 * ║  Backend Independiente de Google Apps Script                             ║
 * ║                                                                         ║
 * ║  Versión:  3.0                                                          ║
 * ║  Fecha:    Julio 2026                                                   ║
 * ║                                                                         ║
 * ║  NOVEDADES v3.0:                                                        ║
 * ║  • Límite de 15 cupos por combinación de días + horario (8 grupos).     ║
 * ║  • Consulta de disponibilidad en tiempo real (doGet ?action=...).       ║
 * ║  • Correo de confirmación al estudiante y aviso al administrador.       ║
 * ║  • Protección contra inscripciones y correos duplicados.                ║
 * ║                                                                         ║
 * ║  INSTRUCCIONES:                                                         ║
 * ║  1. Crea un nuevo proyecto en Google Apps Script.                        ║
 * ║  2. Pega este código completo.                                          ║
 * ║  3. Ejecuta la función setup() para crear la estructura en Sheets.      ║
 * ║  4. Publica como Web App (Implementar > Nueva Implementación):          ║
 * ║       - Ejecutar como:  Yo (tu cuenta)                                  ║
 * ║       - Quién tiene acceso:  Cualquier usuario                          ║
 * ║  5. Copia la URL (/exec) y colócala en lingola-config.js →              ║
 * ║     LINGOLA_CONFIG.backend.gasWebAppUrl                                 ║
 * ║  6. Autoriza los permisos de Gmail la primera vez (envío de correos).   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 0: CORREO DEL ADMINISTRADOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dirección que recibe la notificación de cada nueva inscripción.
 * Cambia únicamente este valor para redirigir los avisos administrativos.
 * @type {string}
 */
var ADMIN_EMAIL = 'lingolaenglishteaching@gmail.com';

/**
 * Prefijo interno que identifica el error de "cupo lleno".
 * Permite que el frontend distinga este caso de un error genérico.
 * @type {string}
 */
var ERROR_CUPO_LLENO = '[CUPO_LLENO]';


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 1: CONFIGURACIÓN CENTRALIZADA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Objeto de configuración global.
 * Todos los valores que controlan el comportamiento del script se definen aquí.
 * Para modificar colores, nombres de hoja, columnas o buffer, edita únicamente este objeto.
 */
var CONFIG = {

  // ── Nombre de la hoja dentro de Google Sheets ──
  hojaNombre: 'Inscripciones Básico',

  // ── Nivel fijo del programa ──
  nivelFijo: 'Inglés Básico',

  // ── Encabezados de columna para la tabla de estudiantes ──
  columnas: [
    'Fecha de inscripción',
    'Nivel',
    'Nombre completo',
    'WhatsApp',
    'Correo electrónico',
    'Días seleccionados',
    'Horario seleccionado'
  ],

  // ── Grupos de días disponibles ──
  // El valor debe coincidir (en mayúsculas) con los encabezados de la hoja
  dias: ['LUNES Y JUEVES', 'MARTES Y VIERNES'],

  // ── Horarios disponibles ──
  // Cada objeto contiene el nombre del grupo y el rango de hora.
  // La hoja mostrará ambos en filas separadas dentro del encabezado dorado.
  horarios: [
    { nombreGrupo: 'Primer grupo de la mañana',  rango: '9:00 AM – 10:30 AM'  },
    { nombreGrupo: 'Segundo grupo de la mañana', rango: '11:00 AM – 12:30 PM' },
    { nombreGrupo: 'Primer grupo de la tarde',   rango: '2:00 PM – 3:30 PM'   },
    { nombreGrupo: 'Segundo grupo de la tarde',  rango: '4:00 PM – 5:30 PM'   }
  ],

  // ── Mapeo de valores del formulario → nombre del grupo en la hoja ──
  // El formulario HTML puede enviar variaciones; este mapeo las normaliza.
  mapeoHorarios: {
    'Primer grupo de la mañana 9:00 AM – 10:30 AM':   'Primer grupo de la mañana',
    'Segundo grupo de la mañana 11:00 AM – 12:30 PM': 'Segundo grupo de la mañana',
    'Primer grupo de la tarde 2:00 PM – 3:30 PM':     'Primer grupo de la tarde',
    'Segundo grupo de la tarde 4:00 PM – 5:30 PM':    'Segundo grupo de la tarde',
    'Primer grupo de la mañana':                       'Primer grupo de la mañana',
    'Segundo grupo de la mañana':                      'Segundo grupo de la mañana',
    'Primer grupo de la tarde':                        'Primer grupo de la tarde',
    'Segundo grupo de la tarde':                       'Segundo grupo de la tarde'
  },

  // ── Buffer de separación ──
  // Número mínimo de filas vacías entre el último estudiante y el siguiente encabezado.
  // Esto evita que las filas nuevas hereden formato de los encabezados.
  filasSeparacion: 5,

  // ── Colores corporativos Lingola ──
  colores: {
    fondoDias:     '#132A4A',   // Azul marino para encabezado de días
    textoDias:     '#FFFFFF',   // Texto blanco sobre azul
    fondoHorario:  '#EAB308',   // Dorado para encabezado de horario
    textoHorario:  '#1E293B',   // Texto oscuro sobre dorado
    fondoCabecera: '#F1F5F9',   // Gris claro para cabecera de columnas
    textoCabecera: '#1E293B',   // Texto oscuro para cabecera
    fondoEstudiante: '#FFFFFF', // Blanco para filas de estudiantes
    textoEstudiante: '#000000'  // Texto negro para estudiantes
  },

  // ── Anchos de columna (en píxeles) ──
  anchosColumnas: [160, 110, 260, 160, 260, 160, 260],

  // ── Límite de cupos por combinación de días + horario ──
  // Existen 8 combinaciones (2 grupos de días × 4 horarios).
  // Cada una admite como máximo este número de estudiantes.
  limiteCupos: 15,

  // ── Datos de marca usados en los correos ──
  marca: {
    nombre:        'Lingola English Teaching',
    programa:      'Programa de Inglés Básico',
    whatsapp:      '18495358676',
    // Se usa solo si el formulario no envía la fecha de inicio.
    inicioClasesPorDefecto: 'Lunes 3 de agosto'
  },

  // ── Condiciones de pago (deben coincidir con el contrato) ──
  pago: {
    diaInicioMensualidad: 7,
    diaFinMensualidad:    15,
    metodo:               'transferencia bancaria'
  },

  // ── Prefijo de las claves de idempotencia en ScriptProperties ──
  prefijoEnvio: 'SUB_'
};


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 2: PUNTOS DE ENTRADA (doGet / doPost)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Responde a solicitudes GET.
 *
 * Acciones disponibles (parámetro "action"):
 *   • (ninguna)        → Verificación de que el backend está activo.
 *   • disponibilidad   → Devuelve los cupos libres de los 8 grupos.
 *   • inscribir        → Registra una inscripción (respaldo cuando el
 *                        navegador bloquea la lectura de la respuesta POST).
 *
 * Si se envía el parámetro "callback", la respuesta se devuelve en formato
 * JSONP. Esto permite que una página estática lea el resultado sin depender
 * de la configuración CORS del navegador.
 *
 * @param {Object} e - Evento de solicitud GET.
 * @returns {TextOutput} Respuesta JSON o JSONP.
 */
function doGet(e) {
  var params        = (e && e.parameter) ? e.parameter : {};
  var accion        = params.action || '';
  var callbackCrudo = params.callback || '';

  // Un callback con caracteres no permitidos se descarta por completo:
  // la respuesta se devuelve como JSON puro, nunca como código ejecutable.
  if (callbackCrudo && !esCallbackValido_(callbackCrudo)) {
    return responder_({
      status:  'error',
      code:    'CALLBACK_INVALIDO',
      message: 'El nombre de callback recibido no es válido.'
    }, '');
  }

  var callback = callbackCrudo;

  try {
    if (accion === 'disponibilidad') {
      return responder_({
        status: 'success',
        limite: CONFIG.limiteCupos,
        grupos: obtenerDisponibilidad_()
      }, callback);
    }

    if (accion === 'inscribir') {
      var datosGet = params.data ? JSON.parse(params.data) : params;
      return responder_(procesarInscripcion_(datosGet), callback);
    }

    return responder_({
      status: 'success',
      message: 'Backend Lingola — Inglés Básico v3.0 — Activo.'
    }, callback);

  } catch (err) {
    registrarError_('doGet', err);
    return responder_(construirRespuestaDeError_(err), callback);
  }
}

/**
 * Responde a solicitudes POST.
 * Recibe los datos del formulario HTML, los registra en Google Sheets y
 * envía los correos de confirmación.
 *
 * Acepta datos en tres formatos:
 *   1. JSON directo en el body (application/json o text/plain)
 *   2. Form-encoded con campo "data" que contiene JSON
 *   3. Parámetros sueltos (fallback)
 *
 * @param {Object} e - Evento de solicitud POST.
 * @returns {TextOutput} Respuesta JSON con status y mensaje.
 */
function doPost(e) {
  try {
    var data = extraerDatosDelRequest_(e);
    return responder_(procesarInscripcion_(data), '');

  } catch (err) {
    registrarError_('doPost', err);
    return responder_(construirRespuestaDeError_(err), '');
  }
}

/**
 * Comprueba que un nombre de callback JSONP sea seguro.
 * Solo se aceptan identificadores de JavaScript.
 *
 * @param {string} callback - Nombre recibido en la URL.
 * @returns {boolean} true si el nombre puede usarse.
 */
function esCallbackValido_(callback) {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback);
}

/**
 * Construye la respuesta HTTP en formato JSON o JSONP.
 * Nunca lanza errores: si el callback no es seguro, responde JSON puro.
 *
 * @param {Object} objeto - Contenido de la respuesta.
 * @param {string} callback - Nombre de la función JSONP (vacío = JSON puro).
 * @returns {TextOutput} Respuesta lista para enviar.
 */
function responder_(objeto, callback) {
  var json = JSON.stringify(objeto);

  if (callback && esCallbackValido_(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Traduce un error interno en una respuesta comprensible para el frontend.
 *
 * @param {Error} err - Error capturado.
 * @returns {Object} Respuesta con status, code y message.
 */
function construirRespuestaDeError_(err) {
  var mensaje = err && err.message ? err.message : 'Error desconocido.';
  var codigo  = (mensaje.indexOf(ERROR_CUPO_LLENO) === 0) ? 'CUPO_LLENO' : 'ERROR';

  if (codigo === 'CUPO_LLENO') {
    mensaje = mensaje.replace(ERROR_CUPO_LLENO, '').trim();
  }

  return { status: 'error', code: codigo, message: mensaje };
}

/**
 * Deja constancia del error en el registro de ejecuciones de Apps Script.
 * (Ver > Registros de ejecución en el editor).
 *
 * @param {string} origen - Función donde ocurrió el error.
 * @param {Error} err - Error capturado.
 */
function registrarError_(origen, err) {
  console.error('[Lingola][' + origen + '] ' + (err && err.stack ? err.stack : err));
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 3: FUNCIONES AUXILIARES REUTILIZABLES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extrae los datos enviados desde el formulario, independientemente del formato.
 *
 * @param {Object} e - Evento de solicitud POST.
 * @returns {Object} Datos parseados del formulario.
 * @throws {Error} Si no se pueden extraer datos válidos.
 */
function extraerDatosDelRequest_(e) {
  // Formato 1: JSON directo en el body.
  // fetch() sin cabeceras personalizadas envía "text/plain", lo que evita
  // la petición preflight de CORS; por eso ambos tipos son válidos.
  if (e.postData && e.postData.contents) {
    var tipo = e.postData.type || '';
    if (tipo.indexOf('application/json') === 0 || tipo.indexOf('text/plain') === 0) {
      return JSON.parse(e.postData.contents);
    }
  }

  // Formato 2: Form-encoded con campo "data"
  if (e.parameter && e.parameter.data) {
    return JSON.parse(e.parameter.data);
  }

  // Formato 3: Parámetros directos (fallback)
  if (e.parameter && e.parameter.nombre) {
    return e.parameter;
  }

  throw new Error('No se recibieron datos válidos en la solicitud.');
}

/**
 * Normaliza y valida los datos del formulario antes de insertarlos.
 *
 * - Limpia espacios en blanco
 * - Mapea el horario al nombre del grupo
 * - Valida campos obligatorios
 *
 * @param {Object} data - Datos crudos del formulario.
 * @returns {Object} Datos normalizados con campos: nombre, whatsapp, correo, diaOriginal, diaNormalizado, grupoNombre, horarioOriginal
 * @throws {Error} Si faltan campos obligatorios o el mapeo es inválido.
 */
function normalizarDatos_(data) {
  var nombre   = (data.nombre   || '').trim();
  var whatsapp = (data.whatsapp || '').trim();
  var correo   = (data.correo || data.email || '').trim();
  var dias     = (data.dias     || '').trim();
  var horario  = (data.horario  || '').trim();
  var grupo    = (data.grupo    || '').trim();

  // ── Validar campos obligatorios ──
  if (!nombre) {
    throw new Error('El campo "nombre" es obligatorio.');
  }
  if (!dias) {
    throw new Error('El campo "días" es obligatorio.');
  }
  if (!horario && !grupo) {
    throw new Error('El campo "horario" o "grupo" es obligatorio.');
  }

  // ── Normalizar día ──
  var diaNormalizado = dias.toUpperCase();
  // Verificar que el día existe en la configuración
  var diaValido = false;
  for (var i = 0; i < CONFIG.dias.length; i++) {
    if (CONFIG.dias[i] === diaNormalizado) {
      diaValido = true;
      break;
    }
  }
  if (!diaValido) {
    throw new Error('El grupo de días "' + dias + '" no es válido. Opciones: ' + CONFIG.dias.join(', '));
  }

  // ── Normalizar horario / grupo ──
  // Prioridad: usar el campo "grupo" si viene; si no, buscar en el mapeo del horario
  var grupoNombre = '';

  if (grupo && CONFIG.mapeoHorarios[grupo]) {
    grupoNombre = CONFIG.mapeoHorarios[grupo];
  } else if (horario && CONFIG.mapeoHorarios[horario]) {
    grupoNombre = CONFIG.mapeoHorarios[horario];
  } else {
    // Intentar búsqueda parcial: si el horario contiene el nombre de un grupo conocido
    for (var clave in CONFIG.mapeoHorarios) {
      if (horario.indexOf(CONFIG.mapeoHorarios[clave]) !== -1 || CONFIG.mapeoHorarios[clave].indexOf(horario) !== -1) {
        grupoNombre = CONFIG.mapeoHorarios[clave];
        break;
      }
    }
  }

  if (!grupoNombre) {
    throw new Error('No se pudo identificar el grupo horario. Valor recibido: horario="' + horario + '", grupo="' + grupo + '"');
  }

  return {
    nombre:          nombre,
    whatsapp:        whatsapp,
    correo:          correo,
    diaOriginal:     dias,
    diaNormalizado:  diaNormalizado,
    grupoNombre:     grupoNombre,
    horarioOriginal: horario,
    nivel:           (data.nivel || '').trim() || CONFIG.nivelFijo,
    inicioClases:    (data.inicioClases || '').trim() || CONFIG.marca.inicioClasesPorDefecto,
    aceptoTerminos:  data.aceptoTerminos === true || data.aceptoTerminos === 'true',
    submissionId:    (data.submissionId || '').toString().trim()
  };
}

/**
 * Determina si un valor de celda corresponde a un encabezado de día o de horario.
 *
 * @param {string} valor - Contenido de la celda (ya con trim).
 * @returns {Object} { esDia: boolean, esHorario: boolean }
 */
function esFilaEncabezado_(valor) {
  var valorUpper = valor.toUpperCase();

  // Verificar si es un encabezado de día
  for (var i = 0; i < CONFIG.dias.length; i++) {
    if (CONFIG.dias[i] === valorUpper) {
      return { esDia: true, esHorario: false };
    }
  }

  // Verificar si es un encabezado de horario (nombre del grupo)
  for (var j = 0; j < CONFIG.horarios.length; j++) {
    if (valor === CONFIG.horarios[j].nombreGrupo) {
      return { esDia: false, esHorario: true };
    }
  }

  return { esDia: false, esHorario: false };
}

/**
 * Busca y localiza la sección exacta dentro de la hoja donde insertar un estudiante.
 *
 * Escanea la columna A para encontrar:
 *   1. El encabezado del día (ej. "LUNES Y JUEVES")
 *   2. El nombre del grupo de horario dentro de ese día (ej. "Primer grupo de la mañana")
 *   3. La fila de cabecera de columnas (Fecha, Nivel, Nombre...)
 *   4. El rango de datos de estudiantes
 *   5. El siguiente encabezado (para calcular el buffer)
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @param {string} diaNormalizado - Día en mayúsculas (ej. "LUNES Y JUEVES").
 * @param {string} grupoNombre - Nombre del grupo (ej. "Primer grupo de la mañana").
 * @returns {Object} { filaCabeceraColumnas, filaInicioEstudiantes, filaProximoEncabezado }
 * @throws {Error} Si no se encuentra la sección.
 */
function encontrarSeccion_(sheet, diaNormalizado, grupoNombre) {
  var ultimaFila = sheet.getMaxRows();
  var valores = sheet.getRange(1, 1, ultimaFila, 1).getValues();

  var estado = 'buscando_dia';
  var filaCabeceraColumnas = -1;
  var filaInicioEstudiantes = -1;
  var filaProximoEncabezado = -1;

  for (var i = 0; i < valores.length; i++) {
    var valorCelda = String(valores[i][0]).trim();
    if (!valorCelda && estado !== 'contando_estudiantes') continue;

    switch (estado) {

      // ── Estado 1: Buscando el encabezado del día ──
      case 'buscando_dia':
        if (valorCelda.toUpperCase() === diaNormalizado) {
          estado = 'buscando_grupo';
        }
        break;

      // ── Estado 2: Dentro del día, buscando el grupo de horario ──
      case 'buscando_grupo':
        // Si encontramos otro encabezado de día, el grupo no existía
        if (esFilaEncabezado_(valorCelda).esDia) {
          throw new Error('No se encontró el grupo "' + grupoNombre + '" dentro de "' + diaNormalizado + '".');
        }
        if (valorCelda === grupoNombre) {
          estado = 'buscando_cabecera';
        }
        break;

      // ── Estado 3: Grupo encontrado, buscando la fila de cabecera de columnas ──
      case 'buscando_cabecera':
        if (valorCelda === CONFIG.columnas[0]) {
          filaCabeceraColumnas = i + 1; // +1 porque el array es 0-indexed
          filaInicioEstudiantes = i + 2;
          estado = 'contando_estudiantes';
        }
        break;

      // ── Estado 4: Contando filas de estudiantes hasta encontrar el siguiente encabezado ──
      case 'contando_estudiantes':
        if (valorCelda) {
          var tipo = esFilaEncabezado_(valorCelda);
          if (tipo.esDia || tipo.esHorario) {
            filaProximoEncabezado = i + 1; // +1 por 0-index
            // Hemos terminado la búsqueda
            i = valores.length; // Salir del bucle
            break;
          }
        }
        break;
    }
  }

  // ── Validaciones de resultado ──
  if (filaCabeceraColumnas === -1) {
    throw new Error('No se encontró la sección para: ' + diaNormalizado + ' / ' + grupoNombre + '. ¿Ejecutaste setup()?');
  }

  // Si no se encontró un próximo encabezado, usar la última fila + 1
  if (filaProximoEncabezado === -1) {
    filaProximoEncabezado = ultimaFila + 1;
  }

  return {
    filaCabeceraColumnas:   filaCabeceraColumnas,
    filaInicioEstudiantes:  filaInicioEstudiantes,
    filaProximoEncabezado:  filaProximoEncabezado
  };
}

/**
 * Encuentra la fila exacta donde insertar el nuevo estudiante.
 * Busca la primera fila vacía después del último estudiante registrado en el bloque.
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @param {number} filaInicio - Primera fila donde pueden existir datos de estudiantes.
 * @param {number} filaProximoEncabezado - Fila del siguiente encabezado o fin de la hoja.
 * @returns {number} Número de fila (1-indexed) donde se insertará el nuevo registro.
 */
function encontrarFilaInsercion_(sheet, filaInicio, filaProximoEncabezado) {
  var rangoFilas = filaProximoEncabezado - filaInicio;
  if (rangoFilas <= 0) return filaInicio;

  var valores = sheet.getRange(filaInicio, 1, rangoFilas, 1).getValues();

  // Buscar la primera fila vacía empezando desde el inicio del bloque
  for (var i = 0; i < valores.length; i++) {
    if (String(valores[i][0]).trim() === '') {
      return filaInicio + i;
    }
  }

  // Si todas las filas tienen datos, insertar al final del bloque
  return filaInicio + valores.length;
}

/**
 * Garantiza que existan suficientes filas de buffer entre la fila de inserción
 * y el siguiente encabezado. Si no hay espacio suficiente, inserta filas nuevas
 * y limpia su formato para evitar contaminación.
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @param {number} filaInsercion - Fila donde se insertará el estudiante.
 * @param {number} filaProximoEncabezado - Fila del siguiente encabezado.
 * @returns {number} Nuevo valor de filaProximoEncabezado (puede cambiar si se insertaron filas).
 */
function garantizarEspacioBuffer_(sheet, filaInsercion, filaProximoEncabezado) {
  // Calcular cuántas filas vacías quedan entre la inserción y el siguiente encabezado
  // Necesitamos: la fila de inserción + (buffer mínimo) < filaProximoEncabezado
  var espacioNecesario = CONFIG.filasSeparacion + 1; // +1 por la fila del propio estudiante
  var espacioDisponible = filaProximoEncabezado - filaInsercion;

  if (espacioDisponible < espacioNecesario && filaProximoEncabezado <= sheet.getMaxRows()) {
    // Calcular cuántas filas faltan
    var filasAInsertar = espacioNecesario - espacioDisponible;

    // Insertar filas ANTES del siguiente encabezado
    sheet.insertRowsBefore(filaProximoEncabezado, filasAInsertar);

    // ── LIMPIEZA CRÍTICA DE FORMATO ──
    // Las filas insertadas antes de un encabezado heredan su formato.
    // Debemos limpiar esas filas para que no se vean como encabezados.
    var rangoNuevasFilas = sheet.getRange(
      filaProximoEncabezado, 1, filasAInsertar, sheet.getMaxColumns()
    );

    // Paso 1: Eliminar todo el formato heredado
    rangoNuevasFilas.clearFormat();
    rangoNuevasFilas.clearContent();

    // Paso 2: Aplicar formato neutro explícito
    rangoNuevasFilas
      .setBackground('#FFFFFF')
      .setFontColor('#000000')
      .setFontWeight('normal')
      .setFontSize(10)
      .setFontFamily('Arial')
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle');

    // Paso 3: Romper cualquier merge heredado
    rangoNuevasFilas.breakApart();

    // Actualizar la referencia del siguiente encabezado
    return filaProximoEncabezado + filasAInsertar;
  }

  return filaProximoEncabezado;
}

/**
 * Aplica el formato correcto a la fila del estudiante recién insertado.
 *
 * Estrategia:
 *   - Si hay otros estudiantes en el bloque, copia el formato de la fila anterior.
 *   - Si es el primer estudiante, aplica un formato base limpio y neutro.
 *
 * Esto NUNCA copia formato de encabezados.
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @param {number} filaInsercion - Fila donde se insertó el estudiante.
 * @param {number} filaInicioEstudiantes - Primera fila del bloque de estudiantes.
 * @param {number} numColumnas - Número de columnas de datos.
 */
function aplicarFormatoEstudiante_(sheet, filaInsercion, filaInicioEstudiantes, numColumnas) {
  var rangoDestino = sheet.getRange(filaInsercion, 1, 1, numColumnas);

  if (filaInsercion > filaInicioEstudiantes) {
    // ── Hay estudiantes anteriores: copiar formato de la fila inmediatamente anterior ──
    var rangoOrigen = sheet.getRange(filaInsercion - 1, 1, 1, numColumnas);
    rangoOrigen.copyTo(rangoDestino, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  } else {
    // ── Primer estudiante del bloque: formato base limpio ──
    rangoDestino
      .clearFormat()
      .setFontFamily('Arial')
      .setFontSize(10)
      .setFontWeight('normal')
      .setBackground(CONFIG.colores.fondoEstudiante)
      .setFontColor(CONFIG.colores.textoEstudiante)
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 3B: CONTROL DE CUPOS (15 POR COMBINACIÓN DE DÍAS + HORARIO)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Construye la clave única de un grupo (días + horario).
 *
 * @param {string} diaNormalizado - Día en mayúsculas (ej. "LUNES Y JUEVES").
 * @param {string} grupoNombre - Nombre del grupo (ej. "Primer grupo de la mañana").
 * @returns {string} Clave del grupo.
 */
function claveGrupo_(diaNormalizado, grupoNombre) {
  return diaNormalizado + '||' + grupoNombre;
}

/**
 * Recorre UNA sola vez la columna A y cuenta los estudiantes inscritos
 * en cada combinación de días + horario.
 *
 * Una fila cuenta como estudiante cuando:
 *   • Está después de la cabecera de columnas de un bloque.
 *   • Tiene contenido en la columna A (la fecha de inscripción).
 *   • No es un encabezado de día ni de horario.
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @returns {Object} Mapa { "DÍA||Grupo": cantidadDeInscritos }.
 */
function contarInscritosPorGrupo_(sheet) {
  var valores = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
  var conteos = {};

  var diaActual   = '';
  var grupoActual = '';
  var contando    = false;

  for (var i = 0; i < valores.length; i++) {
    var celda = String(valores[i][0]).trim();
    if (!celda) continue;

    var tipo = esFilaEncabezado_(celda);

    if (tipo.esDia) {
      diaActual   = celda.toUpperCase();
      grupoActual = '';
      contando    = false;
      continue;
    }

    if (tipo.esHorario) {
      grupoActual = celda;
      contando    = false;
      continue;
    }

    // Cabecera de columnas: a partir de aquí empiezan los estudiantes.
    if (celda === CONFIG.columnas[0]) {
      contando = Boolean(diaActual && grupoActual);
      if (contando) {
        var claveNueva = claveGrupo_(diaActual, grupoActual);
        if (conteos[claveNueva] === undefined) conteos[claveNueva] = 0;
      }
      continue;
    }

    if (contando) {
      conteos[claveGrupo_(diaActual, grupoActual)]++;
    }
  }

  return conteos;
}

/**
 * Devuelve el estado de cupos de los 8 grupos (2 días × 4 horarios).
 *
 * @returns {Array<Object>} Lista con dias, grupo, rango, inscritos,
 *                          disponibles, limite y lleno.
 */
function obtenerDisponibilidad_() {
  var sheet = obtenerHoja_();
  var conteos = contarInscritosPorGrupo_(sheet);
  var resultado = [];

  for (var d = 0; d < CONFIG.dias.length; d++) {
    for (var h = 0; h < CONFIG.horarios.length; h++) {
      var dia     = CONFIG.dias[d];
      var horario = CONFIG.horarios[h];
      var inscritos = conteos[claveGrupo_(dia, horario.nombreGrupo)] || 0;
      var disponibles = Math.max(0, CONFIG.limiteCupos - inscritos);

      resultado.push({
        dias:        dia,
        grupo:       horario.nombreGrupo,
        rango:       horario.rango,
        inscritos:   inscritos,
        disponibles: disponibles,
        limite:      CONFIG.limiteCupos,
        lleno:       disponibles <= 0
      });
    }
  }

  return resultado;
}

/**
 * Cuenta los estudiantes de UNA sección concreta y recoge sus correos.
 * Se usa dentro del bloqueo de concurrencia, justo antes de insertar.
 *
 * @param {Sheet} sheet - La hoja.
 * @param {Object} seccion - Resultado de encontrarSeccion_.
 * @returns {Object} { inscritos: number, correos: Array<string> }
 */
function inspeccionarSeccion_(sheet, seccion) {
  var totalFilas = seccion.filaProximoEncabezado - seccion.filaInicioEstudiantes;
  if (totalFilas <= 0) {
    return { inscritos: 0, correos: [] };
  }

  var datos = sheet.getRange(
    seccion.filaInicioEstudiantes, 1, totalFilas, CONFIG.columnas.length
  ).getValues();

  var inscritos = 0;
  var correos = [];

  for (var i = 0; i < datos.length; i++) {
    var primeraColumna = String(datos[i][0]).trim();
    if (!primeraColumna) continue;
    if (esFilaEncabezado_(primeraColumna).esDia) break;
    if (esFilaEncabezado_(primeraColumna).esHorario) break;

    inscritos++;
    correos.push(String(datos[i][4] || '').trim().toLowerCase());
  }

  return { inscritos: inscritos, correos: correos };
}

/**
 * Obtiene la hoja de inscripciones o lanza un error descriptivo.
 *
 * @returns {Sheet} La hoja de trabajo.
 */
function obtenerHoja_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.hojaNombre);

  if (!sheet) {
    throw new Error('La hoja "' + CONFIG.hojaNombre + '" no existe. Ejecuta la función setup() primero.');
  }

  return sheet;
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 4: FUNCIÓN PRINCIPAL DE REGISTRO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registra un nuevo estudiante en la sección correcta de Google Sheets.
 *
 * Flujo completo:
 *   1. Obtiene la hoja
 *   2. Localiza la sección (día + horario)
 *   3. Encuentra la fila de inserción
 *   4. Garantiza el buffer de separación
 *   5. Escribe los datos
 *   6. Aplica formato limpio
 *
 * Usa LockService para evitar conflictos de concurrencia.
 *
 * @param {Object} datos - Datos normalizados del estudiante (output de normalizarDatos_).
 * @returns {Object} { fila: number } — Número de fila donde se insertó el registro.
 * @throws {Error} Si la hoja no existe, la sección no se encuentra, o hay error de concurrencia.
 */
function registrarEstudiante_(datos) {
  var sheet = obtenerHoja_();
  var propiedades = PropertiesService.getScriptProperties();
  var claveEnvio = datos.submissionId ? (CONFIG.prefijoEnvio + datos.submissionId) : '';

  // ── Bloqueo de concurrencia ──
  // Garantiza que dos estudiantes no puedan ocupar a la vez el último cupo.
  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000); // Esperar hasta 30 segundos

    // Paso 0: ¿Este mismo envío ya fue procesado? (doble clic, reintento, red)
    if (claveEnvio) {
      var envioPrevio = propiedades.getProperty(claveEnvio);
      if (envioPrevio) {
        var previo = JSON.parse(envioPrevio);
        previo.duplicado = true;
        return previo;
      }
    }

    // Paso 1: Localizar la sección correcta
    var seccion = encontrarSeccion_(sheet, datos.diaNormalizado, datos.grupoNombre);

    // Paso 2: Verificar cupos y correos ya registrados en esa sección
    var estado = inspeccionarSeccion_(sheet, seccion);

    // El mismo correo ya está inscrito en este grupo: no duplicamos la fila.
    if (datos.correo && estado.correos.indexOf(datos.correo.toLowerCase()) !== -1) {
      return {
        fila:        0,
        inscritos:   estado.inscritos,
        disponibles: Math.max(0, CONFIG.limiteCupos - estado.inscritos),
        limite:      CONFIG.limiteCupos,
        duplicado:   true
      };
    }

    // Validación definitiva del límite de cupos.
    if (estado.inscritos >= CONFIG.limiteCupos) {
      throw new Error(
        ERROR_CUPO_LLENO + ' El grupo de ' + datos.diaOriginal + ' (' + datos.horarioOriginal +
        ') ya alcanzó el máximo de ' + CONFIG.limiteCupos +
        ' estudiantes. Por favor, selecciona otro horario disponible.'
      );
    }

    // Paso 3: Encontrar la fila exacta de inserción
    var filaInsercion = encontrarFilaInsercion_(
      sheet,
      seccion.filaInicioEstudiantes,
      seccion.filaProximoEncabezado
    );

    // Paso 4: Garantizar buffer de separación (puede insertar filas)
    garantizarEspacioBuffer_(sheet, filaInsercion, seccion.filaProximoEncabezado);

    // Paso 5: Construir el registro
    var fechaActual = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'dd/MM/yyyy HH:mm:ss'
    );

    var registro = [
      fechaActual,
      CONFIG.nivelFijo,
      datos.nombre,
      datos.whatsapp,
      datos.correo,
      datos.diaOriginal,
      datos.horarioOriginal
    ];

    // Paso 6: Escribir los datos en la fila
    var rangoInsercion = sheet.getRange(filaInsercion, 1, 1, CONFIG.columnas.length);
    rangoInsercion.setValues([registro]);

    // Paso 7: Aplicar formato limpio (nunca hereda de encabezados)
    aplicarFormatoEstudiante_(
      sheet,
      filaInsercion,
      seccion.filaInicioEstudiantes,
      CONFIG.columnas.length
    );

    // Paso 8: Forzar escritura inmediata
    SpreadsheetApp.flush();

    var resultado = {
      fila:        filaInsercion,
      fecha:       fechaActual,
      inscritos:   estado.inscritos + 1,
      disponibles: Math.max(0, CONFIG.limiteCupos - (estado.inscritos + 1)),
      limite:      CONFIG.limiteCupos,
      duplicado:   false
    };

    // Paso 9: Marcar el envío como procesado (evita registros y correos repetidos)
    if (claveEnvio) {
      propiedades.setProperty(claveEnvio, JSON.stringify(resultado));
    }

    return resultado;

  } finally {
    lock.releaseLock();
  }
}

/**
 * Orquesta el proceso completo de una inscripción:
 *   1. Normaliza y valida los datos.
 *   2. Registra al estudiante en Google Sheets (con control de cupos).
 *   3. Solo si el registro fue correcto, envía los dos correos.
 *
 * Si el registro falla, se lanza el error y NO se envía ningún correo.
 * Si el registro tiene éxito pero el correo falla, la inscripción se
 * considera válida y se informa del fallo de correo en la respuesta.
 *
 * @param {Object} data - Datos crudos recibidos del formulario.
 * @returns {Object} Respuesta lista para el frontend.
 */
function procesarInscripcion_(data) {
  var datos = normalizarDatos_(data);
  var registro = registrarEstudiante_(datos);

  var correos = { estudiante: false, administrador: false };

  // Los correos se envían UNA sola vez por inscripción: si el envío ya
  // había sido procesado antes (duplicado), no se vuelven a enviar.
  if (!registro.duplicado) {
    correos = enviarCorreosDeInscripcion_(datos, registro);
  }

  return {
    status:      'success',
    message:     registro.duplicado
                   ? 'Esta inscripción ya había sido registrada.'
                   : 'Inscripción registrada correctamente.',
    fila:        registro.fila,
    duplicado:   Boolean(registro.duplicado),
    inscritos:   registro.inscritos,
    disponibles: registro.disponibles,
    limite:      registro.limite || CONFIG.limiteCupos,
    correos:     correos
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 4B: SISTEMA DE CORREOS ELECTRÓNICOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Paleta e identidad visual usada en las plantillas de correo.
 * Coincide con las variables CSS del sitio web (lingola-config.js / HTML).
 */
var EMAIL_ESTILOS = {
  azul:        '#132A4A',
  azulClaro:   '#1A3A66',
  dorado:      '#EAB308',
  doradoSuave: '#FEF9E7',
  fondo:       '#F1F5F9',
  tarjeta:     '#F8FAFC',
  blanco:      '#FFFFFF',
  texto:       '#1E293B',
  textoSuave:  '#64748B',
  borde:       '#E2E8F0',
  verde:       '#15803D',
  verdeSuave:  '#ECFDF5'
};

/**
 * Escapa caracteres especiales para insertar texto en HTML de forma segura.
 *
 * @param {string} texto - Texto sin procesar.
 * @returns {string} Texto seguro para HTML.
 */
function escaparHtml_(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Envía los dos correos de una inscripción confirmada.
 * Nunca interrumpe el flujo: si un envío falla, se registra y continúa.
 *
 * @param {Object} datos - Datos normalizados del estudiante.
 * @param {Object} registro - Resultado de registrarEstudiante_.
 * @returns {Object} { estudiante: boolean, administrador: boolean }
 */
function enviarCorreosDeInscripcion_(datos, registro) {
  var resultado = { estudiante: false, administrador: false };

  var info = {
    nombre:       datos.nombre,
    correo:       datos.correo,
    whatsapp:     datos.whatsapp,
    nivel:        datos.nivel,
    dias:         datos.diaOriginal,
    horario:      datos.horarioOriginal,
    grupo:        datos.grupoNombre,
    inicioClases: datos.inicioClases,
    acepto:       datos.aceptoTerminos,
    fecha:        registro.fecha || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
    inscritos:    registro.inscritos,
    disponibles:  registro.disponibles,
    limite:       registro.limite || CONFIG.limiteCupos,
    fila:         registro.fila
  };

  // ── Correo 1: confirmación al estudiante ──
  if (info.correo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.correo)) {
    try {
      MailApp.sendEmail({
        to:       info.correo,
        subject:  'Confirmación de inscripción - ' + CONFIG.marca.nombre,
        htmlBody: construirCorreoEstudiante_(info),
        body:     construirCorreoEstudianteTextoPlano_(info),
        name:     CONFIG.marca.nombre,
        replyTo:  ADMIN_EMAIL
      });
      resultado.estudiante = true;
    } catch (err) {
      registrarError_('correoEstudiante', err);
    }
  }

  // ── Correo 2: notificación al administrador ──
  if (ADMIN_EMAIL) {
    try {
      MailApp.sendEmail({
        to:       ADMIN_EMAIL,
        subject:  'Nueva inscripción recibida - ' + CONFIG.marca.nombre,
        htmlBody: construirCorreoAdministrador_(info),
        body:     construirCorreoAdminTextoPlano_(info),
        name:     CONFIG.marca.nombre,
        replyTo:  info.correo || ADMIN_EMAIL
      });
      resultado.administrador = true;
    } catch (err) {
      registrarError_('correoAdministrador', err);
    }
  }

  return resultado;
}

/**
 * Plantilla base compartida por ambos correos.
 * Usa tablas HTML y CSS inline para máxima compatibilidad con
 * Gmail, Outlook y clientes móviles.
 *
 * @param {Object} opciones - { preheader, tituloHeader, subtituloHeader, contenido }
 * @returns {string} Documento HTML completo del correo.
 */
function plantillaCorreo_(opciones) {
  var E = EMAIL_ESTILOS;

  return '' +
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
  '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
  '<title>' + escaparHtml_(opciones.tituloHeader) + '</title>' +
  '<style type="text/css">' +
  'body{margin:0;padding:0;width:100%!important;}' +
  'img{border:0;line-height:100%;outline:none;text-decoration:none;}' +
  'table{border-collapse:collapse!important;}' +
  'a{color:' + E.azul + ';}' +
  '@media only screen and (max-width:620px){' +
  '.lg-wrapper{width:100%!important;}' +
  '.lg-pad{padding-left:20px!important;padding-right:20px!important;}' +
  '.lg-h1{font-size:22px!important;}' +
  '.lg-stack{display:block!important;width:100%!important;padding:0 0 4px 0!important;text-align:left!important;}' +
  '.lg-btn{width:100%!important;}' +
  '}' +
  '</style></head>' +
  '<body style="margin:0;padding:0;background-color:' + E.fondo + ';">' +

  // Preheader oculto (resumen que muestran las bandejas de entrada)
  '<div style="display:none;font-size:1px;color:' + E.fondo + ';line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">' +
  escaparHtml_(opciones.preheader) + '</div>' +

  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' + E.fondo + ';">' +
  '<tr><td align="center" style="padding:28px 12px;">' +

  '<table role="presentation" class="lg-wrapper" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:' + E.blanco + ';border-radius:16px;overflow:hidden;box-shadow:0 6px 18px rgba(19,42,74,0.08);">' +

  // ── Franja dorada superior ──
  '<tr><td style="height:6px;background-color:' + E.dorado + ';line-height:6px;font-size:0;">&nbsp;</td></tr>' +

  // ── Encabezado de marca ──
  '<tr><td class="lg-pad" align="center" style="background-color:' + E.azul + ';padding:34px 40px 30px 40px;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td align="center" style="padding-bottom:14px;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td align="center" valign="middle" width="54" height="54" style="width:54px;height:54px;background-color:' + E.dorado + ';border-radius:50%;font-family:Arial,Helvetica,sans-serif;font-size:26px;color:' + E.azul + ';font-weight:bold;">&#127891;</td>' +
  '</tr></table></td></tr>' +
  '<tr><td align="center" style="font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:24px;font-weight:bold;color:' + E.blanco + ';letter-spacing:-0.3px;line-height:1.3;">' +
  'Lingola <span style="color:' + E.dorado + ';">English Teaching</span></td></tr>' +
  '<tr><td align="center" style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#C7D3E4;line-height:1.5;">' +
  escaparHtml_(opciones.subtituloHeader) + '</td></tr>' +
  '</table></td></tr>' +

  // ── Contenido ──
  '<tr><td class="lg-pad" style="padding:36px 40px 12px 40px;background-color:' + E.blanco + ';">' +
  opciones.contenido +
  '</td></tr>' +

  // ── Pie de página ──
  '<tr><td class="lg-pad" style="padding:26px 40px 30px 40px;background-color:' + E.tarjeta + ';border-top:1px solid ' + E.borde + ';">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + E.textoSuave + ';line-height:1.7;">' +
  '<strong style="color:' + E.azul + ';">' + escaparHtml_(CONFIG.marca.nombre) + '</strong><br />' +
  escaparHtml_(CONFIG.marca.programa) + ' &middot; Clases en vivo y online mediante Zoom<br />' +
  '<span style="color:#94A3B8;font-size:12px;">Este mensaje se generó automáticamente tras completar el formulario de inscripción.</span>' +
  '</td></tr></table></td></tr>' +

  '</table></td></tr></table></body></html>';
}

/**
 * Genera una fila de dato (etiqueta + valor) para las tarjetas de resumen.
 *
 * @param {string} etiqueta - Nombre del campo.
 * @param {string} valor - Contenido del campo.
 * @param {boolean} destacado - Si true, el valor se muestra en dorado oscuro.
 * @returns {string} Fragmento HTML de la fila.
 */
function filaDato_(etiqueta, valor, destacado) {
  var E = EMAIL_ESTILOS;
  var colorValor = destacado ? '#A16207' : E.texto;

  return '' +
  '<tr>' +
  '<td class="lg-stack" width="42%" valign="top" style="padding:10px 12px 10px 0;border-bottom:1px solid ' + E.borde + ';font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + E.textoSuave + ';line-height:1.5;">' +
  escaparHtml_(etiqueta) + '</td>' +
  '<td class="lg-stack" width="58%" valign="top" align="right" style="padding:10px 0;border-bottom:1px solid ' + E.borde + ';font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:' + colorValor + ';line-height:1.5;">' +
  escaparHtml_(valor || '—') + '</td>' +
  '</tr>';
}

/**
 * Envuelve un conjunto de filas en una tarjeta con título.
 *
 * @param {string} titulo - Título de la tarjeta.
 * @param {string} filas - HTML de las filas (ver filaDato_).
 * @returns {string} Fragmento HTML de la tarjeta.
 */
function tarjetaDatos_(titulo, filas) {
  var E = EMAIL_ESTILOS;

  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' + E.tarjeta + ';border:1px solid ' + E.borde + ';border-radius:14px;margin:0 0 26px 0;">' +
  '<tr><td style="padding:22px 24px;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
  '<tr><td colspan="2" style="padding:0 0 6px 0;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:' + E.azul + ';">' +
  '<span style="color:' + E.dorado + ';">&#9632;</span> ' + escaparHtml_(titulo) + '</td></tr>' +
  filas +
  '</table></td></tr></table>';
}

/**
 * Genera el HTML del correo de confirmación para el estudiante.
 *
 * @param {Object} info - Datos consolidados de la inscripción.
 * @returns {string} HTML del correo.
 */
function construirCorreoEstudiante_(info) {
  var E = EMAIL_ESTILOS;
  var ventanaPago = 'entre los días ' + CONFIG.pago.diaInicioMensualidad +
                    ' y ' + CONFIG.pago.diaFinMensualidad + ' de cada mes';

  var contenido = '' +
  // ── Saludo ──
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>' +
  '<h1 class="lg-h1" style="margin:0 0 14px 0;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;color:' + E.azul + ';line-height:1.3;">' +
  '¡Hola, ' + escaparHtml_(info.nombre) + '!</h1>' +
  '<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:' + E.texto + ';line-height:1.7;">' +
  'Hemos recibido correctamente tu solicitud de inscripción en <strong>' + escaparHtml_(CONFIG.marca.nombre) + '</strong>.</p>' +
  '<p style="margin:0 0 26px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:' + E.texto + ';line-height:1.7;">' +
  'A continuación encontrarás un resumen de la información proporcionada durante tu proceso de inscripción.</p>' +
  '</td></tr></table>' +

  // ── Tarjeta con los datos ──
  tarjetaDatos_('Resumen de tu inscripción',
    filaDato_('Nombre completo', info.nombre, false) +
    filaDato_('Nivel de inglés', info.nivel, false) +
    filaDato_('Días de clases', info.dias, true) +
    filaDato_('Horario', info.horario, true) +
    filaDato_('Inicio de clases', info.inicioClases, false) +
    filaDato_('Fecha de inscripción', info.fecha, false)
  ) +

  // ── ¿Qué sigue ahora? ──
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>' +
  '<h2 style="margin:0 0 16px 0;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:' + E.azul + ';line-height:1.4;">¿Qué sigue ahora?</h2>' +
  '</td></tr></table>' +

  pasoCorreo_('1', 'Realiza el pago de inscripción',
    'Este pago completa tu proceso de incorporación al programa. Se realiza mediante ' + CONFIG.pago.metodo + '.') +
  pasoCorreo_('2', 'Recibe las instrucciones por WhatsApp',
    'Después de aceptar los términos y condiciones del contrato, eres redirigido a WhatsApp desde el formulario. Es ahí, y no en este correo, donde recibes las instrucciones correspondientes al proceso de pago mediante ' + CONFIG.pago.metodo + '.') +
  pasoCorreo_('3', 'Comienza tu primer mes de clases',
    'Una vez realizado y aceptado el pago de inscripción, comienzas tus clases del primer mes a partir del primer día de clases de tu grupo: ' + escaparHtml_(info.inicioClases) + '.') +
  pasoCorreo_('4', 'Paga tu mensualidad cada mes',
    'Para asegurar tu derecho a tomar clases durante el mes siguiente, realiza el pago de la mensualidad ' + ventanaPago + ', mediante ' + CONFIG.pago.metodo + '.') +

  // ── Recordatorio destacado ──
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' + E.doradoSuave + ';border:1px solid ' + E.dorado + ';border-radius:14px;margin:10px 0 28px 0;">' +
  '<tr><td style="padding:20px 24px;font-family:Arial,Helvetica,sans-serif;">' +
  '<p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:' + E.azul + ';line-height:1.5;">&#9200; Recordatorio importante sobre el pago de mensualidad</p>' +
  '<p style="margin:0;font-size:14px;color:' + E.texto + ';line-height:1.7;">' +
  'El pago de la mensualidad debe realizarse <strong>' + ventanaPago + '</strong> para asegurar tu derecho a tomar clases durante el mes siguiente. Todos los pagos se realizan mediante <strong>' + CONFIG.pago.metodo + '</strong>.</p>' +
  '</td></tr></table>' +

  // ── Botón de WhatsApp ──
  // ── Aviso de cierre ──
  // Este correo es únicamente una confirmación informativa: el pago NO se
  // realiza desde aquí, sino por WhatsApp tras la redirección del formulario.
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:6px 0 22px 0;">' +
  '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + E.textoSuave + ';line-height:1.6;">' +
  'Este mensaje es solo una confirmación de tu inscripción. Las instrucciones de pago las recibes por WhatsApp, ' +
  'en la conversación que se abrió al finalizar tu inscripción.<br />' +
  'Si tienes cualquier duda, puedes responder a este correo.</p>' +
  '</td></tr></table>';

  return plantillaCorreo_({
    preheader:       'Hemos recibido tu solicitud de inscripción. Aquí está el resumen de tus datos.',
    tituloHeader:    'Confirmación de inscripción',
    subtituloHeader: 'Confirmación de inscripción · ' + CONFIG.marca.programa,
    contenido:       contenido
  });
}

/**
 * Genera un paso numerado para la sección "¿Qué sigue ahora?".
 *
 * @param {string} numero - Número del paso.
 * @param {string} titulo - Título del paso.
 * @param {string} descripcion - Texto explicativo.
 * @returns {string} Fragmento HTML del paso.
 */
function pasoCorreo_(numero, titulo, descripcion) {
  var E = EMAIL_ESTILOS;

  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;">' +
  '<tr>' +
  '<td valign="top" width="38" style="padding:2px 14px 0 0;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td align="center" valign="middle" width="32" height="32" style="width:32px;height:32px;background-color:' + E.azul + ';border-radius:50%;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:' + E.dorado + ';">' +
  escaparHtml_(numero) + '</td></tr></table></td>' +
  '<td valign="top" style="font-family:Arial,Helvetica,sans-serif;">' +
  '<p style="margin:0 0 3px 0;font-size:15px;font-weight:bold;color:' + E.azul + ';line-height:1.5;">' + escaparHtml_(titulo) + '</p>' +
  '<p style="margin:0;font-size:14px;color:' + E.texto + ';line-height:1.7;">' + escaparHtml_(descripcion) + '</p>' +
  '</td></tr></table>';
}

/**
 * Genera un botón compatible con todos los clientes de correo.
 *
 * @param {string} url - Destino del botón.
 * @param {string} texto - Texto visible.
 * @returns {string} Fragmento HTML del botón.
 */
function botonCorreo_(url, texto) {
  var E = EMAIL_ESTILOS;

  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:6px 0 20px 0;">' +
  '<table role="presentation" class="lg-btn" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td align="center" bgcolor="' + E.azul + '" style="border-radius:14px;">' +
  '<a href="' + escaparHtml_(url) + '" target="_blank" style="display:inline-block;padding:16px 38px;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:' + E.blanco + ';text-decoration:none;border-radius:14px;background-color:' + E.azul + ';">' +
  escaparHtml_(texto) + '</a></td></tr></table>' +
  '</td></tr></table>';
}

/**
 * Genera el HTML del correo de notificación para el administrador.
 *
 * @param {Object} info - Datos consolidados de la inscripción.
 * @returns {string} HTML del correo.
 */
function construirCorreoAdministrador_(info) {
  var E = EMAIL_ESTILOS;
  var cupos = info.disponibles + ' de ' + info.limite + ' cupos disponibles';
  var ocupacion = info.inscritos + ' de ' + info.limite + ' cupos ocupados';

  var contenido = '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>' +
  '<h1 class="lg-h1" style="margin:0 0 10px 0;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:25px;font-weight:bold;color:' + E.azul + ';line-height:1.3;">Nueva inscripción recibida</h1>' +
  '<p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:' + E.texto + ';line-height:1.7;">' +
  '<strong style="color:' + E.azul + ';">' + escaparHtml_(info.nombre) + '</strong> completó el formulario de inscripción del ' + escaparHtml_(CONFIG.marca.programa) + '.</p>' +
  '</td></tr></table>' +

  tarjetaDatos_('Datos del estudiante',
    filaDato_('Nombre completo', info.nombre, false) +
    filaDato_('Correo electrónico', info.correo, false) +
    filaDato_('Número de WhatsApp', info.whatsapp, false) +
    filaDato_('Nivel de inglés', info.nivel, false) +
    filaDato_('Fecha y hora de inscripción', info.fecha, false) +
    filaDato_('Fila en la hoja de cálculo', info.fila ? String(info.fila) : '—', false)
  ) +

  tarjetaDatos_('Grupo seleccionado',
    filaDato_('Días', info.dias, true) +
    filaDato_('Horario', info.horario, true) +
    filaDato_('Grupo', info.grupo, false) +
    filaDato_('Inicio de clases', info.inicioClases, false) +
    filaDato_('Ocupación del grupo', ocupacion, false) +
    filaDato_('Cupos disponibles', cupos, true)
  ) +

  // ── Estado de la inscripción ──
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' + E.verdeSuave + ';border:1px solid #A7F3D0;border-radius:14px;margin:0 0 24px 0;">' +
  '<tr><td style="padding:18px 24px;font-family:Arial,Helvetica,sans-serif;">' +
  '<p style="margin:0 0 6px 0;font-size:14px;font-weight:bold;color:' + E.verde + ';line-height:1.5;">&#10004; Estado de la inscripción: registrada en Google Sheets</p>' +
  '<p style="margin:0;font-size:14px;color:' + E.texto + ';line-height:1.6;">' +
  'Términos y condiciones: <strong>' + (info.acepto ? 'Aceptados' : 'No confirmados') + '</strong></p>' +
  '</td></tr></table>' +

  botonCorreo_('https://wa.me/' + soloDigitos_(info.whatsapp), 'Escribir al estudiante por WhatsApp');

  return plantillaCorreo_({
    preheader:       'Nueva inscripción: ' + info.nombre + ' — ' + info.dias + ' ' + info.horario,
    tituloHeader:    'Nueva inscripción recibida',
    subtituloHeader: 'Notificación administrativa · ' + CONFIG.marca.programa,
    contenido:       contenido
  });
}

/**
 * Extrae únicamente los dígitos de un número de teléfono.
 *
 * @param {string} numero - Número tal como lo escribió el estudiante.
 * @returns {string} Solo los dígitos.
 */
function soloDigitos_(numero) {
  return String(numero || '').replace(/\D/g, '');
}

/**
 * Versión en texto plano del correo del estudiante.
 * Se usa como alternativa cuando el cliente no muestra HTML.
 *
 * @param {Object} info - Datos consolidados.
 * @returns {string} Texto plano.
 */
function construirCorreoEstudianteTextoPlano_(info) {
  var ventanaPago = 'entre los días ' + CONFIG.pago.diaInicioMensualidad +
                    ' y ' + CONFIG.pago.diaFinMensualidad + ' de cada mes';

  return [
    '¡Hola, ' + info.nombre + '!',
    '',
    'Hemos recibido correctamente tu solicitud de inscripción en ' + CONFIG.marca.nombre + '.',
    '',
    'RESUMEN DE TU INSCRIPCIÓN',
    'Nombre completo: ' + info.nombre,
    'Nivel de inglés: ' + info.nivel,
    'Días de clases: ' + info.dias,
    'Horario: ' + info.horario,
    'Inicio de clases: ' + info.inicioClases,
    'Fecha de inscripción: ' + info.fecha,
    '',
    '¿QUÉ SIGUE AHORA?',
    '1. Realiza el pago de inscripción mediante ' + CONFIG.pago.metodo + '.',
    '2. Después de aceptar los términos del contrato, eres redirigido a WhatsApp desde el formulario. Es ahí, y no en este correo, donde recibes las instrucciones del proceso de pago.',
    '3. Comienzas tu primer mes de clases a partir del ' + info.inicioClases + '.',
    '4. Paga tu mensualidad ' + ventanaPago + ' para asegurar tus clases del mes siguiente.',
    '',
    'Este mensaje es solo una confirmación de tu inscripción.',
    'Si tienes cualquier duda, puedes responder a este correo.',
    '',
    CONFIG.marca.nombre
  ].join('\n');
}

/**
 * Versión en texto plano del correo del administrador.
 *
 * @param {Object} info - Datos consolidados.
 * @returns {string} Texto plano.
 */
function construirCorreoAdminTextoPlano_(info) {
  return [
    'NUEVA INSCRIPCIÓN RECIBIDA — ' + CONFIG.marca.nombre,
    '',
    'Nombre completo: ' + info.nombre,
    'Correo electrónico: ' + info.correo,
    'WhatsApp: ' + info.whatsapp,
    'Nivel de inglés: ' + info.nivel,
    'Fecha y hora: ' + info.fecha,
    'Fila en la hoja: ' + (info.fila || '—'),
    '',
    'GRUPO SELECCIONADO',
    'Días: ' + info.dias,
    'Horario: ' + info.horario,
    'Grupo: ' + info.grupo,
    'Ocupación: ' + info.inscritos + ' de ' + info.limite,
    'Cupos disponibles: ' + info.disponibles + ' de ' + info.limite,
    '',
    'Estado: registrada en Google Sheets',
    'Términos y condiciones: ' + (info.acepto ? 'Aceptados' : 'No confirmados')
  ].join('\n');
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 5: FUNCIÓN DE CONFIGURACIÓN INICIAL (setup)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea o recrea la estructura visual completa de la hoja "Inscripciones Básico".
 *
 * Genera automáticamente:
 *   - Encabezados de día (LUNES Y JUEVES / MARTES Y VIERNES) → Azul marino
 *   - Encabezados de horario (nombre del grupo + rango) → Dorado
 *   - Cabecera de columnas (Fecha, Nivel, Nombre...) → Gris claro
 *   - Filas de buffer de separación entre bloques
 *   - Anchos de columna optimizados
 *
 * ⚠️ CUIDADO: Esta función borra todo el contenido de la hoja si ya existe.
 *    Ejecutar solo en la configuración inicial.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.hojaNombre);

  // Crear la hoja si no existe, o limpiarla si ya existe
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.hojaNombre);
  } else {
    sheet.clear();
    sheet.clearFormats();
    // Resetear a un número razonable de filas
    var filasActuales = sheet.getMaxRows();
    if (filasActuales > 200) {
      sheet.deleteRows(201, filasActuales - 200);
    } else if (filasActuales < 200) {
      sheet.insertRowsAfter(filasActuales, 200 - filasActuales);
    }
  }

  // Asegurar que hay suficientes columnas
  var colsActuales = sheet.getMaxColumns();
  if (colsActuales < CONFIG.columnas.length) {
    sheet.insertColumnsAfter(colsActuales, CONFIG.columnas.length - colsActuales);
  }

  var filaActual = 1;
  var numCols = CONFIG.columnas.length;

  // ── Iterar por cada grupo de días ──
  for (var d = 0; d < CONFIG.dias.length; d++) {
    var dia = CONFIG.dias[d];

    // ═══ ENCABEZADO DE DÍA ═══
    filaActual = escribirEncabezadoDia_(sheet, filaActual, dia, numCols);

    // ── Iterar por cada horario dentro del día ──
    for (var h = 0; h < CONFIG.horarios.length; h++) {
      var horario = CONFIG.horarios[h];

      // ═══ ENCABEZADO DE HORARIO (dos filas: nombre + rango) ═══
      filaActual = escribirEncabezadoHorario_(sheet, filaActual, horario, numCols);

      // ═══ CABECERA DE COLUMNAS ═══
      filaActual = escribirCabeceraColumnas_(sheet, filaActual, numCols);

      // ═══ BUFFER DE SEPARACIÓN ═══
      filaActual += CONFIG.filasSeparacion;
    }

    // Espacio extra entre bloques de días
    filaActual += 2;
  }

  // ── Configurar anchos de columna ──
  for (var c = 0; c < CONFIG.anchosColumnas.length; c++) {
    sheet.setColumnWidth(c + 1, CONFIG.anchosColumnas[c]);
  }

  // ── Limpiar filas sobrantes ──
  var filasMaximas = sheet.getMaxRows();
  if (filasMaximas > filaActual + 10) {
    sheet.deleteRows(filaActual + 10, filasMaximas - (filaActual + 10));
  }

  SpreadsheetApp.flush();
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 6: FUNCIONES DE SETUP (ESCRITURA DE ENCABEZADOS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escribe el encabezado de un grupo de días (ej. "LUNES Y JUEVES").
 *
 * @param {Sheet} sheet - La hoja.
 * @param {number} fila - Fila donde escribir.
 * @param {string} dia - Nombre del día en mayúsculas.
 * @param {number} numCols - Número de columnas a usar para el merge.
 * @returns {number} Siguiente fila disponible.
 */
function escribirEncabezadoDia_(sheet, fila, dia, numCols) {
  var rango = sheet.getRange(fila, 1, 1, numCols);
  rango.merge();
  rango.setValue(dia);
  rango
    .setBackground(CONFIG.colores.fondoDias)
    .setFontColor(CONFIG.colores.textoDias)
    .setFontWeight('bold')
    .setFontSize(14)
    .setFontFamily('Arial')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(fila, 45);

  return fila + 1;
}

/**
 * Escribe el encabezado de un horario (nombre del grupo + rango de hora).
 * Ocupa dos filas con fondo dorado.
 *
 * @param {Sheet} sheet - La hoja.
 * @param {number} fila - Fila donde empezar a escribir.
 * @param {Object} horario - Objeto con { nombreGrupo, rango }.
 * @param {number} numCols - Número de columnas para el merge.
 * @returns {number} Siguiente fila disponible.
 */
function escribirEncabezadoHorario_(sheet, fila, horario, numCols) {
  // Fila 1: Nombre del grupo
  var rangoNombre = sheet.getRange(fila, 1, 1, numCols);
  rangoNombre.merge();
  rangoNombre.setValue(horario.nombreGrupo);
  rangoNombre
    .setBackground(CONFIG.colores.fondoHorario)
    .setFontColor(CONFIG.colores.textoHorario)
    .setFontWeight('bold')
    .setFontSize(12)
    .setFontFamily('Arial')
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(fila, 32);

  fila++;

  // Fila 2: Rango de hora
  var rangoHora = sheet.getRange(fila, 1, 1, numCols);
  rangoHora.merge();
  rangoHora.setValue(horario.rango);
  rangoHora
    .setBackground(CONFIG.colores.fondoHorario)
    .setFontColor(CONFIG.colores.textoHorario)
    .setFontWeight('bold')
    .setFontSize(11)
    .setFontFamily('Arial')
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(fila, 28);

  return fila + 1;
}

/**
 * Escribe la fila de cabecera de columnas (Fecha, Nivel, Nombre...).
 *
 * @param {Sheet} sheet - La hoja.
 * @param {number} fila - Fila donde escribir.
 * @param {number} numCols - Número de columnas.
 * @returns {number} Siguiente fila disponible.
 */
function escribirCabeceraColumnas_(sheet, fila, numCols) {
  var rango = sheet.getRange(fila, 1, 1, numCols);
  rango.setValues([CONFIG.columnas]);
  rango
    .setBackground(CONFIG.colores.fondoCabecera)
    .setFontColor(CONFIG.colores.textoCabecera)
    .setFontWeight('bold')
    .setFontSize(10)
    .setFontFamily('Arial')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(false, false, true, false, false, false, '#CBD5E1', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(fila, 28);

  return fila + 1;
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 7: FUNCIONES DE PRUEBA Y DIAGNÓSTICO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Función de prueba para simular una inscripción sin necesidad del formulario HTML.
 * Útil para verificar que el script funciona correctamente después de setup().
 *
 * Para ejecutarla:
 *   1. Abre el editor de Apps Script.
 *   2. Selecciona esta función en el desplegable.
 *   3. Haz clic en ▶ Ejecutar.
 */
function testInscripcion() {
  var datosPrueba = {
    nombre:       'Estudiante de Prueba',
    whatsapp:     '+1 809-555-0001',
    correo:       'prueba@ejemplo.com',
    dias:         'Lunes y Jueves',
    horario:      '9:00 AM – 10:30 AM',
    grupo:        'Primer grupo de la mañana',
    nivel:        'Inglés Básico Nuevo',
    inicioClases: CONFIG.marca.inicioClasesPorDefecto,
    aceptoTerminos: true,
    submissionId: 'test-' + new Date().getTime()
  };

  var respuesta = procesarInscripcion_(datosPrueba);
  Logger.log('✅ Resultado: ' + JSON.stringify(respuesta));
}

/**
 * Muestra en el registro cuántos cupos quedan en cada uno de los 8 grupos.
 * Útil para verificar el sistema de cupos sin abrir la hoja.
 */
function testDisponibilidad() {
  var grupos = obtenerDisponibilidad_();

  Logger.log('════ DISPONIBILIDAD DE CUPOS (límite: ' + CONFIG.limiteCupos + ') ════');
  for (var i = 0; i < grupos.length; i++) {
    var g = grupos[i];
    Logger.log(
      (g.lleno ? '🔴 CUPO LLENO ' : '🟢 ') +
      g.dias + ' / ' + g.rango + ' → ' +
      g.disponibles + ' de ' + g.limite + ' cupos disponibles' +
      ' (inscritos: ' + g.inscritos + ')'
    );
  }
}

/**
 * Envía a ADMIN_EMAIL una muestra de los DOS correos con datos de ejemplo.
 * Permite revisar el diseño sin realizar una inscripción real.
 */
function testCorreos() {
  var info = {
    nombre:       'Estudiante de Prueba',
    correo:       ADMIN_EMAIL,
    whatsapp:     '+1 809-555-0001',
    nivel:        'Inglés Básico Nuevo',
    dias:         'Lunes y Jueves',
    horario:      '9:00 AM – 10:30 AM',
    grupo:        'Primer grupo de la mañana',
    inicioClases: CONFIG.marca.inicioClasesPorDefecto,
    acepto:       true,
    fecha:        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
    inscritos:    3,
    disponibles:  12,
    limite:       CONFIG.limiteCupos,
    fila:         0
  };

  MailApp.sendEmail({
    to:       ADMIN_EMAIL,
    subject:  '[PRUEBA] Confirmación de inscripción - ' + CONFIG.marca.nombre,
    htmlBody: construirCorreoEstudiante_(info),
    body:     construirCorreoEstudianteTextoPlano_(info),
    name:     CONFIG.marca.nombre
  });

  MailApp.sendEmail({
    to:       ADMIN_EMAIL,
    subject:  '[PRUEBA] Nueva inscripción recibida - ' + CONFIG.marca.nombre,
    htmlBody: construirCorreoAdministrador_(info),
    body:     construirCorreoAdminTextoPlano_(info),
    name:     CONFIG.marca.nombre
  });

  Logger.log('✅ Correos de prueba enviados a ' + ADMIN_EMAIL);
  Logger.log('Cuota de correos restante hoy: ' + MailApp.getRemainingDailyQuota());
}

/**
 * Borra las marcas de envíos ya procesados (claves de idempotencia).
 *
 * Estas marcas evitan que un mismo envío se registre o notifique dos veces.
 * Ejecuta esta función solo si necesitas limpiar el historial técnico,
 * por ejemplo después de muchas pruebas. No afecta a la hoja de cálculo.
 */
function limpiarMarcasDeEnvio() {
  var propiedades = PropertiesService.getScriptProperties();
  var todas = propiedades.getProperties();
  var eliminadas = 0;

  for (var clave in todas) {
    if (clave.indexOf(CONFIG.prefijoEnvio) === 0) {
      propiedades.deleteProperty(clave);
      eliminadas++;
    }
  }

  Logger.log('🧹 Marcas de envío eliminadas: ' + eliminadas);
}

/**
 * Función de prueba masiva para verificar el buffer dinámico.
 * Inserta 3 estudiantes en cada grupo para verificar que los buffers se expanden correctamente.
 *
 * ⚠️ Solo para pruebas. Ejecuta setup() antes de usar esta función.
 */
function testInscripcionMasiva() {
  var combinaciones = [
    { dias: 'Lunes y Jueves',   grupo: 'Primer grupo de la mañana'  },
    { dias: 'Lunes y Jueves',   grupo: 'Segundo grupo de la mañana' },
    { dias: 'Lunes y Jueves',   grupo: 'Primer grupo de la tarde'   },
    { dias: 'Lunes y Jueves',   grupo: 'Segundo grupo de la tarde'  },
    { dias: 'Martes y Viernes', grupo: 'Primer grupo de la mañana'  },
    { dias: 'Martes y Viernes', grupo: 'Segundo grupo de la mañana' },
    { dias: 'Martes y Viernes', grupo: 'Primer grupo de la tarde'   },
    { dias: 'Martes y Viernes', grupo: 'Segundo grupo de la tarde'  }
  ];

  var rangosHora = {
    'Primer grupo de la mañana':  '9:00 AM – 10:30 AM',
    'Segundo grupo de la mañana': '11:00 AM – 12:30 PM',
    'Primer grupo de la tarde':   '2:00 PM – 3:30 PM',
    'Segundo grupo de la tarde':  '4:00 PM – 5:30 PM'
  };

  var contador = 1;

  for (var c = 0; c < combinaciones.length; c++) {
    for (var n = 0; n < 3; n++) {
      var datos = {
        nombre:   'Estudiante Test ' + contador,
        whatsapp: '+1 809-555-' + String(1000 + contador),
        correo:   'test' + contador + '@ejemplo.com',
        dias:     combinaciones[c].dias,
        horario:  rangosHora[combinaciones[c].grupo],
        grupo:    combinaciones[c].grupo
      };

      var datosNorm = normalizarDatos_(datos);
      // Registro directo: esta prueba no envía correos.
      var resultado = registrarEstudiante_(datosNorm);
      Logger.log('✅ #' + contador + ' → ' + combinaciones[c].dias + ' / ' + combinaciones[c].grupo + ' → Fila ' + resultado.fila);
      contador++;
    }
  }

  Logger.log('════════════════════════════════════════');
  Logger.log('✅ Test masivo completado: ' + (contador - 1) + ' estudiantes insertados.');
}
