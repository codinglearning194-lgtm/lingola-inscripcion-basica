/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  Lingola English Teaching — Programa Inglés Básico                      ║
 * ║  Backend Independiente de Google Apps Script                             ║
 * ║                                                                         ║
 * ║  Versión:  4.0                                                          ║
 * ║  Fecha:    Agosto 2026                                                  ║
 * ║                                                                         ║
 * ║  NOVEDADES v4.0 — Robustez ante alta concurrencia (~100 solicitudes):   ║
 * ║  • Sección crítica reducida: UNA sola lectura de la hoja por registro.  ║
 * ║  • tryLock() con espera controlada; nadie recibe "Lock timeout" crudo.  ║
 * ║  • Token temporal de un solo uso (HMAC-SHA256) para cada inscripción.   ║
 * ║  • Límites de frecuencia (rate limiting) global, por correo y por       ║
 * ║    WhatsApp, apoyados en CacheService.                                  ║
 * ║  • Validación estricta de todos los campos en el servidor.              ║
 * ║  • Neutralización de fórmulas al escribir en Google Sheets.             ║
 * ║  • Deduplicación de correo en toda la hoja, no solo dentro del grupo.   ║
 * ║  • Respuestas de error controladas: nunca se expone el detalle interno. ║
 * ║  • Disponibilidad servida desde caché (20 s) en lugar de leer la hoja.  ║
 * ║                                                                         ║
 * ║  INSTRUCCIONES:                                                         ║
 * ║  1. Crea un nuevo proyecto en Google Apps Script.                        ║
 * ║  2. Pega este código completo.                                          ║
 * ║  3. Ejecuta la función setup() para crear la estructura en Sheets.      ║
 * ║     · Si YA tienes inscripciones registradas, NO ejecutes setup():      ║
 * ║       ejecuta ampliarBloquesParaCupos(), que amplía los bloques sin     ║
 * ║       borrar nada.                                                      ║
 * ║  4. Publica como Web App (Implementar > Nueva Implementación):          ║
 * ║       - Ejecutar como:  Yo (tu cuenta)                                  ║
 * ║       - Quién tiene acceso:  Cualquier usuario                          ║
 * ║  5. Copia la URL (/exec) y colócala en lingola-config.js →              ║
 * ║     LINGOLA_CONFIG.backend.gasWebAppUrl                                 ║
 * ║  6. Autoriza los permisos de Gmail la primera vez (envío de correos).   ║
 * ║                                                                         ║
 * ║  ⚠️  LÍMITES REALES DE GOOGLE APPS SCRIPT (no dependen de este código): ║
 * ║  • 30 ejecuciones simultáneas por script.                               ║
 * ║  • Cuenta Gmail personal: 100 correos/día → 50 inscripciones/día.       ║
 * ║    Google Workspace: 1500 correos/día → 750 inscripciones/día.          ║
 * ║  • 6 min de ejecución por solicitud (igual en Workspace).               ║
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
 * Se conserva por compatibilidad con versiones anteriores del backend.
 * @type {string}
 */
var ERROR_CUPO_LLENO = '[CUPO_LLENO]';

/**
 * Códigos de error que viajan al frontend.
 * El frontend decide qué mensaje mostrar a partir de estos valores, de modo
 * que el texto interno del error nunca es necesario para tomar decisiones.
 */
var CODIGOS = {
  CUPO_LLENO:             'CUPO_LLENO',              // El grupo llegó al límite
  DATOS_INVALIDOS:        'DATOS_INVALIDOS',         // Payload manipulado o incompleto
  TOKEN_INVALIDO:         'TOKEN_INVALIDO',          // Falta, está falsificado o ya se usó
  TOKEN_EXPIRADO:         'TOKEN_EXPIRADO',          // Caducó por antigüedad
  DEMASIADAS_SOLICITUDES: 'DEMASIADAS_SOLICITUDES',  // Rate limiting por identidad
  OCUPADO:                'OCUPADO',                 // Saturación temporal: reintentar
  ERROR:                  'ERROR'                    // Cualquier otro fallo
};

/** Claves usadas dentro de CacheService y PropertiesService. */
var CLAVES = {
  secretoToken:   'LINGOLA_TOKEN_SECRET',  // ScriptProperties
  disponibilidad: 'disp_v4',               // Cache: respuesta de ?action=disponibilidad
  token:          'tk_',                   // Cache: nonce de token ya consumido
  rate:           'rl_'                    // Cache: contadores de frecuencia
};


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

  // ── Zona horaria oficial del sistema de inscripciones ──
  // ÚNICA fuente de verdad para la fecha y hora de cada inscripción: la que
  // se escribe en Google Sheets y la que aparece en el correo de confirmación.
  //
  // Antes se usaba Session.getScriptTimeZone(), que devuelve la zona guardada
  // en el proyecto de Apps Script (appsscript.json → "timeZone"). Google la
  // fija automáticamente al crear el proyecto, tomando la del equipo desde el
  // que se creó, y NO se actualiza al corregir el reloj del ordenador: por eso
  // las horas quedaban desfasadas. Con un identificador IANA explícito la hora
  // registrada ya no depende ni del servidor, ni del navegador del estudiante,
  // ni de la configuración del proyecto.
  //
  // El identificador debe ser IANA (por ejemplo 'America/Santo_Domingo'),
  // nunca un desfase fijo tipo 'UTC-4': así los cambios de horario de verano,
  // si algún día aplicaran, se resuelven solos.
  //
  // Recomendado: ajusta también la zona del proyecto en el editor de Apps
  // Script (⚙️ Configuración del proyecto → Zona horaria) al mismo valor, para
  // que los registros de ejecución y los activadores coincidan. El código ya
  // no depende de ello, pero evita confusiones al diagnosticar.
  zonaHoraria: 'America/Santo_Domingo',

  // Formato con el que se guarda y se muestra la fecha de inscripción.
  // Se usa el mismo en la hoja y en el correo para que sean idénticos.
  formatoFechaHora: 'dd/MM/yyyy HH:mm:ss',

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
    inicioClasesPorDefecto: 'Martes 1 de septiembre de 2026'
  },

  // ── Condiciones de pago (deben coincidir con el contrato) ──
  pago: {
    diaInicioMensualidad: 7,
    diaFinMensualidad:    15,
    metodo:               'transferencia bancaria'
  },

  // ── Prefijo de las claves de idempotencia ──
  prefijoEnvio: 'SUB_',

  // ── Longitudes y formatos aceptados por el servidor ──
  // El backend NUNCA confía en las validaciones del HTML/JavaScript: todo
  // campo que llega se vuelve a comprobar contra estos límites.
  limites: {
    nombreMin:            3,
    nombreMax:            80,
    whatsappMax:          25,    // Caracteres del campo tal cual se escribió
    whatsappDigitosMin:   8,     // Dígitos reales una vez retirado el formato
    whatsappDigitosMax:   15,    // Máximo del estándar E.164
    correoMax:            100,
    submissionIdMax:      64,
    tokenMax:             400,
    payloadMax:           8000   // Bytes del cuerpo de la solicitud
  },

  // ── Concurrencia y protección contra abuso ──
  seguridad: {
    // Si se desactiva, el endpoint vuelve a aceptar inscripciones sin token.
    // Se deja configurable para poder diagnosticar, no para uso normal.
    tokenRequerido:           true,
    tokenTtlSegundos:         1800,   // 30 min de validez

    // Espera máxima por el bloqueo antes de responder OCUPADO.
    // Con ~0,8 s de sección crítica, cubre una cola de ~55 solicitudes.
    esperaLockMs:             45000,

    // Rate limiting (ventanas fijas sobre CacheService).
    // El tope global va holgadamente por encima del pico legítimo previsto
    // (100 usuarios + reintentos) para no castigar una avalancha real.
    limiteGlobalIntentos:     400,  ventanaGlobalSegundos:     300,
    limitePorCorreo:          5,    ventanaPorCorreoSegundos:  900,
    limitePorWhatsapp:        6,    ventanaPorWhatsappSegundos: 900,
    limiteTokensGlobal:       600,  ventanaTokensSegundos:     300
  },

  // ── Tiempos de vida en CacheService ──
  cache: {
    disponibilidadSegundos: 20,     // Evita releer la hoja en cada visita
    idempotenciaSegundos:   21600   // 6 h: máximo que admite CacheService
  },

  // ── Política de duplicados ──
  duplicados: {
    // 'global' → un correo solo puede inscribirse una vez en toda la hoja.
    // 'grupo'  → comportamiento anterior: se permite el mismo correo en
    //            grupos distintos.
    alcance:     'global',
    // Bloquear también por número de WhatsApp repetido. Desactivado porque
    // dos familiares pueden compartir el mismo número de contacto.
    porWhatsapp: false
  },

  // ── Correos que se envían por cada inscripción ──
  correos: {
    // Confirmación al estudiante. Es la razón por la que se pide el correo,
    // así que desactivarlo dejaría al estudiante sin comprobante.
    confirmarEstudiante: true,

    // Aviso al administrador por CADA inscripción.
    //
    // Desactivado a propósito: cada inscripción consumía DOS correos de la
    // cuota diaria (100/día en una cuenta Gmail personal), lo que limitaba el
    // sistema a 50 inscripciones al día. Con esto en false se envía UNO solo
    // y la capacidad sube a 100 inscripciones diarias sin cambiar de cuenta.
    //
    // No se pierde información: cada inscripción queda registrada en la hoja
    // de cálculo, que es la fuente de consulta habitual. Ponlo en true si
    // prefieres recuperar el aviso inmediato por correo.
    notificarAdministrador: false
  }
};


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 1B: EXPRESIONES REGULARES DE VALIDACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nombre: letras latinas (con acentos), espacios, apóstrofos, puntos y guiones.
 * Deliberadamente NO admite dígitos ni signos, que es lo que caracteriza a los
 * envíos automatizados y a los intentos de inyectar contenido en la hoja.
 */
var RE_NOMBRE = /^[A-Za-zÀ-ÖØ-öø-ÿŠŽšžŸ' .’\-]+$/;

/** Correo electrónico: comprobación estructural, no de existencia real. */
var RE_CORREO = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/;

/** Teléfono tal como lo escribe una persona: dígitos y separadores comunes. */
var RE_WHATSAPP = /^[0-9+\-()\s.]+$/;

/** Identificador de envío generado por el frontend. */
var RE_SUBMISSION_ID = /^[A-Za-z0-9_\-]+$/;


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 2: PUNTOS DE ENTRADA (doGet / doPost)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Responde a solicitudes GET.
 *
 * Acciones disponibles (parámetro "action"):
 *   • (ninguna)        → Verificación de que el backend está activo.
 *   • token            → Emite un token temporal de un solo uso.
 *   • disponibilidad   → Devuelve los cupos libres de los 8 grupos.
 *   • inscribir        → Registra una inscripción (respaldo cuando el
 *                        navegador bloquea la lectura de la respuesta POST).
 *
 * Si se envía el parámetro "callback", la respuesta se devuelve en formato
 * JSONP. Esto permite que una página estática lea el resultado sin depender
 * de la configuración CORS del navegador.
 *
 * Ninguna excepción escapa de aquí: cualquier fallo se traduce en una
 * respuesta JSON controlada, de modo que un error no derriba el servicio
 * ni afecta a las demás solicitudes.
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
    if (accion === 'token') {
      return responder_(emitirRespuestaDeToken_(), callback);
    }

    if (accion === 'disponibilidad') {
      return responder_({
        status: 'success',
        limite: CONFIG.limiteCupos,
        grupos: obtenerDisponibilidad_()
      }, callback);
    }

    if (accion === 'inscribir') {
      return responder_(procesarInscripcion_(extraerDatosDelRequest_(e)), callback);
    }

    return responder_({
      status: 'success',
      message: 'Backend Lingola — Inglés Básico v4.0 — Activo.'
    }, callback);

  } catch (err) {
    registrarError_('doGet:' + accion, err);
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
 * Construye la respuesta de la acción "token".
 * La emisión también está limitada en frecuencia: aunque es una operación
 * barata (no toca Google Sheets), no debe poder usarse para consumir
 * ejecuciones del script de forma indefinida.
 *
 * @returns {Object} Respuesta con el token y su vigencia en segundos.
 */
function emitirRespuestaDeToken_() {
  var S = CONFIG.seguridad;

  if (!registrarIntento_('tok', S.limiteTokensGlobal, S.ventanaTokensSegundos)) {
    return {
      status:  'error',
      code:    CODIGOS.OCUPADO,
      message: 'El sistema está recibiendo muchas solicitudes. Inténtalo de nuevo en un minuto.'
    };
  }

  return {
    status:   'success',
    token:    emitirToken_(),
    expiraEn: S.tokenTtlSegundos
  };
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
 * Crea un error "controlado": lleva un código explícito y un mensaje escrito
 * por nosotros, apto para mostrarse tal cual al estudiante.
 *
 * Todo lo que NO sea un error controlado se considera un fallo interno y se
 * sustituye por un mensaje genérico antes de salir del servidor.
 *
 * @param {string} codigo - Uno de los valores de CODIGOS.
 * @param {string} mensaje - Texto pensado para el usuario final.
 * @returns {Error} Error listo para lanzarse.
 */
function errorControlado_(codigo, mensaje) {
  var err = new Error(mensaje);
  err.codigoLingola = codigo;
  return err;
}

/**
 * Traduce un error interno en una respuesta comprensible para el frontend.
 *
 * Regla de seguridad: solo viajan al usuario los mensajes que hemos escrito
 * nosotros. Los errores de la plataforma (tiempos de espera de Sheets,
 * excepciones de tipo, cuotas de Google, rutas de archivo) se registran en el
 * log de ejecuciones y se reemplazan por un texto neutro.
 *
 * @param {Error} err - Error capturado.
 * @returns {Object} Respuesta con status, code y message.
 */
function construirRespuestaDeError_(err) {
  // 1. Error controlado: su mensaje ya es apto para el usuario.
  if (err && err.codigoLingola) {
    return { status: 'error', code: err.codigoLingola, message: err.message };
  }

  // 2. Compatibilidad con el marcador de cupo lleno de versiones anteriores.
  var mensaje = (err && err.message) ? String(err.message) : '';
  if (mensaje.indexOf(ERROR_CUPO_LLENO) === 0) {
    return {
      status:  'error',
      code:    CODIGOS.CUPO_LLENO,
      message: mensaje.replace(ERROR_CUPO_LLENO, '').trim()
    };
  }

  // 3. Cualquier otra cosa es un fallo interno: no se detalla hacia fuera.
  return {
    status:  'error',
    code:    CODIGOS.ERROR,
    message: 'No pudimos completar tu inscripción en este momento. ' +
             'Vuelve a intentarlo en unos minutos o escríbenos por WhatsApp.'
  };
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
 * Devuelve la fecha y hora actuales en la zona horaria oficial del sistema.
 *
 * Es el ÚNICO punto del backend que lee el reloj para registrar una
 * inscripción. Se llama una sola vez por inscripción y el texto resultante
 * viaja tal cual a la hoja de cálculo y al correo de confirmación, de modo que
 * ambos muestran exactamente la misma hora, sin reconversiones intermedias.
 *
 * No se suma ni se resta ningún desfase a mano: la conversión la hace
 * Utilities.formatDate a partir del identificador IANA de CONFIG.zonaHoraria,
 * así que un eventual cambio de horario de verano se aplicaría solo.
 *
 * Si CONFIG.zonaHoraria quedara vacía por error, se recurre a la zona del
 * proyecto para no dejar la celda sin fecha, pero eso es solo una red de
 * seguridad: el funcionamiento normal nunca pasa por ahí.
 *
 * @returns {string} Fecha y hora con el formato CONFIG.formatoFechaHora.
 */
function fechaHoraLocal_() {
  var zona = CONFIG.zonaHoraria || Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), zona, CONFIG.formatoFechaHora);
}

/**
 * Extrae los datos enviados desde el formulario, independientemente del formato.
 *
 * @param {Object} e - Evento de solicitud POST.
 * @returns {Object} Datos parseados del formulario.
 * @throws {Error} Si no se pueden extraer datos válidos.
 */
function extraerDatosDelRequest_(e) {
  if (!e) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'No se recibieron datos válidos en la solicitud.');
  }

  // Formato 1: JSON directo en el body.
  // fetch() sin cabeceras personalizadas envía "text/plain", lo que evita
  // la petición preflight de CORS; por eso ambos tipos son válidos.
  if (e.postData && e.postData.contents) {
    var tipo = e.postData.type || '';
    if (tipo.indexOf('application/json') === 0 || tipo.indexOf('text/plain') === 0) {
      return interpretarJson_(e.postData.contents);
    }
  }

  // Formato 2: Form-encoded o query string con campo "data"
  if (e.parameter && e.parameter.data) {
    return interpretarJson_(e.parameter.data);
  }

  // Formato 3: Parámetros directos (fallback)
  if (e.parameter && e.parameter.nombre) {
    return e.parameter;
  }

  throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'No se recibieron datos válidos en la solicitud.');
}

/**
 * Convierte texto en objeto controlando tanto el tamaño como el formato.
 *
 * El límite de tamaño se aplica ANTES de parsear: así una carga enorme se
 * rechaza sin consumir tiempo de CPU ni memoria del script.
 *
 * @param {string} texto - Contenido recibido.
 * @returns {Object} Objeto resultante.
 * @throws {Error} Error controlado si el contenido no es un objeto JSON válido.
 */
function interpretarJson_(texto) {
  var contenido = String(texto === null || texto === undefined ? '' : texto);

  if (contenido.length > CONFIG.limites.payloadMax) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'La solicitud enviada es demasiado grande.');
  }

  var objeto;
  try {
    objeto = JSON.parse(contenido);
  } catch (err) {
    // El detalle del parser ("Unexpected token…") no aporta nada al usuario
    // y describe cómo procesamos la entrada: se queda en el log.
    registrarError_('interpretarJson', err);
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'No se recibieron datos válidos en la solicitud.');
  }

  if (!objeto || typeof objeto !== 'object' || Object.prototype.toString.call(objeto) === '[object Array]') {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'No se recibieron datos válidos en la solicitud.');
  }

  return objeto;
}

/**
 * Convierte un valor recibido en texto, rechazando lo que no puede serlo.
 *
 * Motivo: `(data.nombre || '').trim()` revienta con un TypeError si el campo
 * llega como número, objeto o array. Aquí esos casos se detectan y se
 * convierten en un error controlado en lugar de una excepción interna.
 *
 * @param {*} valor - Valor tal como llegó en la solicitud.
 * @returns {string|null} Texto ya recortado, o null si el tipo no es aceptable.
 */
function textoDelCampo_(valor) {
  if (valor === null || valor === undefined) return '';

  var tipo = typeof valor;
  if (tipo === 'string')  return valor.trim();
  if (tipo === 'number' && isFinite(valor)) return String(valor).trim();
  if (tipo === 'boolean') return String(valor).trim();

  return null; // objetos, arrays, funciones: no se aceptan
}

/**
 * Determina el nombre de grupo a partir de los campos "grupo" y "horario".
 *
 * Solo se aceptan coincidencias EXACTAS contra la configuración. La versión
 * anterior hacía una búsqueda parcial con indexOf que, ante un horario vacío,
 * coincidía con la primera clave del mapeo y registraba al estudiante en un
 * grupo que no había elegido.
 *
 * Se usa hasOwnProperty porque un valor como "constructor" o "toString"
 * encontraría una propiedad heredada del prototipo de Object.
 *
 * @param {string} grupo - Nombre de grupo recibido.
 * @param {string} horario - Rango horario recibido.
 * @returns {string} Nombre de grupo válido, o cadena vacía si no se identifica.
 */
function resolverGrupo_(grupo, horario) {
  var mapa = CONFIG.mapeoHorarios;

  if (grupo && Object.prototype.hasOwnProperty.call(mapa, grupo)) {
    return mapa[grupo];
  }
  if (horario && Object.prototype.hasOwnProperty.call(mapa, horario)) {
    return mapa[horario];
  }

  // El formulario envía el rango ("9:00 AM – 10:30 AM") en el campo horario.
  for (var i = 0; i < CONFIG.horarios.length; i++) {
    if (horario && horario === CONFIG.horarios[i].rango) {
      return CONFIG.horarios[i].nombreGrupo;
    }
  }

  return '';
}

/**
 * Devuelve el rango horario oficial de un grupo, tomado de la configuración.
 *
 * El texto que se escribe en la hoja procede SIEMPRE de aquí y nunca del
 * cliente: así la columna "Horario seleccionado" no puede contener texto
 * arbitrario aunque alguien manipule la solicitud.
 *
 * @param {string} grupoNombre - Nombre del grupo ya validado.
 * @returns {string} Rango horario correspondiente.
 */
function rangoOficialDelGrupo_(grupoNombre) {
  for (var i = 0; i < CONFIG.horarios.length; i++) {
    if (CONFIG.horarios[i].nombreGrupo === grupoNombre) {
      return CONFIG.horarios[i].rango;
    }
  }
  return '';
}

/**
 * Valida y normaliza los datos del formulario antes de insertarlos.
 *
 * Comprueba, para cada campo: tipo, presencia, longitud, formato y
 * pertenencia a la lista de valores permitidos. No da por buena ninguna
 * validación hecha en el navegador.
 *
 * Campos que el servidor decide por su cuenta e ignora del cliente:
 *   • nivel de la hoja y del correo → CONFIG.nivelFijo
 *   • horario escrito en la hoja → rango oficial del grupo
 *   • inicio de clases del correo → CONFIG.marca.inicioClasesPorDefecto
 *
 * @param {Object} data - Datos crudos del formulario.
 * @returns {Object} Datos normalizados y seguros.
 * @throws {Error} Error controlado con código DATOS_INVALIDOS.
 */
function normalizarDatos_(data) {
  var L = CONFIG.limites;

  if (!data || typeof data !== 'object' ||
      Object.prototype.toString.call(data) === '[object Array]') {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'No se recibieron datos válidos en la solicitud.');
  }

  // ── Nombre completo ──
  var nombre = textoDelCampo_(data.nombre);
  if (nombre === null) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El nombre recibido no tiene un formato válido.');
  }
  nombre = nombre.replace(/\s+/g, ' ');
  if (nombre.length < L.nombreMin || nombre.length > L.nombreMax) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'El nombre completo debe tener entre ' + L.nombreMin + ' y ' + L.nombreMax + ' caracteres.');
  }
  if (!RE_NOMBRE.test(nombre)) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'El nombre completo solo puede contener letras, espacios, guiones y apóstrofos.');
  }

  // ── WhatsApp ──
  var whatsapp = textoDelCampo_(data.whatsapp);
  if (whatsapp === null || whatsapp.length > L.whatsappMax) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El número de WhatsApp recibido no es válido.');
  }
  whatsapp = whatsapp.replace(/\s+/g, ' ');
  var digitos = whatsapp.replace(/\D/g, '');
  if (!whatsapp || !RE_WHATSAPP.test(whatsapp) ||
      digitos.length < L.whatsappDigitosMin || digitos.length > L.whatsappDigitosMax) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'El número de WhatsApp debe tener entre ' + L.whatsappDigitosMin + ' y ' +
      L.whatsappDigitosMax + ' dígitos.');
  }

  // ── Correo electrónico ──
  // Ahora es obligatorio: sin él no hay confirmación posible y la
  // comprobación de duplicados quedaría desactivada.
  var correoCrudo = (data.correo === undefined || data.correo === null || data.correo === '')
    ? data.email
    : data.correo;
  var correo = textoDelCampo_(correoCrudo);
  if (correo === null) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El correo electrónico recibido no es válido.');
  }
  correo = correo.toLowerCase();
  if (!correo || correo.length > L.correoMax || !RE_CORREO.test(correo)) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El correo electrónico no es válido.');
  }

  // ── Grupo de días (lista blanca) ──
  var dias = textoDelCampo_(data.dias);
  if (dias === null) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El grupo de días recibido no es válido.');
  }
  dias = dias.replace(/\s+/g, ' ');
  var diaNormalizado = dias.toUpperCase();
  if (CONFIG.dias.indexOf(diaNormalizado) === -1) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'El grupo de días seleccionado no es válido. Vuelve al paso anterior y elige un horario de la lista.');
  }

  // ── Horario / grupo (lista blanca) ──
  var horario = textoDelCampo_(data.horario);
  var grupo   = textoDelCampo_(data.grupo);
  if (horario === null || grupo === null) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El horario recibido no es válido.');
  }
  var grupoNombre = resolverGrupo_(grupo.replace(/\s+/g, ' '), horario.replace(/\s+/g, ' '));
  if (!grupoNombre) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'El horario seleccionado no es válido. Vuelve al paso anterior y elige un horario de la lista.');
  }

  // ── Aceptación de términos ──
  // Este endpoint ES la aceptación del contrato: sin ella no hay inscripción.
  if (data.aceptoTerminos !== true && data.aceptoTerminos !== 'true') {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS,
      'Debes aceptar los términos y condiciones para completar tu inscripción.');
  }

  // ── Identificador de envío (idempotencia) ──
  var submissionId = textoDelCampo_(data.submissionId);
  if (submissionId === null) submissionId = '';
  if (submissionId && (submissionId.length > L.submissionIdMax || !RE_SUBMISSION_ID.test(submissionId))) {
    throw errorControlado_(CODIGOS.DATOS_INVALIDOS, 'El identificador de envío recibido no es válido.');
  }

  // ── Token temporal ──
  var token = textoDelCampo_(data.token);
  if (token === null) token = '';

  // ── Nivel ──
  //    El programa tiene un único nivel, así que el nombre lo pone siempre el
  //    servidor y se ignora data.nivel. Antes se aceptaba la etiqueta del
  //    navegador, y un formulario abierto desde antes (o un localStorage
  //    viejo) podía colar un nombre distinto —"Inglés Básico Nuevo"— en el
  //    correo de confirmación.

  return {
    nombre:          nombre,
    whatsapp:        whatsapp,
    whatsappDigitos: digitos,
    correo:          correo,
    diaOriginal:     dias,            // Ya validado contra CONFIG.dias
    diaNormalizado:  diaNormalizado,
    grupoNombre:     grupoNombre,
    horarioOriginal: rangoOficialDelGrupo_(grupoNombre), // Decidido por el servidor
    nivel:           CONFIG.nivelFijo, // Decidido por el servidor
    inicioClases:    CONFIG.marca.inicioClasesPorDefecto, // Decidido por el servidor
    aceptoTerminos:  true,
    submissionId:    submissionId,
    token:           token
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// SECCIÓN 3A: SEGURIDAD — TOKEN TEMPORAL, FRECUENCIA Y SANEADO
// ═══════════════════════════════════════════════════════════════════════════

/** Caché en memoria del secreto durante una misma ejecución. */
var _secretoToken = null;

/**
 * Devuelve la clave secreta con la que se firman los tokens.
 *
 * Vive en ScriptProperties, del lado del servidor: nunca aparece en el
 * frontend ni viaja al navegador. Se genera sola la primera vez.
 *
 * No se usa LockService aquí a propósito: esta función puede ejecutarse antes
 * de la sección crítica y un bloqueo anidado complicaría el flujo. La única
 * carrera posible ocurre en la primerísima solicitud de la vida del script;
 * se resuelve releyendo la propiedad para adoptar el valor que ganó.
 *
 * @returns {string} Secreto HMAC.
 */
function obtenerSecretoToken_() {
  if (_secretoToken) return _secretoToken;

  var propiedades = PropertiesService.getScriptProperties();
  var secreto = propiedades.getProperty(CLAVES.secretoToken);

  if (!secreto) {
    secreto = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    propiedades.setProperty(CLAVES.secretoToken, secreto);
    secreto = propiedades.getProperty(CLAVES.secretoToken) || secreto;
  }

  _secretoToken = secreto;
  return secreto;
}

/**
 * Firma la parte pública de un token.
 *
 * @param {string} cuerpo - Carga útil ya codificada en base64 web-safe.
 * @returns {string} Firma HMAC-SHA256 en base64 web-safe.
 */
function firmarToken_(cuerpo) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(cuerpo, obtenerSecretoToken_())
  );
}

/**
 * Emite un token temporal.
 *
 * Formato: base64({ n: nonce, t: milisegundos }) + "." + firma
 *
 * Es autocontenido: no hay que guardar nada al emitirlo, así que emitir
 * tokens no consume almacenamiento aunque se pidan miles. Solo se guarda una
 * marca cuando el token se CONSUME, para impedir que se reutilice.
 *
 * @returns {string} Token listo para el frontend.
 */
function emitirToken_() {
  var cuerpo = Utilities.base64EncodeWebSafe(JSON.stringify({
    n: Utilities.getUuid(),
    t: new Date().getTime()
  }));

  return cuerpo + '.' + firmarToken_(cuerpo);
}

/**
 * Comprueba un token: firma, antigüedad y que no se haya usado antes.
 *
 * @param {string} token - Token recibido del frontend.
 * @returns {Object} { nonce: string } si es válido.
 * @throws {Error} Error controlado TOKEN_INVALIDO o TOKEN_EXPIRADO.
 */
function verificarToken_(token) {
  var invalido = errorControlado_(CODIGOS.TOKEN_INVALIDO,
    'Tu sesión del formulario ya no es válida. Recarga la página e inténtalo de nuevo.');

  if (!token || typeof token !== 'string' || token.length > CONFIG.limites.tokenMax) {
    throw invalido;
  }

  var partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) throw invalido;

  // Sin el secreto no se puede fabricar una firma válida.
  if (firmarToken_(partes[0]) !== partes[1]) throw invalido;

  var carga;
  try {
    carga = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString());
  } catch (err) {
    registrarError_('verificarToken', err);
    throw invalido;
  }

  var nonce = String(carga && carga.n ? carga.n : '');
  var emitido = Number(carga && carga.t ? carga.t : 0);
  if (!nonce || !emitido) throw invalido;

  var edad = new Date().getTime() - emitido;
  if (edad < -60000 || edad > CONFIG.seguridad.tokenTtlSegundos * 1000) {
    throw errorControlado_(CODIGOS.TOKEN_EXPIRADO,
      'El formulario estuvo abierto demasiado tiempo. Recarga la página e inténtalo de nuevo.');
  }

  // Un solo uso: si ya se consumió, no vale una segunda vez.
  try {
    if (CacheService.getScriptCache().get(CLAVES.token + nonce)) throw invalido;
  } catch (err) {
    if (err === invalido) throw err;
    // Si la caché falla, se acepta el token: la firma y la caducidad ya
    // acotan el riesgo, y la idempotencia impide registros repetidos.
    registrarError_('verificarToken:cache', err);
  }

  return { nonce: nonce };
}

/**
 * Marca un token como usado.
 *
 * Se llama solo cuando la inscripción llega a un desenlace definitivo
 * (registrada o detectada como duplicada). Ante un fallo temporal el token
 * sigue siendo válido, de modo que el reintento automático funciona.
 *
 * @param {string} nonce - Identificador único del token.
 */
function consumirToken_(nonce) {
  if (!nonce) return;
  try {
    CacheService.getScriptCache().put(
      CLAVES.token + nonce, '1', CONFIG.seguridad.tokenTtlSegundos
    );
  } catch (err) {
    registrarError_('consumirToken', err);
  }
}

/**
 * Huella corta y no reversible de un dato personal.
 *
 * Se usa para construir las claves de los contadores de frecuencia sin
 * guardar correos ni teléfonos dentro de CacheService.
 *
 * @param {string} texto - Dato de origen.
 * @returns {string} 16 caracteres hexadecimales.
 */
function huella_(texto) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(texto), Utilities.Charset.UTF_8
  );

  var hex = '';
  for (var i = 0; i < 8; i++) {
    hex += ('0' + (((bytes[i] % 256) + 256) % 256).toString(16)).slice(-2);
  }
  return hex;
}

/**
 * Contador de frecuencia por ventana fija sobre CacheService.
 *
 * Limitación conocida: CacheService no ofrece incremento atómico, así que
 * varias solicitudes simultáneas pueden leer el mismo valor y contarse como
 * una sola. El efecto es deliberadamente benigno:
 *   • una ráfaga legítima (100 personas a la vez) se subcuenta → no se bloquea;
 *   • un abuso secuencial (un script enviando en bucle) se cuenta con
 *     exactitud → sí se bloquea, que es el caso que interesa frenar.
 *
 * @param {string} etiqueta - Identificador del contador.
 * @param {number} maximo - Solicitudes permitidas en la ventana.
 * @param {number} ventanaSegundos - Duración de la ventana.
 * @returns {boolean} true si la solicitud está dentro del límite.
 */
function registrarIntento_(etiqueta, maximo, ventanaSegundos) {
  if (!maximo || maximo <= 0) return true;

  try {
    var cache   = CacheService.getScriptCache();
    var ventana = Math.floor(new Date().getTime() / (ventanaSegundos * 1000));
    var clave   = CLAVES.rate + etiqueta + '_' + ventana;

    var actual = parseInt(cache.get(clave) || '0', 10);
    if (isNaN(actual)) actual = 0;
    actual++;

    cache.put(clave, String(actual), ventanaSegundos * 2);
    return actual <= maximo;

  } catch (err) {
    // Un fallo del limitador nunca debe impedir una inscripción legítima.
    registrarError_('registrarIntento', err);
    return true;
  }
}

/**
 * Aplica los límites de frecuencia a una inscripción.
 *
 * @param {Object} datos - Datos ya normalizados.
 * @throws {Error} Error controlado OCUPADO o DEMASIADAS_SOLICITUDES.
 */
function aplicarControlDeTrafico_(datos) {
  var S = CONFIG.seguridad;

  // 1. Techo global: protege el servicio completo.
  if (!registrarIntento_('glob', S.limiteGlobalIntentos, S.ventanaGlobalSegundos)) {
    throw errorControlado_(CODIGOS.OCUPADO,
      'El sistema está recibiendo un número inusual de solicitudes. Inténtalo de nuevo en un minuto.');
  }

  // 2. Por correo: impide que una misma persona inunde el formulario.
  if (!registrarIntento_('c' + huella_(datos.correo), S.limitePorCorreo, S.ventanaPorCorreoSegundos)) {
    throw errorControlado_(CODIGOS.DEMASIADAS_SOLICITUDES,
      'Hemos recibido varias solicitudes seguidas con este correo. ' +
      'Espera unos minutos antes de volver a intentarlo o escríbenos por WhatsApp.');
  }

  // 3. Por WhatsApp: cubre el caso de cambiar el correo en cada envío.
  if (datos.whatsappDigitos &&
      !registrarIntento_('w' + huella_(datos.whatsappDigitos), S.limitePorWhatsapp, S.ventanaPorWhatsappSegundos)) {
    throw errorControlado_(CODIGOS.DEMASIADAS_SOLICITUDES,
      'Hemos recibido varias solicitudes seguidas con este número de WhatsApp. ' +
      'Espera unos minutos antes de volver a intentarlo o escríbenos por WhatsApp.');
  }
}

/**
 * Prepara un texto para escribirlo en una celda de Google Sheets.
 *
 * Dos protecciones:
 *   1. Retira caracteres de control y saltos de línea.
 *   2. Antepone un apóstrofo cuando el texto empieza por =, +, - o @, que
 *      son los caracteres que hacen que Sheets interprete la celda como
 *      fórmula. Esto corrige además un problema real ya existente: los
 *      números escritos como "+1 809-555-5555" se evaluaban como operación.
 *
 * @param {string} valor - Texto de origen.
 * @param {number} maxLongitud - Recorte máximo.
 * @returns {string} Texto seguro para la hoja.
 */
function sanitizarCelda_(valor, maxLongitud) {
  var texto = String(valor === null || valor === undefined ? '' : valor)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (maxLongitud && texto.length > maxLongitud) {
    texto = texto.substring(0, maxLongitud);
  }

  if (/^[=+\-@]/.test(texto)) {
    texto = "'" + texto;
  }

  return texto;
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
 * Interpreta el contenido completo de la hoja en UNA sola pasada.
 *
 * Ésta es la pieza central de la mejora de concurrencia. Antes, registrar un
 * estudiante requería tres lecturas separadas de Google Sheets, todas dentro
 * del bloqueo:
 *   • encontrarSeccion_       → columna A completa
 *   • inspeccionarSeccion_    → rango de la sección
 *   • encontrarFilaInsercion_ → rango de la sección otra vez
 *
 * Cada llamada a SpreadsheetApp es un viaje de ida y vuelta a los servidores
 * de Google. Al reducirlas a una, la sección crítica pasa de segundos a
 * décimas de segundo, que es lo que permite que la cola de 100 solicitudes
 * avance en lugar de agotar la espera del bloqueo.
 *
 * De cada bloque (día + horario) se obtiene:
 *   • filaCabecera / filaInicio / filaProximoEncabezado → dónde empieza y acaba
 *   • primeraLibre  → primera fila vacía disponible
 *   • inscritos     → cuántos estudiantes hay (control de cupos)
 *   • correos y whatsapps → deduplicación
 *
 * @param {Array<Array>} valores - Matriz de valores leída de la hoja.
 * @param {boolean} conDatos - true si la matriz incluye las columnas de datos.
 * @returns {Object} { secciones: Object, orden: Array<string> }
 */
function analizarHoja_(valores, conDatos) {
  var secciones = {};
  var orden     = [];

  var diaActual   = '';
  var grupoActual = '';
  var actual      = null;

  /** Cierra la sección en curso fijando dónde termina su bloque de filas. */
  function cerrarSeccion(filaLimite) {
    if (actual) {
      actual.filaProximoEncabezado = filaLimite;
      actual = null;
    }
  }

  for (var i = 0; i < valores.length; i++) {
    var fila  = i + 1; // Las filas de Sheets empiezan en 1
    var bruto = valores[i][0];
    var celda = String(bruto === null || bruto === undefined ? '' : bruto).trim();

    // ── Fila vacía: candidata a recibir el próximo estudiante ──
    if (!celda) {
      if (actual && !actual.primeraLibre) actual.primeraLibre = fila;
      continue;
    }

    var tipo = esFilaEncabezado_(celda);

    // ── Encabezado de día ──
    if (tipo.esDia) {
      cerrarSeccion(fila);
      diaActual   = celda.toUpperCase();
      grupoActual = '';
      continue;
    }

    // ── Encabezado de horario ──
    if (tipo.esHorario) {
      cerrarSeccion(fila);
      grupoActual = celda;
      continue;
    }

    // ── Cabecera de columnas: a partir de aquí empiezan los estudiantes ──
    if (celda === CONFIG.columnas[0]) {
      cerrarSeccion(fila);

      if (diaActual && grupoActual) {
        var clave = claveGrupo_(diaActual, grupoActual);
        actual = {
          clave:                 clave,
          dia:                   diaActual,
          grupo:                 grupoActual,
          filaCabecera:          fila,
          filaInicio:            fila + 1,
          filaProximoEncabezado: 0,
          primeraLibre:          0,
          inscritos:             0,
          correos:               [],
          whatsapps:             []
        };
        secciones[clave] = actual;
        orden.push(clave);
      }
      continue;
    }

    // ── Fila de estudiante ──
    // La fila del rango horario ("9:00 AM – 10:30 AM") no llega hasta aquí:
    // aparece antes de la cabecera de columnas, cuando "actual" aún es null.
    if (actual) {
      actual.inscritos++;

      if (conDatos) {
        var correo = String(valores[i][4] === null || valores[i][4] === undefined ? '' : valores[i][4])
          .trim().toLowerCase();
        if (correo) actual.correos.push(correo);

        var whats = soloDigitos_(valores[i][3]);
        if (whats) actual.whatsapps.push(whats);
      }
    }
  }

  cerrarSeccion(valores.length + 1);

  return { secciones: secciones, orden: orden };
}

/**
 * Lee la hoja y devuelve su análisis completo.
 *
 * Se lee hasta getMaxRows() y NO con getDataRange(). Es deliberado:
 * getDataRange() recorta la hoja en la última fila que contiene algo, de modo
 * que el último bloque parecería no tener ni una fila libre. El efecto
 * medido era que cada inscripción en el último grupo obligaba a insertar
 * filas —la operación más costosa— dentro del bloqueo.
 *
 * Son dos llamadas a la API (getMaxRows + getValues), las mismas que
 * requiere getDataRange, y el volumen extra son unas decenas de filas vacías.
 *
 * @param {Sheet} sheet - La hoja de Google Sheets.
 * @param {boolean} conDatos - true para incluir correos y teléfonos.
 * @returns {Object} Resultado de analizarHoja_.
 */
function leerSnapshot_(sheet, conDatos) {
  var totalFilas = sheet.getMaxRows();

  // La disponibilidad solo necesita la columna A para contar inscritos; pedir
  // las siete columnas transferiría siete veces más datos sin usarlos. El
  // camino de registro sí las necesita todas, para deduplicar por correo.
  var columnas = conDatos ? CONFIG.columnas.length : 1;

  var valores = sheet.getRange(1, 1, totalFilas, columnas).getValues();

  var analisis = analizarHoja_(valores, Boolean(conDatos));

  // Se conserva para que garantizarEspacioBuffer_ no tenga que volver a
  // preguntar por el tamaño de la hoja: una llamada menos dentro del bloqueo.
  analisis.totalFilas = totalFilas;

  return analisis;
}

/**
 * Determina la fila exacta donde debe escribirse el nuevo estudiante.
 *
 * Reproduce el criterio anterior (primera fila vacía del bloque; si no hay
 * ninguna, justo donde termina el bloque) pero sin volver a leer la hoja:
 * toda la información ya está en el análisis.
 *
 * @param {Object} seccion - Sección obtenida de analizarHoja_.
 * @returns {number} Número de fila (1-indexed).
 */
function filaDeInsercion_(seccion) {
  if (seccion.primeraLibre &&
      seccion.primeraLibre >= seccion.filaInicio &&
      seccion.primeraLibre < seccion.filaProximoEncabezado) {
    return seccion.primeraLibre;
  }

  return seccion.filaProximoEncabezado;
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
function garantizarEspacioBuffer_(sheet, filaInsercion, filaProximoEncabezado, totalFilas) {
  // Calcular cuántas filas vacías quedan entre la inserción y el siguiente encabezado
  // Necesitamos: la fila de inserción + (buffer mínimo) < filaProximoEncabezado
  var espacioNecesario = CONFIG.filasSeparacion + 1; // +1 por la fila del propio estudiante
  var espacioDisponible = filaProximoEncabezado - filaInsercion;

  // El tamaño de la hoja llega ya calculado desde leerSnapshot_; solo se
  // consulta a la API si quien llama no lo aporta.
  var filasDeLaHoja = totalFilas || sheet.getMaxRows();

  if (espacioDisponible < espacioNecesario && filaProximoEncabezado <= filasDeLaHoja) {
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
    // (clear() borra contenido y formato en una sola llamada a la API)
    rangoNuevasFilas.clear();

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
 * Construye la lista de disponibilidad a partir de un análisis de la hoja.
 *
 * @param {Object} snapshot - Resultado de leerSnapshot_.
 * @returns {Array<Object>} Lista con dias, grupo, rango, inscritos,
 *                          disponibles, limite y lleno.
 */
function construirDisponibilidad_(snapshot) {
  var resultado = [];

  for (var d = 0; d < CONFIG.dias.length; d++) {
    for (var h = 0; h < CONFIG.horarios.length; h++) {
      var dia     = CONFIG.dias[d];
      var horario = CONFIG.horarios[h];

      var seccion   = snapshot.secciones[claveGrupo_(dia, horario.nombreGrupo)];
      var inscritos = seccion ? seccion.inscritos : 0;
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
 * Devuelve el estado de cupos de los 8 grupos (2 días × 4 horarios).
 *
 * La respuesta se sirve desde CacheService durante unos segundos. Motivo:
 * esta consulta la lanza CADA visitante al abrir el formulario, y sin caché
 * cien visitantes provocaban cien lecturas completas de la hoja y consumían
 * cien ejecuciones del script antes siquiera de inscribirse.
 *
 * La caché se invalida en cuanto se registra a alguien, así que el desfase
 * máximo es de CONFIG.cache.disponibilidadSegundos. El recuento definitivo
 * se hace igualmente dentro del bloqueo al inscribir, de modo que un dato
 * ligeramente antiguo nunca puede provocar un sobrecupo.
 *
 * @returns {Array<Object>} Estado de cupos de los 8 grupos.
 */
function obtenerDisponibilidad_() {
  var cache = null;

  try {
    cache = CacheService.getScriptCache();
    var guardado = cache.get(CLAVES.disponibilidad);
    if (guardado) return JSON.parse(guardado);
  } catch (err) {
    registrarError_('obtenerDisponibilidad:cache', err);
  }

  var resultado = construirDisponibilidad_(leerSnapshot_(obtenerHoja_(), false));

  if (cache) {
    try {
      cache.put(CLAVES.disponibilidad, JSON.stringify(resultado), CONFIG.cache.disponibilidadSegundos);
    } catch (err) {
      registrarError_('obtenerDisponibilidad:guardar', err);
    }
  }

  return resultado;
}

/** Descarta la disponibilidad cacheada tras registrar a un estudiante. */
function invalidarDisponibilidad_() {
  try {
    CacheService.getScriptCache().remove(CLAVES.disponibilidad);
  } catch (err) {
    registrarError_('invalidarDisponibilidad', err);
  }
}

/**
 * Busca si el estudiante ya está inscrito.
 *
 * Con CONFIG.duplicados.alcance = 'global' se revisan los ocho grupos: así
 * una misma persona no puede ocupar varios cupos. Con 'grupo' se conserva el
 * comportamiento anterior, que solo miraba dentro del grupo elegido.
 *
 * Se ejecuta DENTRO del bloqueo y sobre el mismo análisis que decide el
 * cupo, por lo que dos solicitudes simultáneas de la misma persona no pueden
 * pasar ambas la comprobación.
 *
 * @param {Object} snapshot - Análisis de la hoja.
 * @param {Object} seccion - Sección elegida por el estudiante.
 * @param {Object} datos - Datos normalizados.
 * @returns {Object|null} { campo, dias, grupo } si hay duplicado.
 */
function buscarDuplicado_(snapshot, seccion, datos) {
  var claves = (CONFIG.duplicados.alcance === 'global')
    ? snapshot.orden
    : [seccion.clave];

  for (var i = 0; i < claves.length; i++) {
    var s = snapshot.secciones[claves[i]];
    if (!s) continue;

    if (datos.correo && s.correos.indexOf(datos.correo) !== -1) {
      return { campo: 'correo', dias: s.dia, grupo: s.grupo };
    }

    if (CONFIG.duplicados.porWhatsapp && datos.whatsappDigitos &&
        s.whatsapps.indexOf(datos.whatsappDigitos) !== -1) {
      return { campo: 'whatsapp', dias: s.dia, grupo: s.grupo };
    }
  }

  return null;
}

/**
 * Obtiene el documento de Google Sheets con el que trabaja el script.
 *
 * Admite las dos formas de crear el proyecto:
 *
 *   1. VINCULADO (recomendado): el proyecto se abre desde la propia hoja con
 *      Extensiones › Apps Script. getActiveSpreadsheet() devuelve el documento.
 *
 *   2. INDEPENDIENTE: el proyecto se crea suelto en script.google.com. En ese
 *      caso getActiveSpreadsheet() devuelve null y TODO falla con un error
 *      confuso. Para ese escenario basta con guardar el ID del documento en
 *      las propiedades del script:
 *
 *        PropertiesService.getScriptProperties()
 *          .setProperty('LINGOLA_SPREADSHEET_ID', '<id de la hoja>');
 *
 *      El ID es el tramo largo de la URL, entre /d/ y /edit.
 *
 * @returns {Spreadsheet} Documento de trabajo.
 */
function obtenerLibro_() {
  var id = PropertiesService.getScriptProperties().getProperty('LINGOLA_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  var activo = SpreadsheetApp.getActiveSpreadsheet();
  if (activo) return activo;

  throw errorControlado_(CODIGOS.ERROR,
    'El servicio de inscripciones no está disponible en este momento. ' +
    'Escríbenos por WhatsApp y completamos tu inscripción.');
}

/**
 * Obtiene la hoja de inscripciones o lanza un error descriptivo.
 *
 * @returns {Sheet} La hoja de trabajo.
 */
function obtenerHoja_() {
  var sheet = obtenerLibro_().getSheetByName(CONFIG.hojaNombre);

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
  var claveEnvio = datos.submissionId ? (CONFIG.prefijoEnvio + datos.submissionId) : '';

  // ── Fuera del bloqueo: obtener la referencia a la hoja ──
  // Son dos llamadas a la API (getActiveSpreadsheet + getSheetByName) que no
  // leen ni escriben datos: solo consiguen un identificador. Dentro del
  // bloqueo se sumarían a la cola de todos los demás; aquí se resuelven en
  // paralelo. Con ~7,5 llamadas por inscripción, sacar estas dos recorta
  // más de un 25% del tiempo que cada solicitud retiene el bloqueo.
  var sheet = obtenerHoja_();

  return conBloqueo_(function () {

    // ── Paso 0: ¿Este mismo envío ya se procesó? (doble clic, reintento) ──
    // Se repite dentro del bloqueo aunque ya se haya mirado fuera: es aquí
    // donde la comprobación queda a salvo de solicitudes simultáneas.
    var previo = respuestaIdempotente_(claveEnvio);
    if (previo) return previo;

    // ── Paso 1: UNA sola lectura de la hoja ──
    var snapshot = leerSnapshot_(sheet, true);
    var seccion  = snapshot.secciones[claveGrupo_(datos.diaNormalizado, datos.grupoNombre)];

    if (!seccion) {
      // La hoja no tiene el bloque esperado: es un problema de configuración,
      // no del estudiante. El detalle queda en el log, no en la respuesta.
      registrarError_('registrarEstudiante', new Error(
        'No existe la sección ' + datos.diaNormalizado + ' / ' + datos.grupoNombre +
        ' en la hoja "' + CONFIG.hojaNombre + '". ¿Se ejecutó setup()?'
      ));
      throw errorControlado_(CODIGOS.ERROR,
        'El horario seleccionado no está disponible en este momento. ' +
        'Escríbenos por WhatsApp y completamos tu inscripción.');
    }

    // ── Paso 2: Duplicados ──
    var duplicado = buscarDuplicado_(snapshot, seccion, datos);
    if (duplicado) {
      return {
        fila:        0,
        inscritos:   seccion.inscritos,
        disponibles: Math.max(0, CONFIG.limiteCupos - seccion.inscritos),
        limite:      CONFIG.limiteCupos,
        duplicado:   true,
        grupoPrevio: duplicado.dias + ' — ' + duplicado.grupo
      };
    }

    // ── Paso 3: Validación definitiva del límite de cupos ──
    if (seccion.inscritos >= CONFIG.limiteCupos) {
      throw errorControlado_(CODIGOS.CUPO_LLENO,
        'El grupo de ' + datos.diaOriginal + ' (' + datos.horarioOriginal +
        ') ya alcanzó el máximo de ' + CONFIG.limiteCupos +
        ' estudiantes. Por favor, selecciona otro horario disponible.');
    }

    // ── Paso 4: Fila de inserción (ya calculada, sin releer) ──
    var filaInsercion = filaDeInsercion_(seccion);

    // ── Paso 5: Garantizar buffer de separación ──
    // Tras ejecutar ampliarBloquesParaCupos() los bloques tienen sitio para
    // los 15 cupos, así que esta rama —la más costosa— no llega a activarse
    // en el funcionamiento normal.
    garantizarEspacioBuffer_(sheet, filaInsercion, seccion.filaProximoEncabezado,
                             snapshot.totalFilas);

    // ── Paso 6: Construir el registro ──
    // Todos los textos pasan por sanitizarCelda_ para que Google Sheets no
    // interprete como fórmula lo que escribió el estudiante.
    // Se lee el reloj UNA sola vez, en la zona horaria oficial del sistema
    // (CONFIG.zonaHoraria). Este mismo texto es el que se escribe en la hoja y
    // el que después usa el correo de confirmación: nunca se vuelve a generar.
    var fechaActual = fechaHoraLocal_();

    var L = CONFIG.limites;
    var registro = [
      fechaActual,
      CONFIG.nivelFijo,
      sanitizarCelda_(datos.nombre,          L.nombreMax),
      sanitizarCelda_(datos.whatsapp,        L.whatsappMax),
      sanitizarCelda_(datos.correo,          L.correoMax),
      sanitizarCelda_(datos.diaOriginal,     40),
      sanitizarCelda_(datos.horarioOriginal, 40)
    ];

    // ── Paso 7: Escribir los datos ──
    sheet.getRange(filaInsercion, 1, 1, CONFIG.columnas.length).setValues([registro]);

    // ── Paso 8: Formato limpio (nunca hereda de encabezados) ──
    aplicarFormatoEstudiante_(
      sheet, filaInsercion, seccion.filaInicio, CONFIG.columnas.length
    );

    // ── Paso 9: Confirmar la escritura antes de soltar el bloqueo ──
    // Imprescindible: sin flush(), la siguiente solicitud podría leer la
    // hoja sin ver esta fila y reutilizar el mismo cupo.
    SpreadsheetApp.flush();

    var resultado = {
      fila:        filaInsercion,
      fecha:       fechaActual,
      inscritos:   seccion.inscritos + 1,
      disponibles: Math.max(0, CONFIG.limiteCupos - (seccion.inscritos + 1)),
      limite:      CONFIG.limiteCupos,
      duplicado:   false
    };

    // ── Paso 10: Marcar el envío y refrescar la disponibilidad publicada ──
    guardarIdempotencia_(claveEnvio, resultado);
    invalidarDisponibilidad_();

    return resultado;
  });
}

/**
 * Ejecuta una operación dentro del bloqueo de script.
 *
 * Diferencias con la versión anterior:
 *   • tryLock() devuelve un booleano en lugar de lanzar una excepción con el
 *     texto interno "Lock timeout: another process…", que acababa mostrándose
 *     al estudiante.
 *   • Se recuerda si el bloqueo llegó a obtenerse: antes se liberaba en el
 *     finally aunque nunca se hubiera adquirido.
 *   • Al agotarse la espera se responde OCUPADO, un código que el frontend
 *     reconoce para reintentar solo, sin que el estudiante haga nada.
 *
 * @param {Function} operacion - Trabajo a realizar en exclusiva.
 * @returns {*} Lo que devuelva la operación.
 * @throws {Error} Error controlado OCUPADO si no se obtiene el bloqueo.
 */
function conBloqueo_(operacion) {
  var lock = LockService.getScriptLock();
  var adquirido = false;

  try {
    adquirido = lock.tryLock(CONFIG.seguridad.esperaLockMs);

    if (!adquirido) {
      throw errorControlado_(CODIGOS.OCUPADO,
        'Estamos recibiendo muchas inscripciones a la vez. ' +
        'Espera unos segundos: lo intentaremos de nuevo automáticamente.');
    }

    return operacion();

  } finally {
    if (adquirido) lock.releaseLock();
  }
}

/**
 * Devuelve el resultado guardado de un envío ya procesado, si existe.
 *
 * La idempotencia vive en CacheService y no en ScriptProperties. Motivo: las
 * propiedades del script no caducan y su almacén está limitado a 500 KB, de
 * modo que la versión anterior se habría llenado tras unos miles de envíos y
 * habría empezado a fallar al escribir. La caché caduca sola.
 *
 * La protección duradera contra registros repetidos no es ésta, sino la
 * comprobación de correos sobre la propia hoja: aunque la caché se vacíe, un
 * reenvío se detecta igualmente como duplicado.
 *
 * @param {string} claveEnvio - Clave del envío, o cadena vacía.
 * @returns {Object|null} Resultado previo marcado como duplicado.
 */
function respuestaIdempotente_(claveEnvio) {
  if (!claveEnvio) return null;

  try {
    var guardado = CacheService.getScriptCache().get(claveEnvio);
    if (!guardado) return null;

    var previo = JSON.parse(guardado);
    previo.duplicado = true;
    return previo;

  } catch (err) {
    registrarError_('respuestaIdempotente', err);
    return null;
  }
}

/**
 * Guarda el resultado de un envío para reconocerlo si se repite.
 *
 * @param {string} claveEnvio - Clave del envío, o cadena vacía.
 * @param {Object} resultado - Resultado a recordar.
 */
function guardarIdempotencia_(claveEnvio, resultado) {
  if (!claveEnvio) return;

  try {
    CacheService.getScriptCache().put(
      claveEnvio, JSON.stringify(resultado), CONFIG.cache.idempotenciaSegundos
    );
  } catch (err) {
    registrarError_('guardarIdempotencia', err);
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
function procesarInscripcion_(data, opciones) {
  var config = opciones || {};

  // ── 1. Validación del request ──
  // Antes que nada, porque es gratis y descarta la mayoría de las
  // solicitudes manipuladas sin tocar la hoja ni la caché.
  var datos = normalizarDatos_(data);

  // ── 2. Reenvío idéntico: se responde sin gastar nada más ──
  // Se comprueba antes del rate limiting para que los reintentos legítimos
  // (mismo submissionId) no consuman el cupo de solicitudes del estudiante.
  var claveEnvio = datos.submissionId ? (CONFIG.prefijoEnvio + datos.submissionId) : '';
  var yaProcesado = respuestaIdempotente_(claveEnvio);
  if (yaProcesado) {
    return construirRespuestaDeExito_(yaProcesado, { estudiante: false, administrador: false });
  }

  // ── 3. Validación del token ──
  var token = null;
  if (CONFIG.seguridad.tokenRequerido && !config.omitirToken) {
    token = verificarToken_(datos.token);
  }

  // ── 4. Protección anti-spam / rate limiting ──
  if (!config.omitirLimites) {
    aplicarControlDeTrafico_(datos);
  }

  // ── 5-8. Duplicados, cupos, bloqueo y escritura segura ──
  var registro = registrarEstudiante_(datos);

  // ── 9. El token se consume solo al llegar a un desenlace definitivo ──
  // Ante un OCUPADO o un fallo temporal no se llega aquí, así que el token
  // sigue valiendo y el reintento automático funciona.
  if (token) consumirToken_(token.nonce);

  // ── 10. Correos: fuera del bloqueo y sin poder tumbar la inscripción ──
  var correos = { estudiante: false, administrador: false };
  if (!registro.duplicado) {
    try {
      correos = enviarCorreosDeInscripcion_(datos, registro);
    } catch (err) {
      // La inscripción ya está guardada: un fallo de correo no la invalida.
      registrarError_('procesarInscripcion:correos', err);
    }
  }

  // ── 11. Respuesta controlada ──
  return construirRespuestaDeExito_(registro, correos);
}

/**
 * Da forma a la respuesta de éxito que espera el frontend.
 *
 * El contrato se mantiene idéntico al de la versión 3.0 (status, message,
 * fila, duplicado, inscritos, disponibles, limite, correos) para no romper
 * las páginas ya publicadas.
 *
 * @param {Object} registro - Resultado de registrarEstudiante_.
 * @param {Object} correos - Estado del envío de correos.
 * @returns {Object} Respuesta para el frontend.
 */
function construirRespuestaDeExito_(registro, correos) {
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
    correos:     correos || { estudiante: false, administrador: false }
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
 * Logotipo de Lingola English Teaching que encabeza los correos.
 *
 * Va incrustado como imagen adjunta en línea (cid:) y no como URL externa
 * por dos motivos: no depende de que ningún servidor siga en pie, y Outlook
 * de escritorio bloquea las imágenes remotas por omisión pero sí muestra las
 * adjuntas. El círculo blanco con aro dorado viene dibujado dentro del propio
 * PNG porque Outlook ignora border-radius: así el distintivo es redondo en
 * todos los clientes. Fuente: assets/logo-lingola-email.png (96x96, con
 * transparencia fuera del círculo).
 */
var LOGO_CORREO_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAADAFBMVEVMaXHttAHqswjqswn/sQDqswfqswfpswjqswbqswjqswbpswfqsgfq' +
  'sgbrswfosgfqsgjnswzqsgfqsgfqsgfpswjqswfpswfpswfpsgjqsgfqswf////qswj9/v7+///9/vv///77/Pz///z8/Pn+++/89NUePmv1' +
  '9/ciRXD+/PPut0IqZpL89+T013vxzFgZMFv33pUVK1P//vnuuUYsbZn9+errtQ0kWocgS3XloTb89d32/Pzl6ewzfqb57sgkO2QuQWWkrLcO' +
  'JlBygZgZOWRueIvrtxT124g8R2IwdqDuwTMlVH/v3aftvSZ3f5GcpLFCa4k9irRMYXzGzNTo8/Y4QVgeUH7q7vAsO1vyvkrsuRsrYIvY3OEe' +
  'NWHuwzntrjz39Nvf4+c3Q1/446RpcoJGV3i3ws3z5sLu+frinDIySGzu8vM3gawKH0jg7vORo7PutDs4UXJ5hpwrN0/jvGjpqjZCUHA9YH/j' +
  'uVUSLVrx4bGKlaNcan6utcD68MxKWHLqsUDN1NrOo1dWY3fBx81BTWbS2t7blzCeqbZYbYdJVGokNVndrEsrT3WHjpzaq1d6mq4sWYPUmT3j' +
  'qj/YpEn667fn0Jn18NVWVVKus7k0a5TbnTxqfJNppL65vsRVhJX567xpip6Omqtykae3fH2+hIa5ztdfd5Hlt0k2OVhLgaHuyW2tnWnqu1Hv' +
  '1I2XnqkDFT/nv1vKrmZ6jqKpv8tnbXY7dpTcoDHhyIh9h5SqcHF2V2nFmlFeV3MvKUjJk5SkICXwuz1mioeUl3S/2eDszH65mFiNeE6vjlH1' +
  '5sygg0hCianatVmcfo7UsGe1bW/Z6vB7i3eZvMt9k4Xo5dJkM0lbe3wiLDu/kZFbi6eRq7rduXGItMajV1uThV1bPlaGBAqlt8Nxb1/OxLuE' +
  'qrr1wlOULjU1W3vQq61YYG/R5eq4sXvPuYJxY0ZMKERYmbashZKfOT5MSkm1spyMXWZ8cYR6fm+u0NvVv62CO0nQoKCvlZyeonvtui2toann' +
  'Qx/GAAAAHHRSTlMADlo1A+3S/Uv4yo7DYmUg3RSmQKqchKmB2t/l9mjjkwAAAAlwSFlzAAALEwAACxMBAJqcGAAADnNJREFUaN7NWgdU09ca' +
  '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';

/** Blob del logotipo, creado una sola vez por ejecución. */
var _logoCorreoBlob = null;
function logoCorreoBlob_() {
  if (!_logoCorreoBlob) {
    _logoCorreoBlob = Utilities.newBlob(
      Utilities.base64Decode(LOGO_CORREO_BASE64),
      'image/png',
      'logo-lingola.png'
    );
  }
  return _logoCorreoBlob;
}

/** Imágenes en línea que acompañan a cualquiera de las dos plantillas. */
function imagenesDelCorreo_() {
  return { logoLingola: logoCorreoBlob_() };
}

/**
 * Comprueba si queda cuota diaria de correo antes de intentar enviar.
 *
 * El valor se guarda unos segundos en caché porque consultarlo también es
 * una llamada a la API: con cien inscripciones seguidas, preguntarlo cada
 * vez añadiría cien viajes innecesarios.
 *
 * @param {number} necesarios - Correos que se pretenden enviar.
 * @returns {boolean} true si hay margen suficiente.
 */
function hayCuotaDeCorreo_(necesarios) {
  try {
    var cache = CacheService.getScriptCache();
    var guardado = cache.get('cuota_correo');

    var restantes;
    if (guardado !== null && guardado !== undefined && guardado !== '') {
      restantes = parseInt(guardado, 10);
    } else {
      restantes = MailApp.getRemainingDailyQuota();
      cache.put('cuota_correo', String(restantes), 60);
    }

    if (isNaN(restantes)) return true;
    return restantes >= necesarios;

  } catch (err) {
    // Si no se puede consultar, se intenta enviar igualmente: el propio
    // sendEmail está protegido con su try/catch.
    registrarError_('hayCuotaDeCorreo', err);
    return true;
  }
}

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

  // Se reserva exactamente la cuota que se va a gastar. Con el aviso al
  // administrador desactivado es 1 correo por inscripción en lugar de 2, lo
  // que duplica cuántas inscripciones caben en la cuota diaria de la cuenta
  // (100/día en Gmail personal, 1500/día en Google Workspace).
  var correosPrevistos = (CONFIG.correos.confirmarEstudiante ? 1 : 0) +
                         (CONFIG.correos.notificarAdministrador && ADMIN_EMAIL ? 1 : 0);

  if (correosPrevistos === 0) return resultado;

  // Si no queda margen, la inscripción sigue siendo válida: solo se anota el
  // aviso en el registro para que el administrador lo vea.
  if (!hayCuotaDeCorreo_(correosPrevistos)) {
    registrarError_('enviarCorreos', new Error(
      'Cuota diaria de correo agotada: la inscripción se guardó pero no se notificó.'
    ));
    return resultado;
  }

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

    // La fecha del correo es EXACTAMENTE la que se guardó en la hoja: llega en
    // registro.fecha desde registrarEstudiante_. Aquí no se lee el reloj ni se
    // convierte nada, porque cualquier segunda lectura mostraría una hora
    // distinta de la registrada. Esta función solo se invoca para inscripciones
    // nuevas (procesarInscripcion_ la salta si registro.duplicado es true), y en
    // ese camino registro.fecha siempre viene informada.
    fecha:        registro.fecha,
    inscritos:    registro.inscritos,
    disponibles:  registro.disponibles,
    limite:       registro.limite || CONFIG.limiteCupos,
    fila:         registro.fila
  };

  // ── Correo 1: confirmación al estudiante ──
  if (CONFIG.correos.confirmarEstudiante &&
      info.correo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.correo)) {
    try {
      MailApp.sendEmail({
        to:       info.correo,
        subject:  'Confirmación de inscripción - ' + CONFIG.marca.nombre,
        htmlBody: construirCorreoEstudiante_(info),
        body:     construirCorreoEstudianteTextoPlano_(info),
        name:     CONFIG.marca.nombre,
        replyTo:  ADMIN_EMAIL,
        inlineImages: imagenesDelCorreo_()
      });
      resultado.estudiante = true;
    } catch (err) {
      registrarError_('correoEstudiante', err);
    }
  }

  // ── Correo 2: notificación al administrador ──
  // Desactivado por defecto (CONFIG.correos.notificarAdministrador) para no
  // gastar dos correos de cuota por cada inscripción. La plantilla y toda su
  // lógica se conservan intactas: basta con volver a poner el interruptor en
  // true para recuperar el aviso.
  if (CONFIG.correos.notificarAdministrador && ADMIN_EMAIL) {
    try {
      MailApp.sendEmail({
        to:       ADMIN_EMAIL,
        subject:  'Nueva inscripción recibida - ' + CONFIG.marca.nombre,
        htmlBody: construirCorreoAdministrador_(info),
        body:     construirCorreoAdminTextoPlano_(info),
        name:     CONFIG.marca.nombre,
        replyTo:  info.correo || ADMIN_EMAIL,
        inlineImages: imagenesDelCorreo_()
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
  // El círculo y el aro dorado están dibujados dentro del PNG (Outlook no
  // entiende border-radius). Si el cliente bloquea imágenes, queda el texto
  // alternativo, en blanco para que se lea sobre el azul del encabezado.
  '<td align="center" valign="middle" width="54" height="54" style="width:54px;height:54px;line-height:0;font-size:0;">' +
  '<img src="cid:logoLingola" width="54" height="54" alt="' + escaparHtml_(CONFIG.marca.nombre) + '" ' +
  'style="display:block;width:54px;height:54px;border:0;outline:none;text-decoration:none;color:' + E.blanco + ';font-family:Arial,Helvetica,sans-serif;font-size:12px;" /></td>' +
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
  var ss = obtenerLibro_();
  var sheet = ss.getSheetByName(CONFIG.hojaNombre);

  // Se genera ya el secreto de firma de tokens, para que no tenga que
  // crearse durante la primera inscripción real.
  obtenerSecretoToken_();

  // Crear la hoja si no existe, o limpiarla si ya existe
  // Número de filas que se reservan bajo cada grupo: las 15 plazas del cupo
  // más el buffer de separación. Reservarlas de antemano evita que haya que
  // insertar filas durante una inscripción, que es la operación más lenta y
  // la única que desplaza el resto de la hoja.
  var filasPorBloque = CONFIG.limiteCupos + CONFIG.filasSeparacion;

  // Altura total necesaria: por día, un encabezado + 4 grupos de
  // (2 filas de horario + 1 cabecera + filasPorBloque) + 2 de separación.
  var filasNecesarias = CONFIG.dias.length *
    (1 + CONFIG.horarios.length * (3 + filasPorBloque) + 2) + 20;

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.hojaNombre);
  } else {
    sheet.clear();
    sheet.clearFormats();
  }

  // Ajustar la hoja al alto necesario
  var filasActuales = sheet.getMaxRows();
  if (filasActuales > filasNecesarias) {
    sheet.deleteRows(filasNecesarias + 1, filasActuales - filasNecesarias);
  } else if (filasActuales < filasNecesarias) {
    sheet.insertRowsAfter(filasActuales, filasNecesarias - filasActuales);
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

      // ═══ ESPACIO RESERVADO PARA LOS CUPOS + BUFFER DE SEPARACIÓN ═══
      filaActual += filasPorBloque;
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

  // ── Preparar el lado de seguridad ──
  // Se genera aquí el secreto de firma de tokens para que no tenga que
  // crearse durante la primera inscripción real.
  obtenerSecretoToken_();
  invalidarDisponibilidad_();

  Logger.log('✅ setup() completado. Filas por bloque: ' + filasPorBloque +
             ' (cupo ' + CONFIG.limiteCupos + ' + ' + CONFIG.filasSeparacion + ' de separación).');
}

/**
 * Amplía los bloques existentes SIN borrar las inscripciones ya registradas.
 *
 * Ejecuta esta función una sola vez si tu hoja se creó con una versión
 * anterior, donde cada grupo solo tenía 5 filas reservadas para 15 cupos.
 *
 * Por qué importa: cuando un bloque se queda sin espacio, cada inscripción
 * obliga a insertar filas y a limpiar su formato heredado, unas trece
 * llamadas extra a Google Sheets dentro del bloqueo. Reservando el espacio
 * de antemano, esa operación deja de producirse durante el uso normal.
 *
 * Es segura de repetir: si los bloques ya son suficientes, no hace nada.
 */
function ampliarBloquesParaCupos() {
  var sheet = obtenerHoja_();
  var necesarias = CONFIG.limiteCupos + CONFIG.filasSeparacion;

  var snapshot = leerSnapshot_(sheet, false);

  // Se recorre de abajo hacia arriba: así las filas que se insertan no
  // desplazan las secciones que todavía quedan por revisar.
  var claves = snapshot.orden.slice().reverse();
  var añadidas = 0;

  for (var i = 0; i < claves.length; i++) {
    var seccion  = snapshot.secciones[claves[i]];
    var capacidad = seccion.filaProximoEncabezado - seccion.filaInicio;
    if (capacidad >= necesarias) continue;

    var faltan  = necesarias - capacidad;
    var maxFilas = sheet.getMaxRows();
    var desde;

    if (seccion.filaProximoEncabezado > maxFilas) {
      sheet.insertRowsAfter(maxFilas, faltan);
      desde = maxFilas + 1;
    } else {
      sheet.insertRowsBefore(seccion.filaProximoEncabezado, faltan);
      desde = seccion.filaProximoEncabezado;
    }

    // Las filas insertadas heredan el formato del encabezado que tenían
    // debajo: hay que dejarlas neutras.
    var rango = sheet.getRange(desde, 1, faltan, sheet.getMaxColumns());
    rango.clear();
    rango
      .setBackground(CONFIG.colores.fondoEstudiante)
      .setFontColor(CONFIG.colores.textoEstudiante)
      .setFontWeight('normal')
      .setFontSize(10)
      .setFontFamily('Arial')
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle');
    rango.breakApart();

    añadidas += faltan;
    Logger.log('  · ' + seccion.dia + ' / ' + seccion.grupo +
               ' → +' + faltan + ' filas (tenía ' + capacidad + ')');
  }

  SpreadsheetApp.flush();
  invalidarDisponibilidad_();

  Logger.log('✅ ampliarBloquesParaCupos(): ' + añadidas + ' filas añadidas. ' +
             'Ninguna inscripción existente fue modificada.');
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
    correo:       'prueba' + new Date().getTime() + '@ejemplo.com',
    dias:         'Lunes y Jueves',
    horario:      '9:00 AM – 10:30 AM',
    grupo:        'Primer grupo de la mañana',
    nivel:        'Inglés Básico',
    inicioClases: CONFIG.marca.inicioClasesPorDefecto,
    aceptoTerminos: true,
    submissionId: 'test-' + new Date().getTime()
  };

  // Se omite el token porque esta prueba se ejecuta desde el editor, no desde
  // el formulario. Las peticiones reales SÍ lo exigen.
  var respuesta = procesarInscripcion_(datosPrueba, { omitirToken: true });
  Logger.log('✅ Resultado: ' + JSON.stringify(respuesta));
}

/**
 * Comprueba que el backend rechaza los datos manipulados.
 *
 * Recorre una batería de payloads inválidos y verifica que cada uno produce
 * un error controlado en lugar de una excepción interna o, peor, un registro
 * aceptado. Ninguna de estas pruebas escribe en la hoja.
 */
function testValidaciones() {
  function base(extra) {
    var d = {
      nombre: 'Ana María Pérez',
      whatsapp: '+1 809-555-0001',
      correo: 'ana@ejemplo.com',
      dias: 'Lunes y Jueves',
      horario: '9:00 AM – 10:30 AM',
      grupo: 'Primer grupo de la mañana',
      aceptoTerminos: true
    };
    for (var k in extra) { if (extra.hasOwnProperty(k)) d[k] = extra[k]; }
    return d;
  }

  var casos = [
    ['payload nulo',                 null],
    ['payload array',                []],
    ['nombre numérico',              base({ nombre: 12345 })],
    ['nombre objeto',                base({ nombre: { a: 1 } })],
    ['nombre demasiado corto',       base({ nombre: 'Al' })],
    ['nombre de 500 caracteres',     base({ nombre: new Array(501).join('a') })],
    ['nombre con fórmula',           base({ nombre: '=IMPORTXML("http://x","//a")' })],
    ['whatsapp vacío',               base({ whatsapp: '' })],
    ['whatsapp con letras',          base({ whatsapp: 'llámame' })],
    ['whatsapp de 3 dígitos',        base({ whatsapp: '123' })],
    ['correo ausente',               base({ correo: '', email: '' })],
    ['correo malformado',            base({ correo: 'ana@@ejemplo' })],
    ['días inventados',              base({ dias: 'SÁBADOS Y DOMINGOS' })],
    ['grupo inexistente',            base({ grupo: 'zzz', horario: '' })],
    ['grupo = "constructor"',        base({ grupo: 'constructor', horario: '' })],
    ['sin aceptar términos',         base({ aceptoTerminos: false })],
    ['submissionId con símbolos',    base({ submissionId: '../../etc/passwd' })]
  ];

  var fallos = 0;
  Logger.log('════ VALIDACIÓN DE DATOS MANIPULADOS ════');

  for (var i = 0; i < casos.length; i++) {
    var nombre = casos[i][0];
    try {
      normalizarDatos_(casos[i][1]);
      Logger.log('❌ ACEPTADO (no debería): ' + nombre);
      fallos++;
    } catch (err) {
      if (err.codigoLingola === CODIGOS.DATOS_INVALIDOS) {
        Logger.log('✅ rechazado: ' + nombre + ' → "' + err.message + '"');
      } else {
        Logger.log('❌ error NO controlado en: ' + nombre + ' → ' + err);
        fallos++;
      }
    }
  }

  Logger.log(fallos === 0
    ? '✅ Las ' + casos.length + ' entradas inválidas fueron rechazadas correctamente.'
    : '❌ ' + fallos + ' caso(s) sin controlar.');
}

/**
 * Informe rápido del estado del servicio.
 * Útil antes de una jornada de inscripciones masivas.
 */
function estadoDelServicio() {
  Logger.log('════ ESTADO DEL BACKEND LINGOLA ════');

  try {
    var sheet = obtenerHoja_();
    var snapshot = leerSnapshot_(sheet, true);

    var totalInscritos = 0;
    var bloquesJustos  = 0;
    var necesarias = CONFIG.limiteCupos + CONFIG.filasSeparacion;

    for (var i = 0; i < snapshot.orden.length; i++) {
      var s = snapshot.secciones[snapshot.orden[i]];
      totalInscritos += s.inscritos;
      if ((s.filaProximoEncabezado - s.filaInicio) < necesarias) bloquesJustos++;
    }

    Logger.log('Hoja: "' + CONFIG.hojaNombre + '" · ' + snapshot.orden.length + ' bloques detectados');
    Logger.log('Inscritos totales: ' + totalInscritos + ' de ' +
               (snapshot.orden.length * CONFIG.limiteCupos) + ' plazas');
    Logger.log(bloquesJustos === 0
      ? '✅ Todos los bloques tienen espacio reservado para los ' + CONFIG.limiteCupos + ' cupos.'
      : '⚠️  ' + bloquesJustos + ' bloque(s) sin espacio reservado → ejecuta ampliarBloquesParaCupos()');

  } catch (err) {
    Logger.log('❌ No se pudo leer la hoja: ' + err.message);
  }

  try {
    var porInscripcion = (CONFIG.correos.confirmarEstudiante ? 1 : 0) +
                         (CONFIG.correos.notificarAdministrador && ADMIN_EMAIL ? 1 : 0);
    var restantes = MailApp.getRemainingDailyQuota();

    Logger.log('Correos disponibles hoy: ' + restantes +
               ' · cada inscripción consume ' + porInscripcion);
    Logger.log('Aviso al administrador por inscripción: ' +
               (CONFIG.correos.notificarAdministrador ? 'activado' : 'desactivado'));
    Logger.log(porInscripcion > 0
      ? '→ Caben todavía ' + Math.floor(restantes / porInscripcion) + ' inscripciones hoy.'
      : '→ No se envía ningún correo (ambos avisos desactivados).');

  } catch (err) {
    Logger.log('⚠️  No se pudo consultar la cuota de correo: ' + err.message);
  }

  Logger.log('Token exigido: ' + (CONFIG.seguridad.tokenRequerido ? 'sí' : 'NO ⚠️') +
             ' · vigencia ' + (CONFIG.seguridad.tokenTtlSegundos / 60) + ' min');
  Logger.log('Secreto de firma: ' +
             (PropertiesService.getScriptProperties().getProperty(CLAVES.secretoToken) ? 'configurado ✅' : 'ausente ⚠️'));
  Logger.log('Espera máxima del bloqueo: ' + (CONFIG.seguridad.esperaLockMs / 1000) + ' s');
  Logger.log('Deduplicación de correo: ' + CONFIG.duplicados.alcance);
}

/**
 * Prueba de carga ejecutable desde el editor.
 *
 * Registra N inscripciones seguidas midiendo el tiempo de cada una. No
 * reproduce la simultaneidad real (eso requiere lanzar peticiones HTTP en
 * paralelo, ver pruebas-concurrencia.js), pero sí mide el coste efectivo de
 * la sección crítica, que es lo que determina cuánta cola puede absorberse.
 *
 * ⚠️ Escribe en la hoja. Ejecuta setup() después para dejarla limpia.
 *
 * @param {number} cantidad - Inscripciones a registrar (por defecto 15).
 */
function testCarga(cantidad) {
  var total = cantidad || 15;
  var marca = new Date().getTime();
  var tiempos = [];
  var errores = 0;

  Logger.log('════ PRUEBA DE CARGA: ' + total + ' inscripciones ════');

  for (var i = 1; i <= total; i++) {
    var inicio = new Date().getTime();
    try {
      // Registro directo: esta prueba mide la hoja, no envía correos.
      registrarEstudiante_(normalizarDatos_({
        nombre:   'Carga Prueba ' + i,
        whatsapp: '809555' + (1000 + i),
        correo:   'carga' + marca + '-' + i + '@ejemplo.com',
        dias:     'Lunes y Jueves',
        horario:  '9:00 AM – 10:30 AM',
        grupo:    'Primer grupo de la mañana',
        aceptoTerminos: true
      }));
      tiempos.push(new Date().getTime() - inicio);
    } catch (err) {
      errores++;
      Logger.log('  #' + i + ' → ' + (err.codigoLingola || 'ERROR') + ': ' + err.message);
    }
  }

  if (tiempos.length) {
    var suma = 0, max = 0;
    for (var t = 0; t < tiempos.length; t++) {
      suma += tiempos[t];
      if (tiempos[t] > max) max = tiempos[t];
    }
    var media = Math.round(suma / tiempos.length);
    Logger.log('Registros correctos: ' + tiempos.length + ' · errores: ' + errores);
    Logger.log('Tiempo medio por registro: ' + media + ' ms · máximo: ' + max + ' ms');
    Logger.log('Estimación para 100 solicitudes en cola: ' +
               Math.round(media * 100 / 1000) + ' s de espera acumulada.');
  } else {
    Logger.log('❌ Ningún registro completado. Errores: ' + errores);
  }
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
    nivel:        'Inglés Básico',
    dias:         'Lunes y Jueves',
    horario:      '9:00 AM – 10:30 AM',
    grupo:        'Primer grupo de la mañana',
    inicioClases: CONFIG.marca.inicioClasesPorDefecto,
    acepto:       true,
    fecha:        fechaHoraLocal_(),
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
    name:     CONFIG.marca.nombre,
    inlineImages: imagenesDelCorreo_()
  });

  MailApp.sendEmail({
    to:       ADMIN_EMAIL,
    subject:  '[PRUEBA] Nueva inscripción recibida - ' + CONFIG.marca.nombre,
    htmlBody: construirCorreoAdministrador_(info),
    body:     construirCorreoAdminTextoPlano_(info),
    name:     CONFIG.marca.nombre,
    inlineImages: imagenesDelCorreo_()
  });

  Logger.log('✅ Correos de prueba enviados a ' + ADMIN_EMAIL);
  Logger.log('Cuota de correos restante hoy: ' + MailApp.getRemainingDailyQuota());
}

/**
 * Borra las marcas de envíos ya procesados (claves de idempotencia).
 *
 * Desde la versión 4.0 estas marcas viven en CacheService y caducan solas, de
 * modo que ya no hace falta mantenerlas. Esta función limpia las que dejó la
 * versión anterior en ScriptProperties, que no caducaban nunca y acabarían
 * agotando el almacén de 500 KB.
 *
 * Nunca borra el secreto de firma de tokens. No afecta a la hoja de cálculo.
 */
function limpiarMarcasDeEnvio() {
  var propiedades = PropertiesService.getScriptProperties();
  var todas = propiedades.getProperties();
  var eliminadas = 0;

  for (var clave in todas) {
    if (clave === CLAVES.secretoToken) continue;
    if (clave.indexOf(CONFIG.prefijoEnvio) === 0) {
      propiedades.deleteProperty(clave);
      eliminadas++;
    }
  }

  Logger.log('🧹 Marcas antiguas eliminadas de ScriptProperties: ' + eliminadas);
  Logger.log('ℹ️  Las marcas actuales están en CacheService y caducan a las 6 h.');
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
        grupo:    combinaciones[c].grupo,
        aceptoTerminos: true
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
