/**
 * Simulador de los servicios de Google Apps Script.
 *
 * Carga backend-ingles-basico.gs tal cual, sustituyendo SpreadsheetApp,
 * LockService, CacheService, PropertiesService, MailApp, Utilities y Session
 * por implementaciones en memoria. Permite ejecutar el backend completo sin
 * desplegarlo y observar exactamente qué llamadas hace a cada servicio.
 */

const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const RUTA_GS = require('path').join(__dirname, '..', 'backend-ingles-basico.gs');

// ── Instrumentación compartida ────────────────────────────────────────────
const stats = {
  llamadasSheets: 0,
  lecturas: 0,
  escrituras: 0,
  insercionesDeFilas: 0,
  correosEnviados: 0,
  mutacionesSinLock: [],
  vigilarLock: false
};

const lockState = { held: false, dueño: null };

function contar(tipo) {
  stats.llamadasSheets++;
  if (tipo === 'lectura') stats.lecturas++;
  if (tipo === 'escritura') stats.escrituras++;
}

function comprobarLock(operacion) {
  if (stats.vigilarLock && !lockState.held) {
    stats.mutacionesSinLock.push(operacion);
  }
}

// ── Modelo de hoja de cálculo ─────────────────────────────────────────────
class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    contar('lectura');
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const fila = [];
      for (let c = 0; c < this.numCols; c++) {
        fila.push(this.sheet.leer(this.row + r, this.col + c));
      }
      out.push(fila);
    }
    return out;
  }
  setValues(valores) {
    contar('escritura');
    comprobarLock('setValues fila ' + this.row);
    for (let r = 0; r < valores.length; r++) {
      for (let c = 0; c < valores[r].length; c++) {
        this.sheet.escribir(this.row + r, this.col + c, valores[r][c]);
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  // Operaciones de formato: no afectan a los datos, solo se contabilizan.
  merge() { contar('formato'); return this; }
  breakApart() { contar('formato'); return this; }
  clearFormat() { contar('formato'); return this; }
  clearContent() {
    contar('escritura'); comprobarLock('clearContent');
    for (let r = 0; r < this.numRows; r++)
      for (let c = 0; c < this.numCols; c++)
        this.sheet.escribir(this.row + r, this.col + c, '');
    return this;
  }
  clear() { this.clearFormat(); this.clearContent(); return this; }
  copyTo() { contar('formato'); return this; }
  setBorder() { contar('formato'); return this; }
}

for (const m of ['setBackground', 'setFontColor', 'setFontWeight', 'setFontSize',
                 'setFontFamily', 'setHorizontalAlignment', 'setVerticalAlignment',
                 'setNumberFormat', 'setWrap']) {
  FakeRange.prototype[m] = function () { contar('formato'); return this; };
}

class FakeSheet {
  constructor(nombre, filas = 260, cols = 7) {
    this.nombre = nombre;
    this.datos = new Map(); // "r,c" -> valor
    this.filas = filas;
    this.cols = cols;
  }
  clave(r, c) { return r + ',' + c; }
  leer(r, c) { return this.datos.has(this.clave(r, c)) ? this.datos.get(this.clave(r, c)) : ''; }
  escribir(r, c, v) { this.datos.set(this.clave(r, c), v); }

  getMaxRows() { contar('meta'); return this.filas; }
  getMaxColumns() { contar('meta'); return this.cols; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    contar('meta');
    let ultimaFila = 1, ultimaCol = 1;
    for (const k of this.datos.keys()) {
      const v = this.datos.get(k);
      if (v === '' || v === null || v === undefined) continue;
      const [r, c] = k.split(',').map(Number);
      if (r > ultimaFila) ultimaFila = r;
      if (c > ultimaCol) ultimaCol = c;
    }
    return new FakeRange(this, 1, 1, ultimaFila, Math.max(ultimaCol, this.cols));
  }
  desplazarFilas(desde, cantidad) {
    const nuevo = new Map();
    for (const [k, v] of this.datos) {
      const [r, c] = k.split(',').map(Number);
      nuevo.set(this.clave(r >= desde ? r + cantidad : r, c), v);
    }
    this.datos = nuevo;
  }
  insertRowsBefore(row, n) {
    contar('escritura'); comprobarLock('insertRowsBefore ' + row);
    stats.insercionesDeFilas++;
    this.desplazarFilas(row, n);
    this.filas += n;
  }
  insertRowsAfter(row, n) { this.insertRowsBefore(row + 1, n); }
  deleteRows(row, n) {
    contar('escritura');
    for (let i = 0; i < n; i++) {
      for (let c = 1; c <= this.cols; c++) this.datos.delete(this.clave(row + i, c));
    }
    const nuevo = new Map();
    for (const [k, v] of this.datos) {
      const [r, c] = k.split(',').map(Number);
      nuevo.set(this.clave(r > row ? r - n : r, c), v);
    }
    this.datos = nuevo;
    this.filas -= n;
  }
  insertColumnsAfter(col, n) { contar('escritura'); this.cols += n; }
  setColumnWidth() { contar('formato'); return this; }
  setRowHeight() { contar('formato'); return this; }
  clear() { contar('escritura'); this.datos.clear(); return this; }
  clearFormats() { contar('formato'); return this; }
  getName() { return this.nombre; }
}

class FakeSpreadsheet {
  constructor() { this.hojas = new Map(); }
  getSheetByName(n) { contar('meta'); return this.hojas.get(n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.hojas.set(n, s); return s; }
}

const libro = new FakeSpreadsheet();

// ── Almacenes clave-valor ─────────────────────────────────────────────────
class FakeStore {
  constructor(conTtl) { this.mapa = new Map(); this.conTtl = conTtl; }
  get(k) {
    const e = this.mapa.get(k);
    if (!e) return null;
    if (this.conTtl && e.expira && Date.now() > e.expira) { this.mapa.delete(k); return null; }
    return e.valor;
  }
  put(k, v, ttl) { this.mapa.set(k, { valor: String(v), expira: ttl ? Date.now() + ttl * 1000 : 0 }); }
  remove(k) { this.mapa.delete(k); }
  // API de PropertiesService
  getProperty(k) { return this.get(k); }
  setProperty(k, v) { this.put(k, v); return this; }
  deleteProperty(k) { this.remove(k); return this; }
  getProperties() { const o = {}; for (const [k, e] of this.mapa) o[k] = e.valor; return o; }
}

const cache = new FakeStore(true);
const propiedades = new FakeStore(false);

// ── Utilidades ────────────────────────────────────────────────────────────
function aBytesConSigno(buf) {
  return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
}
function deBytesConSigno(arr) {
  return Buffer.from(arr.map(b => (b < 0 ? b + 256 : b)));
}

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  base64EncodeWebSafe(entrada) {
    const buf = Array.isArray(entrada) ? deBytesConSigno(entrada) : Buffer.from(String(entrada), 'utf8');
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  },
  base64DecodeWebSafe(texto) {
    const normal = String(texto).replace(/-/g, '+').replace(/_/g, '/');
    return aBytesConSigno(Buffer.from(normal, 'base64'));
  },
  base64Encode(entrada) {
    const buf = Array.isArray(entrada) ? deBytesConSigno(entrada) : Buffer.from(String(entrada), 'utf8');
    return buf.toString('base64');
  },
  base64Decode(texto) {
    return aBytesConSigno(Buffer.from(String(texto), 'base64'));
  },
  computeHmacSha256Signature(valor, clave) {
    return aBytesConSigno(crypto.createHmac('sha256', String(clave)).update(String(valor), 'utf8').digest());
  },
  computeDigest(_alg, valor) {
    return aBytesConSigno(crypto.createHash('sha256').update(String(valor), 'utf8').digest());
  },
  // Devuelve lo mismo que un Blob de Apps Script: además del texto, los bytes
  // y los metadatos que necesitan las imágenes en línea de los correos.
  newBlob(bytes, tipo, nombre) {
    return {
      getDataAsString: () => deBytesConSigno(bytes).toString('utf8'),
      getBytes: () => bytes.slice(),
      getContentType: () => tipo || null,
      getName: () => nombre || null
    };
  },
  // Convierte de verdad a la zona horaria recibida, igual que hace
  // Utilities.formatDate en Apps Script. Antes se ignoraba el parámetro y se
  // usaba la hora local de la máquina que ejecuta las pruebas, con lo que un
  // desfase de zona horaria habría pasado desapercibido.
  formatDate(fecha, tz, formato) {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year:  'numeric', month:  '2-digit', day:    '2-digit',
      hour:  '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(fecha).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    return formato
      .replace('dd', partes.day)
      .replace('MM', partes.month)
      .replace('yyyy', partes.year)
      // Algunas versiones de Node devuelven "24" para la medianoche.
      .replace('HH', partes.hour === '24' ? '00' : partes.hour)
      .replace('mm', partes.minute)
      .replace('ss', partes.second);
  },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' }
};

// ── Contexto global expuesto al código .gs ────────────────────────────────
const sandbox = {
  console,
  JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, isNaN, isFinite, parseInt, parseFloat,

  SpreadsheetApp: {
    getActiveSpreadsheet: () => { contar('meta'); return libro; },
    flush: () => { contar('flush'); },
    CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT' },
    BorderStyle: { SOLID: 'SOLID' }
  },

  LockService: {
    getScriptLock: () => ({
      tryLock(ms) {
        if (lockState.held) return false;   // exclusión real
        lockState.held = true;
        return true;
      },
      waitLock(ms) { if (!this.tryLock(ms)) throw new Error('Lock timeout'); },
      releaseLock() { lockState.held = false; }
    })
  },

  CacheService: { getScriptCache: () => cache },
  PropertiesService: { getScriptProperties: () => propiedades },

  ContentService: {
    createTextOutput(texto) {
      // Se expone .texto para que las pruebas puedan leer el cuerpo emitido.
      const salida = { texto: String(texto), mime: null };
      salida.setMimeType = function (m) { this.mime = m; return this; };
      return salida;
    },
    MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript' }
  },

  MailApp: {
    sendEmail: (opciones) => {
      stats.correosEnviados++;
      if (sandbox.__fallarCorreo) throw new Error('Simulación: servicio de correo caído');
      (sandbox.__correos = sandbox.__correos || []).push(opciones);
    },
    getRemainingDailyQuota: () => (sandbox.__cuotaCorreo === undefined ? 100 : sandbox.__cuotaCorreo)
  },

  // Deliberadamente distinta de CONFIG.zonaHoraria: reproduce el proyecto de
  // Apps Script con la zona mal configurada, que es lo que provocaba el
  // desfase. Si alguna parte del backend volviera a apoyarse en la zona del
  // proyecto en lugar de en CONFIG.zonaHoraria, las pruebas de fecha fallarían.
  Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
  Logger: { log: (m) => { if (process.env.VERBOSE) console.log('   [log]', m); } },
  Utilities
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(RUTA_GS, 'utf8'), sandbox, { filename: 'backend-ingles-basico.gs' });

module.exports = { sandbox, stats, lockState, libro, cache, propiedades };
