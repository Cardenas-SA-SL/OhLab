# Guía rápida en español: dos Macs, dos casas, un equipo de agentes

Esta guía es para dos hermanos que viven en casas distintas, cada uno con su Mac, y que quieren
que sus equipos de agentes de programación trabajen juntos a través de OhLab. Va paso a paso y
en orden: primero instalas, después conectas los dos computadores, después armas el equipo y al
final haces que los agentes se hablen. Los textos de la interfaz aparecen en inglés, tal cual se
ven en pantalla, y al lado va la explicación en español.

En la guía llamamos "el dueño" a quien levanta el Hub y comparte el proyecto, y "el hermano" a
quien se une con el código de invitación. Cualquiera de los dos puede ser el dueño.

## 1. Qué es OhLab en tres líneas

- OhLab es una aplicación de escritorio que pone tus terminales y tus agentes de programación
  (Claude Code, Codex, Gemini, Copilot, opencode, Grok) sobre un lienzo infinito, como un mapa, y
  mantiene cada sesión viva aunque cierres la aplicación o reinicies el Mac.
- Trae un "Hub" propio: con él, dos computadores en casas distintas se encuentran, comparten un
  proyecto y cada uno ve en una pestaña, en vivo, los agentes del otro.
- Con la mensajería activada, tus agentes pueden leer lo que hicieron los agentes de tu hermano y
  mandarles mensajes, todo cifrado de extremo a extremo entre los dos Macs; el Hub solo los
  presenta, no puede leer terminales ni conversaciones.

## 2. Instalar el DMG

### Cuál descargar

OhLab funciona en macOS 12 o posterior. Hay dos instaladores y tienes que bajar el que
corresponde a tu procesador:

1. Abre el menú Apple (arriba a la izquierda) y elige **Acerca de este Mac**.
2. Si dice **Chip: Apple M1**, M2, M3 o M4, tu Mac es Apple Silicon: descarga
   `OhLab-<versión>-arm64.dmg` (por ejemplo `OhLab-0.3.4-arm64.dmg`).
3. Si dice **Procesador: Intel Core**, tu Mac es Intel: descarga `OhLab-<versión>-x64.dmg`.

Los dos archivos están en la página de versiones:
<https://github.com/Cardenas-SA-SL/OhLab/releases>. Abre el DMG y arrastra **OhLab** a
**Aplicaciones**.

### Primera apertura (la aplicación no está firmada)

OhLab todavía se distribuye sin firma de Apple Developer ID, así que la primera vez macOS bloquea
el doble clic con un aviso del tipo "no se puede abrir porque proviene de un desarrollador no
identificado". Autorízalo una sola vez con cualquiera de estos dos métodos:

1. En Finder, abre **Aplicaciones**, haz clic derecho (o Control-clic) sobre **OhLab**, elige
   **Abrir** y confirma **Abrir** en el aviso.
2. O en Terminal quita el atributo de cuarentena y ábrela normalmente:

   ```sh
   xattr -dr com.apple.quarantine /Applications/OhLab.app
   ```

Usa ese comando solo con un DMG bajado del repositorio oficial de OhLab.

### Permisos que puede pedir macOS

- **Micrófono**: lo necesita el dictado por voz (sección 6). Si lo rechazas, lo puedes activar
  después en Ajustes del Sistema > Privacidad y seguridad > Micrófono.
- **Red local**: permite que terminales y agentes se conecten a servicios y equipos de tu red.
  Acéptalo; el Hub y las sesiones entre los dos Macs usan la red.
- **Notificaciones**: opcional, pero conviene aceptarlas: así el dueño se entera al instante
  cuando su hermano pide unirse al proyecto, y ambos saben cuando un agente termina.
- Si tienes activado el cortafuegos de macOS, cuando el dueño encienda el Hub puede aparecer
  "¿Quieres que la aplicación OhLab acepte conexiones de red entrantes?". Elige **Permitir**.

### Actualizaciones

OhLab avisa dentro de la aplicación cuando hay una versión nueva. Como las versiones no están
firmadas, a veces tendrás que bajar el DMG nuevo, reemplazar la copia de Aplicaciones y repetir la
primera apertura. Tus proyectos y ajustes no se pierden.

## 3. Conectar los dos Macs

Los dos computadores están en casas distintas, detrás de routers distintos, así que necesitan
una forma de alcanzarse. La recomendada es Tailscale.

### Opción recomendada: Tailscale en ambos Macs

Tailscale crea una red privada entre tus equipos, cifrada, sin abrir puertos en el router y sin
configurar nada en él. Hazlo en los dos Macs:

1. Descarga Tailscale desde <https://tailscale.com/download/mac> (sirve la versión de la App
   Store o la descarga directa) e instálala.
2. Ábrela e inicia sesión. Los dos hermanos deben usar **la misma cuenta** (Google, Apple,
   Microsoft o GitHub, la que prefieran). Con una sola cuenta, ambos Macs quedan en la misma red
   privada automáticamente.
3. Haz clic en el ícono de Tailscale en la barra de menús. Debe decir **Connected**, y en la
   lista de equipos (**Network Devices**) tienen que aparecer los dos Macs, cada uno con una
   dirección que empieza por `100.` (por ejemplo `100.101.102.103`). También puedes verlos en
   <https://login.tailscale.com/admin/machines>.
4. Prueba desde Terminal que se ven: `ping 100.x.y.z` con la dirección del otro Mac. Si responde,
   listo.

OhLab reconoce Tailscale solo: cualquier dirección entre `100.64.0.0` y `100.127.255.255` aparece
etiquetada como **Tailscale** en Ajustes > Team (mira las interfaces de red y, si el comando
`tailscale` está en el PATH, también consulta `tailscale ip -4`).

Tailscale tiene que estar conectado en los dos Macs cada vez que quieran trabajar juntos. Si uno
lo apaga, el otro lo ve como "offline" en OhLab.

### Alternativa: abrir un puerto en el router del dueño

Si Tailscale no es opción, el dueño puede abrir el puerto del Hub en su router:

1. En el router del dueño, redirige el puerto **TCP 8791** a la dirección local de su Mac (por
   ejemplo `192.168.1.20`) y reserva esa dirección en el DHCP para que no cambie.
2. En OhLab, Ajustes > Team, escribe en **Hub URL** `http://<IP pública del dueño>:8791` y pulsa
   **Connect** antes de compartir el proyecto. El código de invitación copia lo que hay en
   **Hub URL** (salvo cuando es `127.0.0.1`, que se reemplaza por la primera dirección detectada),
   así que de este modo el hermano recibe la dirección pública.

Es más frágil que Tailscale: la IP pública puede cambiar, algunos routers no permiten que el
propio Mac del dueño salga y vuelva a entrar por su dirección pública, y el tráfico con el Hub va
en HTTP plano (las sesiones entre los dos Macs sí van cifradas de extremo a extremo). OhLab nunca
abre puertos por su cuenta.

Tercera opción, para más adelante: un Hub independiente siempre encendido en un servidor (VPS o
Docker). Está explicado en [docs/HUB.md](./HUB.md).

## 4. Flujo de equipo paso a paso

Todo pasa en **Ajustes** (`⌘,`), sección **Team**. El panel dice arriba: "Connect to your
self-hosted OhLab Hub and share projects with approved members. Every member sees every other
member's agents." (conéctate a tu propio Hub y comparte proyectos con miembros aprobados; cada
miembro ve los agentes de todos los demás).

Así se ve el panel de arriba hacia abajo:

- Un interruptor **Host a hub on this computer** con la nota "Binds every network interface.
  OhLab never opens router ports automatically." (escucha en todas las interfaces de red; nunca
  abre puertos del router).
- Un campo **Hub port** (puerto, por defecto `8791`).
- Las direcciones detectadas del Hub y un enlace **Hub setup help** (ayuda de configuración).
- **Hub URL** y **Account name** con el botón **Connect** y, a su derecha, el estado.
- El bloque **Join with an invite code** (unirse con un código de invitación).
- Solo cuando estás conectado: el bloque **Share this project** (compartir este proyecto), la fila
  **Agent messaging for this project** (mensajería entre agentes para este proyecto) y una tarjeta
  por cada proyecto compartido con sus miembros.

### Paso 1: el dueño enciende el Hub

1. El dueño activa **Host a hub on this computer**. El campo **Hub URL** se rellena solo con
   `http://127.0.0.1:8791` (es su propio Hub) y **Hub port** queda en `8791`.
2. Debajo aparecen las direcciones donde escucha el Hub, una por línea:
   - **Tailscale:** `http://100.x.y.z:8791`: esta es la buena.
   - **Local network only:** `http://192.168.x.y:8791 - reachable from another home only through
     Tailscale or a port forward` (solo red local; desde otra casa solo se alcanza con Tailscale o
     un puerto abierto).
   - Si dice `Hub host: starting`, espera un momento. Si dice `Hub host: error - ...`, mira la
     sección 7.
   - Si dice "Listening on port 8791, but no non-loopback IPv4 address was found.", el Mac no
     tiene red.
3. Elegir la dirección Tailscale: no hay que seleccionarla a mano. El código de invitación usa la
   **primera** dirección de la lista, y las de Tailscale siempre van primero. Lo único que tienes
   que comprobar es que exista una línea que empiece por **Tailscale:**. Si solo ves **Local
   network only**, detente y revisa Tailscale (sección 3) antes de seguir.

### Paso 2: el dueño se conecta con su nombre

1. En **Account name** escribe tu nombre, por ejemplo `Sebastián`. Es el nombre que verá tu hermano
   y el que llevará tu pestaña en su Mac. No hay contraseña: OhLab prueba su identidad con una
   llave que guarda en este Mac.
2. Pulsa **Connect**. El texto al lado del botón pasa de `connecting` a
   `connected as Sebastián on <nombre de tu Mac>`. Si queda en `error`, abajo aparece el motivo en
   rojo (sección 7).

### Paso 3: el dueño comparte el proyecto

1. Abre (o crea) el proyecto que quieres compartir y déjalo como pestaña activa. Ese proyecto será
   "tu lado" del proyecto compartido: lo que tu hermano verá son los agentes que abras ahí.
2. Vuelve a Ajustes > Team. Bajo el título **Share this project** pulsa el botón **Share this
   project**. La nota explica: "Hosts the current project for approved members and opens each
   member's copy as a tab here, as soon as they are online. Approving a member connects both
   ways." (publica el proyecto actual para los miembros aprobados y abre aquí, como pestaña, la
   copia de cada miembro cuando esté en línea; aprobar a un miembro conecta en ambos sentidos).
3. El botón se reemplaza por un campo de solo lectura con el código `ohlab-invite:...`, el botón
   **Copy invite** (copiar invitación) y el botón **Regenerate** (generar uno nuevo). Pulsa **Copy
   invite** y mándale el código a tu hermano por el medio que quieras. Es una sola línea larga;
   envíala completa, sin cortes.
4. Debajo aparece la tarjeta del proyecto: su nombre, `your side: "<nombre>" · 1 members` y tu
   fila con un punto verde, tu nombre en negrita, `· owner · approved` y la lista de agentes de tu
   lienzo (`N agents`, cada uno con `RUNNING`, `NEEDS YOU` o `idle`).

Qué lleva el código: `ohlab-invite:` seguido de un texto codificado que contiene la dirección del
Hub, el identificador del proyecto, una clave de 12 caracteres y el nombre del proyecto (por
dentro es un enlace `ohlab://join?v=1&hub=...&project=...&code=...&name=...`). Si alguna vez
pulsas **Regenerate**, el código anterior deja de servir y tienes que mandar el nuevo.

### Paso 4: el hermano se une

1. El hermano ya instaló OhLab (sección 2) y Tailscale (sección 3). Abre Ajustes > Team. No
   activa **Host a hub on this computer**: el Hub ya lo tiene el dueño.
2. En el bloque **Join with an invite code** pega el código en el campo con la pista
   `ohlab-invite:...` (si abrió un enlace `ohlab://`, el campo ya viene rellenado) y escribe su
   nombre en **Your name**, por ejemplo `Jorge`.
3. Elige su lado local bajo `My side of "<proyecto>"` (mi lado del proyecto):
   - **Create an empty project named "<proyecto>"**: crea en su Mac un proyecto vacío con el
     nombre del proyecto compartido. Es la opción por defecto y la recomendada la primera vez.
   - **Use the current project as my side ("<proyecto activo>")**: usa el proyecto que tiene
     abierto ahora, si ya tiene ahí sus agentes y quiere mostrarlos.
   La nota dice: "Members see the agents on your side; you see theirs. The binding stays on this
   mac and is never written into the shared project file." (los miembros ven los agentes de tu
   lado y tú los de ellos; el vínculo se queda en este Mac y nunca se escribe en el archivo del
   proyecto compartido).
4. Pulsa **Join**. Si antes había otro Hub configurado, aparece la pregunta
   "This invite uses http://... Switch from ...?" (esta invitación usa otro Hub, ¿cambiar?):
   acepta. El estado pasa a `connected as Jorge on <su Mac>` y aparece el texto:
   `Waiting for the owner to approve <proyecto>. "<lado>" is your side of it; both computers also
   need agent messaging enabled.` (esperando que el dueño apruebe; ese proyecto es tu lado; los
   dos computadores además necesitan la mensajería entre agentes activada).
5. En la tarjeta del proyecto su fila dice `· member · pending · waiting for approval`. Si eligió
   crear un proyecto vacío, ya tiene una pestaña nueva con ese nombre: ahí abre sus agentes.

### Paso 5: el dueño aprueba

1. Al dueño le llega una notificación de macOS: "**Jorge wants to join <proyecto>**" con el texto
   "Open Settings > Team to approve or decline." Al hacer clic se abren los Ajustes.
2. En la tarjeta del proyecto, la fila de Jorge dice `· member · pending` y tiene dos botones:
   **Approve** (aprobar) y **Decline** (rechazar). Pulsa **Approve**.
3. Al aprobar, OhLab fija la llave pública de Jorge; desde ahora solo ese Mac con esa llave puede
   entrar como Jorge. Más adelante, el botón **Remove** en su fila lo saca del proyecto, revoca la
   llave y cierra la sesión.
4. En el Mac de Jorge el texto cambia a: "Approved. The owner's agents open as a tab as soon as
   they are online, and yours open for them." (aprobado; los agentes del dueño se abren como
   pestaña en cuanto esté en línea, y los tuyos se abren para él).

### Paso 6: las pestañas se abren solas

En pocos segundos, y sin que nadie pulse nada, aparece una pestaña nueva en la barra de pestañas
de los dos Macs:

- En el Mac del dueño: **`<proyecto> · Jorge`**.
- En el Mac de Jorge: **`<proyecto> · Sebastián`**.

Se abren en segundo plano y nunca te quitan la vista en la que estás trabajando. Haz clic en la
pestaña y verás el lienzo del otro en vivo: sus nodos, sus terminales y las insignias de estado
de cada agente (`RUNNING`, `NEEDS YOU`).

Para que la pestaña de un miembro se abra tienen que cumplirse tres cosas a la vez: está
aprobado, está en línea y los dos tienen un lado local vinculado. En la tarjeta del proyecto, la
fila de cada miembro te dice en qué está:

- Punto verde = en línea; punto gris = fuera de línea.
- Después del nombre: `· <nombre de su Mac> · member · approved`.
- `waiting for approval`: todavía pendiente de aprobación.
- `not sharing an agent canvas yet`: aún no tiene un lado local (no compartió ni eligió lado al
  unirse).
- `offline`: fuera de línea.
- `connecting…`: conectando.
- `tab closed`: cerraste su pestaña (ver más abajo).
- `reconnecting` en ámbar: su pestaña se cayó y OhLab está reconectando.
- Debajo, `N agents` con la lista de sus agentes y el estado de cada uno, o `No agents open.`
- Botones **Close** (cerrar su pestaña) u **Open** (abrirla; desactivado mientras está fuera de
  línea, con la pista "This member is offline").

### Qué significa una pestaña en gris

Una pestaña de miembro en gris significa que la conexión con ese Mac se cortó: cerró OhLab, el Mac
se durmió, apagó Tailscale o se le fue la red. Al pasar el cursor por encima dice
"<nombre> disconnected, click to reconnect". En Team, su fila muestra `reconnecting` y `offline`.

No tienes que hacer nada: OhLab reintenta solo con esperas de 1, 2, 4, 8, 15 y 30 segundos (hasta
8 intentos) y, si el miembro sigue fuera, espera a que el Hub avise que volvió y reconecta al
instante. Hacer clic en la pestaña gris también fuerza un reintento. Mientras esté en gris, los
agentes no pueden leer ni enviar mensajes a los nodos de ese miembro (la respuesta es
"member offline").

Cerrar la pestaña (`⌘W` o la x) es distinto: significa "ahora no". OhLab lo recuerda en este Mac
(`hubMutedMembers` en `settings.json`), la fila del miembro pasa a decir `tab closed` y la pestaña
no vuelve a abrirse sola hasta que pulses **Open** en esa fila. El botón **Close** de Team hace lo
mismo que cerrar la pestaña.

### Verificación de identidad (el "verify code")

Al pulsar **Approve**, el Hub fija la llave pública del hermano y cada sesión entre los dos Macs
es un túnel cifrado de extremo a extremo que se comprueba contra esa llave en los dos lados: el
cliente confirma solo y el anfitrión rechaza cualquier túnel cuya llave no coincida con la del
directorio. El Hub solo presenta a los dos; no puede leer terminales, conversaciones ni el lienzo.

Para que no tengas que confiar a ciegas en el Hub, desde la primera sesión entre ustedes la fila
de cada miembro en **Team** muestra `· verify code 123 456`. Ese número se deriva de las llaves
de los dos y es el mismo en las dos pantallas solo si el Hub le dio a cada uno la llave real del
otro. Compárenlo una vez por WhatsApp o teléfono; si no coincide, pulsa **Remove** en esa fila,
**Regenerate** y comparte el código nuevo solo con tu hermano. Si la llave de un miembro cambia
más adelante (por ejemplo, reinstaló OhLab), la app rechaza la sesión, te avisa con una
notificación y muestra el motivo en rojo en Team: hay que quitarlo y volver a invitarlo.

El diálogo "Verify this code matches the one shown on the host:" solo aparece con los **códigos de
emparejamiento manuales** de Ajustes > Remote (campo **Pairing code**), pensados para el teléfono
o para una sesión puntual. No lo verás al usar invitaciones del Hub.

## 5. Que los agentes se hablen

### Activar el interruptor de mensajería en los dos Macs

La mensajería entre agentes es un permiso por proyecto, apagado por defecto, y tiene que estar
encendido en **los dos computadores**: el dueño en su proyecto compartido y el hermano en su lado
(el proyecto "<proyecto>" que se creó al unirse, o el que eligió como lado). Hay dos sitios para
encenderlo y son el mismo ajuste:

- Ajustes > Team, fila **Agent messaging for this project**, botón **Enable** (pasa a
  **Enabled**). La nota dice: "Enable this on both computers for cross-machine agent messages."
  (actívalo en los dos computadores para mensajes entre máquinas).
- Ajustes > Agents, interruptor **Let agents message other agents in this project** (permitir que
  los agentes envíen mensajes a otros agentes de este proyecto). Su descripción avisa que el texto
  del mensaje entra en la conversación del agente que lo recibe, así que un mensaje puede intentar
  dirigirlo; que solo se entrega a agentes ociosos y verificados; que hay un límite de envíos por
  remitente y que cada entrega deja rastro.

El ajuste se guarda en el archivo del proyecto, `.nodeterm/project.json`, y ese archivo viaja con
el repositorio: "This setting is saved in the project file (.nodeterm/project.json), so if you
commit it, everyone who clones the repo gets it too." (si lo confirmas en git, quien clone el
repositorio lo recibe encendido). Por eso, si un proyecto llega con el interruptor ya encendido,
OhLab pregunta antes de obedecerlo:

> The project "<nombre>" arrived with "Let agents message other agents in this project" already
> switched on - it came from the project file, not from you. Keep it on?

con los botones **Keep it on** (dejarlo encendido) y **Turn it off** (apagarlo). Hasta que
respondas **Keep it on**, los mensajes se rechazan.

### Cómo lo usan los agentes

No tienes que instalar nada: OhLab instala la habilidad `manage-ohlab-canvas` para Claude Code y
bloques de instrucciones equivalentes para Codex (`~/.codex/AGENTS.md`), Gemini
(`~/.gemini/GEMINI.md`), Copilot y opencode. El programa que usan los agentes es
`~/Library/Application Support/OhLab/canvas-control/ohlab.sh`, y lo llaman como
`sh "<ruta>/ohlab.sh" <verbo> [opciones]`. En esta guía lo abreviamos como `ohlab <verbo>`.

Tú solo pides las cosas en lenguaje normal, por ejemplo: "Revisa qué hizo el agente de mi hermano
en el backend y pídele que exporte el esquema de la base de datos". Esto es lo que escribe el
agente por detrás:

**Ver quién hay.** `ohlab list` devuelve una fila por nodo, incluidos los de las pestañas de los
otros miembros. Las filas ajenas llevan el miembro, su Mac y si está en línea:

```
node-3 [terminal] Backend API
node-9 [terminal] Frontend - Jorge / MacBook-de-Jorge (online)
node-12 [terminal] Pruebas - Jorge / MacBook-de-Jorge (online) - LINKED
```

**Enlazar para leer.** `ohlab link --to node-9` crea un enlace de contexto con ese nodo. Nada se
envía al otro agente: el enlace solo permite leer. Con el enlace hecho, el agente lee lo que hizo
el otro con la habilidad `ohlab-linked-context`, que trae su propio comando con tres verbos:

```
summary --node node-9      # las últimas líneas de su conversación
transcript --node node-9   # la conversación completa
terminal --node node-9     # lo que se ve en su terminal
```

Si el miembro está fuera de línea, el enlace se rechaza con "member offline".

**Enviar un mensaje.**

```
ohlab send --node node-9 --text 'Hola, soy el agente de Sebastián. ¿Puedes exportar el esquema de la base de datos a docs/schema.sql y avisarme cuando esté?'
```

El mensaje se entrega cuando el agente destino está ocioso en su indicador. Si está ocupado, no se
interrumpe ni se pierde: queda en cola (`queued`) y se entrega cuando termine su turno
(`delivered`). Al otro lado llega enmarcado, para que el agente sepa que viene de fuera:

```
--- NODETERM MESSAGE <código> ---
from: node-3
reply-to: node-3
Hola, soy el agente de Sebastián. ...
--- END NODETERM MESSAGE <código> ---
```

**Responder.** El agente que recibió el mensaje contesta con el identificador de `reply-to:`:

```
ohlab reply --node node-3 --text 'Listo: docs/schema.sql quedó en la rama feat/schema.'
```

Límites: un mensaje por cada par remitente-destino cada 10 segundos y como máximo 4 entregas por
turno. Cada respuesta del comando dice si vale la pena reintentar ("Retryable - wait, then try
once more.") o no ("Do not retry."); los agentes están instruidos para creerle a esa respuesta.

### Las tres reglas

1. **El interruptor tiene que estar encendido en los dos lados**: en el proyecto del agente que
   envía y en el proyecto que aloja al agente que recibe. Si falta uno, la respuesta es
   `notPermitted (switch-off): agent messaging is switched off for this project (Settings → Agents
   enables it per project).`
2. **El agente destino tiene que haber tenido al menos un turno.** OhLab solo entrega a un agente
   que ya reportó su estado y está ocioso. Un nodo recién abierto al que nadie le ha escrito
   responde `targetStatusStale` (tiene identidad pero aún no reportó estado; reintentable) o
   `targetNotIdleUnknown: no status has ever been posted for this node`. Solución: dale una
   primera tarea escribiéndole tú mismo, espera a que termine y reintenta.
3. **Después de reiniciar OhLab, reinicia el agente.** Al reiniciar la aplicación, los nodos se
   vuelven a enganchar a sus sesiones de tmux que siguieron vivas, y OhLab ya no puede probar qué
   proyecto los creó (es una protección deliberada contra proyectos clonados con identificadores
   ajenos). El nodo muestra una insignia `!` con la pista "Not messageable until restarted. Use
   Restart agent in the node menu." y los envíos responden `notPermitted (unproven-target-owner)`.
   Solución: clic derecho en el nodo > **Restart agent** (la conversación continúa donde iba) o,
   para todos a la vez, clic derecho en el lienzo > **Restart idle agent sessions**. Reiniciar el
   Mac completo también lo deja limpio, porque arranca sesiones nuevas.

## 6. Voz: mantén ⌘⌥ y habla

1. Selecciona un nodo de terminal o de agente.
2. Mantén presionadas **Comando y Opción** (`⌘⌥`) y habla. Suelta las teclas y OhLab transcribe e
   inserta el texto en el nodo **sin enviarlo**: lo revisas y pulsas Intro tú.
3. La primera grabación pide el permiso del micrófono: elige **Permitir**.
4. El modelo de reconocimiento es Whisper `small`, multilingüe, y viene seleccionado por defecto;
   se descarga solo la primera vez, con una barra de progreso. Todo corre en tu Mac: tu voz no sale
   del computador.

En Ajustes > **Speech** puedes cambiar: **Engine** (`Local Whisper`; `Cloud` aún no está
disponible), **Shortcut** (por defecto es mantener `⌘⌥`; se cambia en Keyboard Shortcuts),
**Whisper models** (descargar o borrar modelos: `tiny`, `base`, `small`, `large`...) y
**Language** (déjalo en automático o fíjalo en español si dicta mal).

## 7. Problemas frecuentes

| Síntoma | Causa | Solución |
| --- | --- | --- |
| macOS no deja abrir OhLab ("desarrollador no identificado") | La aplicación no está firmada | Clic derecho > **Abrir**, o `xattr -dr com.apple.quarantine /Applications/OhLab.app` (sección 2) |
| `Hub host: error - ...` con `EADDRINUSE` | Otro programa usa el puerto 8791 | Cambia **Hub port** (por ejemplo `8792`) y vuelve a copiar la invitación |
| Solo aparece **Local network only**, no hay línea **Tailscale** | Tailscale no está conectado en el Mac del dueño, o no tiene dirección todavía | Abre Tailscale, comprueba **Connected**, apaga y enciende **Host a hub on this computer** |
| "Listening on port 8791, but no non-loopback IPv4 address was found." | El Mac no tiene red | Conecta a la red y vuelve a activar el Hub |
| `error` junto a **Connect** con "Enter an account name before connecting to the Hub." | Falta el nombre | Rellena **Account name** y pulsa **Connect** |
| Hub no alcanzable: `error`, "Hub directory connection closed", o el hermano se queda en `connecting` | Tailscale caído en uno de los dos, cortafuegos bloqueando 8791, o la invitación lleva `127.0.0.1` o una dirección `192.168.x.y` de la casa del dueño | Revisa que ambos estén **Connected** en Tailscale, que el dueño vea **listening** con una línea **Tailscale**, y vuelve a copiar la invitación después de arreglarlo |
| "That invite code is invalid or incomplete." al pulsar **Join** | El código llegó cortado, le falta el prefijo `ohlab-invite:` o tiene espacios | Pide que lo reenvíen completo y pégalo entero en el campo `ohlab-invite:...` |
| "invite code not found" después de pulsar **Join** | El dueño pulsó **Regenerate** y ese código ya no vale | Pide el código nuevo |
| "That pairing code is invalid or incomplete." | Pegaste la invitación `ohlab-invite:` en el campo **Pairing code** de Ajustes > Remote, que es otra cosa | Pégala en Ajustes > Team > **Join with an invite code** |
| "Set the OhLab Hub URL in Settings > Team" | Se intentó abrir una sesión remota sin Hub configurado | Une o conecta primero en Ajustes > Team |
| La fila del hermano sigue en `pending · waiting for approval` | El dueño no ha aprobado, o no está conectado | El dueño abre Ajustes > Team y pulsa **Approve** |
| `not sharing an agent canvas yet` | Ese miembro no tiene lado local vinculado | El dueño pulsa **Share this project** con el proyecto abierto; el hermano se une eligiendo un lado en **My side of ...** |
| Pestaña en gris, `reconnecting`, `offline` | El otro Mac cerró OhLab, se durmió o perdió Tailscale | Abre OhLab en ese Mac y comprueba `connected` en Team; la pestaña reconecta sola (o haz clic en ella) |
| La pestaña del hermano no vuelve a aparecer y la fila dice `tab closed` | La cerraste y OhLab lo recordó | Pulsa **Open** en su fila de Team |
| `memberOffline: <nombre> is offline. Do not retry.` o "member offline" al enlazar | La pestaña del miembro está en gris | Espera a que reconecte; el agente no debe reintentar |
| `notPermitted (switch-off)` | Falta la mensajería en uno de los dos computadores | Activa **Agent messaging for this project** en el Mac que aloja al agente destino (y en el tuyo) |
| `notPermitted (unproven-target-owner)` e insignia `!` en el nodo | OhLab se reinició y el agente se volvió a enganchar sin prueba de dueño | Clic derecho en el nodo > **Restart agent** |
| `targetStatusStale` | El agente destino aún no reportó un estado verificado | Dale un turno (escríbele una tarea), espera a que termine y reintenta |
| `targetNotIdleUnknown: no status has ever been posted for this node` | El nodo nunca completó un turno | Igual que arriba |
| `targetBusy` | El destino está en medio de un turno | Nada: el mensaje queda en cola y se entrega cuando termine |
| `rateLimited: ... retry after N ms` | Más de un mensaje al mismo destino en 10 segundos | Esperar lo que indica |
| `targetStatusUnverified` | El nodo no tiene identidad en este Mac | Relanza el nodo desde el escritorio o abre su proyecto y reintenta |
| `targetHookScriptStale` | El agente arrancó con un guion de estado antiguo | Reinicia OhLab en ese Mac y luego el agente |
| `notPermitted (cross-project)` | El destino no pertenece al mismo proyecto compartido | Comprueba el identificador con `ohlab list`; solo se puede escribir a nodos del proyecto compartido |
| Aparece el diálogo "arrived with ... already switched on" | El proyecto llegó con la mensajería encendida desde el archivo | Responde **Keep it on** si es tu proyecto; **Turn it off** si no lo esperabas |
| El dictado no graba | Micrófono denegado | Ajustes del Sistema > Privacidad y seguridad > Micrófono > activa OhLab |

## 8. Dónde pedir ayuda

- Abre un reporte en <https://github.com/Cardenas-SA-SL/OhLab/issues>. Indica la versión de OhLab
  (menú OhLab > About), si tu Mac es Apple Silicon o Intel, y copia el texto exacto que ves en rojo
  en Ajustes > Team o la respuesta completa del comando `ohlab` que falló.
- La documentación del Hub, con la configuración de Tailscale y el Hub independiente, está en
  [docs/HUB.md](./HUB.md); la instalación en [docs/INSTALL.md](./INSTALL.md) y el dictado en
  [docs/VOICE.md](./VOICE.md).
