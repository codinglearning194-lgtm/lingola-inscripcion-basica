# Despliegue del backend v4.0

Guía para publicar `backend-ingles-basico.gs` y el frontend que lo acompaña.

**Estado actual detectado:** el backend en producción responde **v2.0**. Tu archivo local ya iba por delante incluso antes de esta auditoría.

---

## ⚠️ Las dos trampas del proceso

### 1. `setup()` BORRA la hoja

| Situación | Función a ejecutar |
|---|---|
| Hoja nueva, sin inscripciones | `setup()` |
| **Ya hay estudiantes registrados** | **`ampliarBloquesParaCupos()`** |

`ampliarBloquesParaCupos()` amplía los bloques conservando todos los datos.

### 2. "Nueva implementación" NO es lo que quieres

Apps Script ofrece dos cosas que suenan igual y no lo son:

| Opción del menú | Resultado en la URL | ¿Hay que tocar el frontend? |
|---|---|---|
| **Editar ✏️ › Versión: Nueva versión** | **La misma** ✅ | No |
| Nueva implementación | **URL nueva** | Sí, actualizar `lingola-config.js` |

**Usa la primera.** Conservas la URL y no tienes que tocar nada más.

Y lo contrario también importa: **guardar el código no publica nada**. Apps Script sigue sirviendo la versión publicada anterior hasta que creas una versión nueva. Es la causa nº 1 de "hice los cambios y no pasó nada".

---

## Pasos

### 1. Abre el proyecto correcto

Desde tu Google Sheet: **Extensiones › Apps Script**.

> ⚠️ **No crees un proyecto suelto** en script.google.com. El código necesita estar vinculado a la hoja.
>
> Si aun así usas un proyecto independiente, funciona, pero debes indicarle cuál es la hoja. En el editor, pestaña **Configuración del proyecto › Propiedades del script**, añade:
>
> | Propiedad | Valor |
> |---|---|
> | `LINGOLA_SPREADSHEET_ID` | el tramo de la URL entre `/d/` y `/edit` |

### 2. Pega el código

Selecciona todo el contenido del editor, bórralo y pega `backend-ingles-basico.gs` completo. Guarda (Ctrl+S).

### 3. Ejecuta la función de preparación

En el desplegable de funciones elige la que corresponda según la tabla de arriba y pulsa **▶ Ejecutar**.

La primera vez Google pedirá autorizar permisos de Sheets y Gmail. Aparecerá un aviso de "app no verificada": es normal en tus propios scripts — **Configuración avanzada › Ir a (nombre del proyecto)**.

### 4. Comprueba antes de publicar

Ejecuta `estadoDelServicio()` y mira **Registro de ejecución**. Debe mostrar los 8 grupos y la cuota de correo restante.

### 5. Publica

**Implementar › Gestionar implementaciones › ✏️ Editar › Versión: Nueva versión › Implementar**

Configuración:
- Ejecutar como: **Yo (tu cuenta)**
- Quién tiene acceso: **Cualquier usuario**

### 6. Verifica que la versión nueva está activa

```bash
node pruebas/verificar-despliegue.js
```

Debe responder **v4.0** y emitir un token. Si sigue diciendo v2.0, el paso 5 no se completó.

### 7. Frontend

Sube `contrato-basico-nuevo.html`. Es el único HTML modificado.

Los demás (`datos-personales-*.html`, `seleccionDenivel.html`, `informacion-*.html`, `index.html`) no cambiaron.

---

## Comprobación final

Haz una inscripción real desde el formulario:

- [ ] La fila aparece en la hoja, en el bloque correcto
- [ ] El WhatsApp se ve como texto (`+1 809-…`), no como `#ERROR!`
- [ ] Llega el correo de confirmación al estudiante
- [ ] Repetir con el mismo correo responde "ya había sido registrada" y **no** crea otra fila

---

## Funciones de diagnóstico

| Función | Para qué sirve |
|---|---|
| `estadoDelServicio()` | Cupos, cuota de correo y estado de configuración |
| `testDisponibilidad()` | Cupos libres de los 8 grupos |
| `testValidaciones()` | Comprueba que los payloads manipulados se rechazan |
| `testInscripcion()` | Registra un estudiante de prueba |
| `testCarga(n)` | Simula `n` inscripciones y mide el coste |
| `testCorreos()` | Envía una muestra de los correos a `ADMIN_EMAIL` |
| `limpiarMarcasDeEnvio()` | Borra marcas de idempotencia antiguas |
| `ampliarBloquesParaCupos()` | Amplía los bloques sin borrar datos |

## Pruebas locales

```bash
node pruebas/pruebas-backend.js        # 63 comprobaciones
node pruebas/pruebas-integracion.js    # flujo frontend → backend
node pruebas/medir-seccion-critica.js  # coste del bloqueo
```

Contra el servidor ya desplegado:

```bash
node pruebas-concurrencia.js --n=100 --concurrencia=25
```

> ⚠️ **Nunca subas `--concurrencia` por encima de ~25.** Medido contra el backend real: 100 peticiones simultáneas desde una sola IP pasaron a la primera (5,6 s), pero una segunda ráfaga inmediata falló **al 100 %**. Google estrangula por origen. Sin ese límite la prueba mide el estrangulamiento, no tu backend. Cien usuarios reales llegan desde cien redes distintas y no lo disparan.

---

## Ajustes habituales

Todo en `CONFIG`, al principio del archivo.

| Quiero… | Dónde |
|---|---|
| Recuperar el aviso por correo de cada inscripción | `CONFIG.correos.notificarAdministrador = true` |
| Cambiar el límite de 15 cupos | `CONFIG.limiteCupos` + ejecutar `ampliarBloquesParaCupos()` |
| Cambiar la fecha de inicio | `CONFIG.marca.inicioClasesPorDefecto` **y** `lingola-config.js` |
| Permitir el mismo correo en varios grupos | `CONFIG.duplicados.alcance = 'grupo'` |
| Bloquear también por teléfono repetido | `CONFIG.duplicados.porWhatsapp = true` |
| Relajar el filtro de nombres | `RE_NOMBRE` (por defecto no admite dígitos) |

---

## Límites que no dependen de este código

| Límite | Gmail personal | Google Workspace |
|---|---|---|
| Correos al día | **100** | **1 500** |
| Ejecuciones simultáneas | 30 | 30 (igual) |
| Duración por solicitud | 6 min | 6 min (igual) |

Con el aviso al administrador desactivado se envía **1 correo por inscripción**, así que una cuenta Gmail personal da para **100 inscripciones al día**. Lo único que mejora Workspace es esa cuota; la concurrencia es idéntica.

Superadas las 30 ejecuciones simultáneas Google encola las peticiones; el frontend reintenta hasta 4 veces y, como el `submissionId` no cambia, reintentar nunca duplica una inscripción.
