/**
 * =========================================================
 * LINGOLA — Verificación del despliegue
 * =========================================================
 *
 * Comprueba, SIN escribir nada ni enviar correos, que la versión publicada
 * del Web App es la v4.0 y que sus endpoints responden.
 *
 * Sirve para detectar el error más común del despliegue: guardar el código
 * en el editor y olvidar publicar una versión nueva, con lo que Apps Script
 * sigue sirviendo la anterior.
 *
 *   node pruebas/verificar-despliegue.js
 *   node pruebas/verificar-despliegue.js --url=https://.../exec
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const valorArg = (n, def) => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=')[1] : def;
};

function urlDeConfig() {
  try {
    const texto = fs.readFileSync(path.join(__dirname, '..', 'lingola-config.js'), 'utf8');
    const m = texto.match(/gasWebAppUrl:\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

const URL = valorArg('url', '') || urlDeConfig();

if (!URL || !URL.includes('/macros/s/') || !URL.endsWith('/exec')) {
  console.error('❌ No se encontró una URL válida del Web App.');
  process.exit(1);
}

let fallos = 0;
const ok  = (m) => console.log('  ✅ ' + m);
const mal = (m) => { console.log('  ❌ ' + m); fallos++; };

async function pedir(sufijo) {
  const t0 = Date.now();
  const r = await fetch(URL + sufijo, { redirect: 'follow' });
  const texto = await r.text();
  return { status: r.status, texto, ms: Date.now() - t0 };
}

function comoJson(texto) {
  try { return JSON.parse(texto); } catch (e) { return null; }
}

(async () => {
  console.log('\n' + '═'.repeat(64));
  console.log(' VERIFICACIÓN DEL DESPLIEGUE');
  console.log('═'.repeat(64));
  console.log(' URL: ' + URL.slice(0, 58) + '…\n');

  // ── 1. ¿Responde y qué versión sirve? ──
  console.log('▸ Versión publicada');
  let versionOk = false;
  try {
    const r = await pedir('');
    if (r.status !== 200) mal('El servidor respondió HTTP ' + r.status);

    const j = comoJson(r.texto);
    const mensaje = j && j.message ? j.message : r.texto.slice(0, 80);

    if (/v4\.\d/.test(mensaje)) {
      ok('Sirve la v4.0 — ' + mensaje + ' (' + r.ms + ' ms)');
      versionOk = true;
    } else {
      mal('Sigue publicada una versión anterior → "' + mensaje + '"');
      console.log('     Falta: Implementar › Gestionar implementaciones › ✏️ Editar');
      console.log('            › Versión: Nueva versión › Implementar');
    }
  } catch (e) {
    mal('No se pudo contactar con el backend: ' + e.message);
  }

  // ── 2. Endpoint de token (solo existe en la v4.0) ──
  console.log('\n▸ Emisión de token');
  try {
    const r = await pedir('?action=token');
    const j = comoJson(r.texto);

    if (j && j.status === 'success' && j.token) {
      ok('Token emitido correctamente (' + r.ms + ' ms)');
      ok('Vigencia declarada: ' + (j.expiraEn / 60) + ' minutos');

      const segundo = comoJson((await pedir('?action=token')).texto);
      if (segundo && segundo.token && segundo.token !== j.token) {
        ok('Cada token es distinto del anterior');
      } else {
        mal('Se repitió el token: la firma no está funcionando');
      }
    } else if (versionOk) {
      mal('La v4.0 responde, pero ?action=token no devolvió un token');
    } else {
      mal('Sin endpoint de token (esperable si aún sirve la versión antigua)');
    }
  } catch (e) {
    mal('Error al pedir token: ' + e.message);
  }

  // ── 3. Disponibilidad de cupos ──
  console.log('\n▸ Consulta de disponibilidad');
  try {
    const r = await pedir('?action=disponibilidad');
    const j = comoJson(r.texto);

    if (j && j.status === 'success' && Array.isArray(j.grupos)) {
      ok('Responde con ' + j.grupos.length + ' grupos (' + r.ms + ' ms)');
      if (j.grupos.length !== 8) mal('Se esperaban 8 grupos, llegaron ' + j.grupos.length);

      const libres = j.grupos.reduce((s, g) => s + g.disponibles, 0);
      const total  = j.grupos.reduce((s, g) => s + g.limite, 0);
      console.log('     Cupos libres: ' + libres + ' de ' + total);

      // La segunda consulta debe salir de caché y ser claramente más rápida.
      const r2 = await pedir('?action=disponibilidad');
      console.log('     Segunda consulta: ' + r2.ms + ' ms' +
                  (r2.ms < r.ms ? ' (más rápida: caché activa)' : ''));
    } else {
      mal('Respuesta de disponibilidad no válida');
    }
  } catch (e) {
    mal('Error al consultar disponibilidad: ' + e.message);
  }

  // ── 4. El endpoint de inscripción exige token ──
  console.log('\n▸ Protección del endpoint de inscripción');
  try {
    const datos = encodeURIComponent(JSON.stringify({
      nombre: 'Prueba Verificacion', whatsapp: '8095550000',
      correo: 'verificacion@ejemplo.com', dias: 'Lunes y Jueves',
      grupo: 'Primer grupo de la mañana', aceptoTerminos: true
    }));
    const r = await pedir('?action=inscribir&data=' + datos);
    const j = comoJson(r.texto);

    if (j && j.status === 'error' &&
        (j.code === 'TOKEN_INVALIDO' || j.code === 'TOKEN_EXPIRADO')) {
      ok('Una inscripción sin token es rechazada (' + j.code + ')');
      ok('No se escribió ninguna fila');
    } else if (j && j.status === 'success') {
      mal('¡El endpoint aceptó una inscripción SIN token! Revisa CONFIG.seguridad');
    } else {
      mal('Respuesta inesperada: ' + JSON.stringify(j).slice(0, 120));
    }
  } catch (e) {
    mal('Error al probar el endpoint: ' + e.message);
  }

  // ── Resumen ──
  console.log('\n' + '═'.repeat(64));
  if (fallos === 0) {
    console.log(' ✅ Despliegue correcto. Nada se escribió ni se envió por correo.');
  } else {
    console.log(' ❌ ' + fallos + ' comprobación(es) fallida(s). Revisa los pasos indicados.');
  }
  console.log('═'.repeat(64) + '\n');

  process.exit(fallos === 0 ? 0 : 1);
})();
