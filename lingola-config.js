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
    inicioClases: {
        fecha: 'Martes 1 de septiembre de 2026',
        descripcion: 'Fecha de inicio del próximo ciclo.',
    },

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
        gasWebAppUrl: 'https://script.google.com/macros/s/AKfycbwg45v6BwSf63oF1EXELYr9U7h3yExktPAkOluXnvl2TiWVKzVSfEzNwt_uOaVEV2x6Iw/exec',
        whatsappNumero: '18495358676',
        // Informativo para el frontend. El envío real de correos
        // ocurre en Google Apps Script (ADMIN_EMAIL en el backend).
        adminEmail: 'lingolaenglishteaching@gmail.com',
    },

    // ── Cupos por grupo (días + horario) ───────────────────
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
