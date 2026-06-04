# Preoperacional / Plan de Viaje · Transhicol

Proyecto **independiente** de `transhicol-manager`. Es un solo `index.html` que los
**conductores** diligencian desde un **link externo** antes de cada servicio y que
guarda los resultados en la **misma base de datos Supabase** que usa la app
(proyecto `fogwynnmbnipsvuxacxw`).

Flujo: el conductor llena la **Inspección Preoperacional** y, al terminar, puede
continuar de inmediato con el **Plan de Viaje** sin salir de la página (los datos del
preoperacional se copian automáticamente). Cada plan de viaje queda enlazado a su
preoperacional.

- El formato solo puede **INSERTAR** (rol `anon` + RLS). No puede leer ni editar nada.
- `transhicol-manager` (menú **PO/PV → Preoperacional / Plan de Viaje**) solo **LEE** los resultados.
- **Solo texto**: no se guardan imágenes ni archivos. Todo son columnas de texto/fecha
  y arreglos JSONB → **no gasta el disco (Storage) de Supabase**.

## 1. Requisito previo (una sola vez)

En Supabase → **SQL Editor**, ejecutar **en orden**:

```
transhicol-manager/supabase/migrations/0015_preoperacional_plan_viaje.sql
transhicol-manager/supabase/migrations/0016_pv_lookup_conductor.sql
```

- **0015** crea las tablas `pv_preoperacionales` y `pv_planes_viaje` con sus
  políticas RLS. (Reutiliza la función `public.is_admin()` de la migración 0001.)
- **0016** crea la función segura `public.pv_lookup_conductor(cedula)` que permite
  **autorrellenar** el preoperacional con el último dato del conductor (licencia y
  seguridad social) sin abrir el `SELECT` al público. Si no la ejecutas, el formato
  sigue funcionando, solo que **no autocompleta**.

## Novedades de este formato

- **Autorrelleno por cédula** (item *Conductor* y *Seguridad social*): al digitar la
  cédula, el sistema recupera la **última licencia** y la **EPS / ARL / AFP** del
  conductor y las precarga (editable, siempre el último dato).
- **Control de licencia**: si la licencia está **vencida**, el campo se marca en rojo
  y **no deja enviar** el preoperacional hasta actualizar la fecha. Si vence en **2
  días o menos**, avisa; con más de 3 días, no muestra nada.
- **Documentos por fecha de vencimiento**: *Documentos del conductor* y *Documentos
  del vehículo* se diligencian con la **fecha de vencimiento** de cada uno. Misma
  regla que la licencia: vencido → **rojo + no deja guardar** (y nombra cuál(es)
  están vencidos); ≤2 días → aviso; >2 días → nada. *Documentos del vehículo*
  conserva el botón **“No aplica”** para los que no requiere ese vehículo.
  Excepción: **Tarjeta Propiedad Cabezote** y **Tarjeta Propiedad Tanque** siguen
  como toggle **CUMPLE / NO CUMPLE / NO APLICA** (sin fecha).
- **Placa del tanque opcional**: si la unidad **no tiene tanque**, el conductor puede
  escribir **N/A** o **“No aplica”** y el formato deja guardar; en ese caso **no se
  almacena** lo escrito (queda vacío). Aplica en preoperacional y en plan de viaje.
- **Kilometraje con separador de miles** (`154.300`) para evitar errores al digitar.
- **Plan de viaje** copia automáticamente del preoperacional la **fecha**, la **placa
  del cabezote** y la **placa del trailer** (si se diligenció).
- **Optimizado para celular**: campos y botones más grandes, las opciones de cada
  ítem y las fechas bajan a una línea completa, y los textos en mayúscula automática.

## 2. Publicar el formato (elige una)

Es un sitio estático de un solo archivo. No requiere build ni variables de entorno:
la URL y la *anon key* (pública por diseño) ya están dentro del `index.html`.

- **Vercel**: arrastra esta carpeta en https://vercel.com/new, o `vercel --prod`.
- **Netlify**: arrastra la carpeta en https://app.netlify.com/drop.
- **Cloudflare Pages / GitHub Pages**: súbela como sitio estático.

## 3. Conectar el link en la app

Cuando tengas la URL pública (ej. `https://preoperacional-transhicol.vercel.app`), pégala en:

```
transhicol-manager/src/views/PopvView.jsx  →  const PV_FORM_URL = '';
```

Así, en el módulo **PO/PV** aparecerán los botones **Link** (copiar) y **Abrir** el formato.

## Modo demo

Si el conductor escribe **DEMO** en su nombre, puede recorrer y enviar todo el formato
**sin que se guarde nada** en la base de datos. Útil para capacitar o probar.

## Estructura de datos (resumen)

`pv_preoperacionales` — datos del conductor, seguridad social, vehículo y 7 listas de
chequeo en JSONB (`documentos_conductor`, `documentos_vehiculo`, `revision_electrica`,
`llantas`, `sistema_frenos`, `accesorios`, `tanque_carroceria`) + resultado calculado
(`total_items`, `items_no_conformes`, `apto`).

`pv_planes_viaje` — fecha, ruta, placas y 4 listas en JSONB (`encabezado`,
`evaluacion_riesgo`, `estados_via`, `compromisos`) + resultado (`alertas`,
`riesgo_nivel`). Enlaza con su preoperacional vía `preoperacional_id`.

## Notas

- La *anon key* es pública por naturaleza (se usa en el navegador). La seguridad real
  la dan las políticas RLS de la migración 0015.
- Cada checklist se guarda como `[{ "item": "...", "valor": "..." }, ...]` en orden.
  Los dos de documentos añaden la fecha: `[{ "item": "...", "valor": "VIGENTE|VENCIDO|NO APLICA", "fecha": "yyyy-mm-dd" }, ...]`.
  El `valor` se deriva de la `fecha` (sin esquema nuevo: siguen siendo columnas `jsonb`).
- Si en el futuro quieres notificación por correo al recibir un registro, hazlo del
  lado servidor con un *Database Webhook* o *Edge Function* (no desde el navegador).
