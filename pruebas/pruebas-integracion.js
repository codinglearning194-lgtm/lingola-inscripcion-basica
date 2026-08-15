/**
 * Prueba de integración: recorre doGet/doPost exactamente como lo haría el
 * navegador desde contrato-basico-nuevo.html, incluido el formato JSONP.
 */
const { sandbox, libro, cache } = require('./simulador-apps-script.js');

let fallos = 0;
const ok = (c, t, d) => {
  if (c) console.log('   ✅ ' + t);
  else { fallos++; console.log('   ❌ ' + t + (d !== undefined ? ' → ' + JSON.stringify(d) : '')); }
};

sandbox.setup();
cache.mapa.clear();

console.log('\n═══ INTEGRACIÓN: recorrido completo del formulario ═══\n');

// ── 1. datos-personales: consulta de disponibilidad por JSONP ──
const respDisp = sandbox.doGet({ parameter: { action: 'disponibilidad', callback: 'lingolaCb_123', t: '1' } });
const textoDisp = respDisp.texto;
ok(textoDisp.indexOf('lingolaCb_123(') === 0, 'La disponibilidad se devuelve envuelta en JSONP');
const disp = JSON.parse(textoDisp.replace(/^lingolaCb_123\(/, '').replace(/\);$/, ''));
ok(disp.status === 'success' && disp.grupos.length === 8, 'Devuelve los 8 grupos', disp.grupos && disp.grupos.length);
ok(disp.grupos[0].disponibles === 15, 'Todos los cupos libres al empezar', disp.grupos[0]);

// ── 2. Callback malicioso ──
const respXss = sandbox.doGet({ parameter: { action: 'disponibilidad', callback: 'alert(1);//' } });
ok(respXss.texto.indexOf('alert') === -1, 'Un callback con código se rechaza (sin JSONP ejecutable)', respXss.texto.slice(0, 80));

// ── 3. contrato: obtención del token ──
const respTok = sandbox.doGet({ parameter: { action: 'token', callback: 'lingolaCb_456' } });
const tok = JSON.parse(respTok.texto.replace(/^lingolaCb_456\(/, '').replace(/\);$/, ''));
ok(tok.status === 'success' && !!tok.token, 'Se emite el token');
ok(tok.expiraEn === 1800, 'El token declara 30 minutos de vigencia', tok.expiraEn);

// ── 4. contrato: POST con el payload EXACTO del frontend ──
const payloadReal = {
  nivel: 'Inglés Básico',
  nombre: 'María José Rodríguez Peña',
  whatsapp: '+1 809-555-0123',
  email: 'maria.jose@ejemplo.com',
  dias: 'Lunes y Jueves',
  horario: '9:00 AM – 10:30 AM',
  grupo: 'Primer grupo de la mañana',
  inicioClases: 'Martes 1 de septiembre de 2026',
  aceptoTerminos: true,
  fechaAceptacion: new Date().toISOString(),
  submissionId: 'ins-abc123-xyz789',
  token: tok.token
};

const respPost = sandbox.doPost({
  postData: { type: 'text/plain;charset=UTF-8', contents: JSON.stringify(payloadReal) }
});
const res = JSON.parse(respPost.texto);

ok(res.status === 'success', 'El POST del frontend se registra correctamente', res);
ok(res.duplicado === false, 'No se marca como duplicado');
ok(res.fila > 0, 'Devuelve el número de fila', res.fila);
ok(res.limite === 15 && res.disponibles === 14, 'Los cupos se contabilizan', res);
ok(typeof res.correos === 'object', 'Mantiene el campo "correos" del contrato v3.0');

const hoja = libro.getSheetByName('Inscripciones Básico');
ok(hoja.leer(res.fila, 3) === 'María José Rodríguez Peña', 'El nombre con acentos se guarda intacto', hoja.leer(res.fila, 3));
ok(hoja.leer(res.fila, 2) === 'Inglés Básico', 'El nivel escrito es el del servidor, no el del cliente', hoja.leer(res.fila, 2));
ok(hoja.leer(res.fila, 7) === '9:00 AM – 10:30 AM', 'El horario escrito procede de la configuración', hoja.leer(res.fila, 7));

// ── 5. Reintento del frontend (mismo submissionId, token nuevo) ──
const tok2 = JSON.parse(
  sandbox.doGet({ parameter: { action: 'token', callback: 'cb' } }).texto.replace(/^cb\(/, '').replace(/\);$/, '')
).token;
const reintento = JSON.parse(sandbox.doPost({
  postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({}, payloadReal, { token: tok2 })) }
}).texto);
ok(reintento.status === 'success' && reintento.duplicado === true, 'El reintento se reconoce como duplicado', reintento);

// ── 6. Respaldo JSONP de inscripción (doGet action=inscribir) ──
const tok3 = JSON.parse(
  sandbox.doGet({ parameter: { action: 'token', callback: 'cb' } }).texto.replace(/^cb\(/, '').replace(/\);$/, '')
).token;
const payloadJsonp = Object.assign({}, payloadReal, {
  email: 'segunda.persona@ejemplo.com', nombre: 'Carlos Alberto Núñez',
  submissionId: 'ins-def456', token: tok3, dias: 'Martes y Viernes',
  grupo: 'Segundo grupo de la tarde', horario: '4:00 PM – 5:30 PM'
});
const respJsonp = sandbox.doGet({
  parameter: { action: 'inscribir', callback: 'lingolaCb_789', data: JSON.stringify(payloadJsonp) }
});
const resJsonp = JSON.parse(respJsonp.texto.replace(/^lingolaCb_789\(/, '').replace(/\);$/, ''));
ok(resJsonp.status === 'success', 'El respaldo JSONP también registra', resJsonp);

// ── 7. Ataque directo al endpoint sin token ──
const ataque = JSON.parse(sandbox.doPost({
  postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({}, payloadReal, {
    email: 'atacante@ejemplo.com', submissionId: 'ataque-1', token: ''
  })) }
}).texto);
ok(ataque.status === 'error' && ataque.code === 'TOKEN_INVALIDO',
   'Una llamada directa al endpoint sin token es rechazada', ataque);

// ── 8. Ninguna excepción escapa nunca de doPost ──
const basura = [
  { postData: { type: 'text/plain', contents: 'esto no es json' } },
  { postData: { type: 'text/plain', contents: '{"nombre":' } },
  { postData: { type: 'text/plain', contents: JSON.stringify({ nombre: { $gt: '' } }) } },
  { postData: { type: 'text/plain', contents: 'x'.repeat(50000) } },
  { parameter: {} },
  {}
];
let escapadas = 0;
basura.forEach((e, i) => {
  try {
    const r = JSON.parse(sandbox.doPost(e).texto);
    if (r.status !== 'error') { escapadas++; console.log('      caso ' + i + ' devolvió éxito: ' + JSON.stringify(r)); }
  } catch (err) { escapadas++; console.log('      caso ' + i + ' lanzó excepción: ' + err.message); }
});
ok(escapadas === 0, 'Los ' + basura.length + ' cuerpos malformados producen respuesta de error controlada');

// ── 9. Los mensajes de error no filtran información interna ──
const filtraciones = ['Lock timeout', 'setup()', 'Spreadsheets', 'line ', 'at Object', 'undefined is not'];
let filtrados = 0;
basura.forEach(e => {
  const r = JSON.parse(sandbox.doPost(e).texto);
  filtraciones.forEach(f => { if (r.message && r.message.indexOf(f) !== -1) { filtrados++; console.log('      filtra: ' + r.message); } });
});
ok(filtrados === 0, 'Ningún mensaje de error expone detalles internos');

console.log('\n' + (fallos === 0 ? '✅ Integración completa sin fallos.' : '❌ ' + fallos + ' fallo(s).') + '\n');
process.exit(fallos ? 1 : 0);
