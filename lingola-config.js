/**
 * =========================================================
 * LINGOLA — Configuración centralizada del curso
 * =========================================================
 *
 * Este archivo contiene todos los datos reutilizables del
 * programa de inscripción. Cuando cambie un precio o una
 * fecha, modifíquelo ÚNICAMENTE aquí y el cambio se
 * reflejará automáticamente en:
 *
 *   • Página de información del curso
 *   • Página de datos personales
 *   • Contrato de inscripción
 *   • Correo de confirmación
 *   • Página de pago
 *   • Futuras automatizaciones
 *
 * =========================================================
 */

const LINGOLA_CONFIG = {

    // ── Información del curso ──────────────────────────────
    curso: {
        nombre: 'Inglés Básico',
        nivel: 'basico-nuevo',
        duracion: '6 meses',
    },

    // ── Costos ─────────────────────────────────────────────
    inscripcion: {
        monto: 1000,
        moneda: 'RD$',
        descripcion: 'Pago único al momento de inscribirse.',
    },

    mensualidad: {
        monto: 1200,
        moneda: 'RD$',
        descripcion: 'Pago mensual durante la duración del curso.',
    },

    // ── Fechas ─────────────────────────────────────────────
    // ⚠️ SINCRONIZACIÓN CON EL BACKEND
    //    Esta fecha se muestra en las páginas web, pero el correo de
    //    confirmación usa la del servidor. Desde la versión 4.0 el backend
    //    ignora la fecha que envía el navegador (era un texto que cualquiera
    //    podía manipular y que acababa dentro de un correo con nuestra marca).
    //
    //    Si cambias esta fecha, cambia TAMBIÉN en backend-ingles-basico.gs:
    //        CONFIG.marca.inicioClasesPorDefecto
    //    y vuelve a implementar el Web App. Si no, la web dirá una fecha y el
    //    correo otra.
    inicioClases: {
        fecha: 'Martes 1 de septiembre de 2026',
        descripcion: 'Fecha de inicio del próximo ciclo.',
    },

    // ── Zona horaria del sistema de inscripciones ──────────
    // ⚠️ SINCRONIZACIÓN CON EL BACKEND
    //    Debe ser idéntica a CONFIG.zonaHoraria en backend-ingles-basico.gs.
    //
    //    La fecha y hora OFICIAL de cada inscripción la genera el servidor;
    //    este valor no interviene en ella. Se usa únicamente para los textos
    //    que arma el navegador (por ejemplo, el mensaje de WhatsApp de
    //    respaldo), de modo que muestren la hora del programa y no la del
    //    dispositivo del estudiante, que puede estar en otro país o tener el
    //    reloj mal configurado.
    //
    //    Debe ser un identificador IANA, nunca un desfase fijo tipo 'UTC-4'.
    zonaHoraria: 'America/Santo_Domingo',

    // ── Pago de la mensualidad ─────────────────────────────
    // Ventana de pago mensual y método aceptado.
    pagoMensualidad: {
        diaInicio: 7,
        diaFin: 15,
        metodo: 'transferencia bancaria',
        get ventana() {
            return `entre los días ${this.diaInicio} y ${this.diaFin} de cada mes`;
        },
    },

    // ── Integraciones / Backend ────────────────────────────
    // ⚠️ Una sola URL para TODO el proyecto. Si vuelves a
    //    implementar el Web App de Apps Script, actualiza
    //    únicamente este valor.
    backend: {
        gasWebAppUrl: 'https://script.google.com/macros/s/AKfycbyqUIKLMjEI9h81uMaAuHveLMB8gTrZnhZ2TP02oF4Xhild4KaDeDnq_GISZQLIuOt3/exec',
        whatsappNumero: '18495358676',
        // Informativo para el frontend. El envío real de correos
        // ocurre en Google Apps Script (ADMIN_EMAIL en el backend).
        adminEmail: 'lingolaenglishteaching@gmail.com',
    },

    // ── Cupos por grupo (días + horario) ───────────────────
    // ⚠️ Este valor es solo para los textos que ve el estudiante. El límite
    //    que de verdad se aplica vive en el servidor (CONFIG.limiteCupos) y
    //    se comprueba dentro del bloqueo al registrar, de modo que tocar
    //    este archivo desde el navegador no permite saltarse el cupo.
    //    Manténlo igual que en el backend para que los mensajes cuadren.
    cupos: {
        limitePorGrupo: 15,
    },

    // ── Pago del día (lo que el estudiante paga hoy) ──────
    pagoHoy: {
        get monto() { return LINGOLA_CONFIG.inscripcion.monto; },
        get moneda() { return LINGOLA_CONFIG.inscripcion.moneda; },
        descripcion: 'Monto a pagar hoy para reservar tu cupo.',
    },

    proximoPago: {
        descripcion: 'mensuales a partir del segundo mes.',
    },

    // ── Helpers ────────────────────────────────────────────
    /** Retorna el monto formateado con moneda: "RD$ 1,000" */
    formatMonto(montoObj) {
        const formatted = montoObj.monto.toLocaleString('es-DO');
        return `${montoObj.moneda} ${formatted}`;
    },

    /** Monto de inscripción formateado */
    get inscripcionFormateada() {
        return this.formatMonto(this.inscripcion);
    },

    /** Mensualidad formateada */
    get mensualidadFormateada() {
        return this.formatMonto(this.mensualidad);
    },

    /** Total a pagar hoy formateado */
    get pagoHoyFormateado() {
        return this.formatMonto(this.pagoHoy);
    },

    /** Enlace base de WhatsApp para instrucciones de pago */
    get whatsappBaseURL() {
        return `https://wa.me/${this.backend.whatsappNumero}`;
    },
};
