# Voice dictation

## English

Select a terminal or agent node, then hold **Command-Option** (`⌘⌥`) and speak. Release or press the chord again to transcribe and insert the text without submitting it. The multilingual Whisper `small` model is selected by default and downloads with progress on first use. All available Whisper models are free and run on-device; Settings > Speech keeps manual model and language controls.

On macOS, the first recording shows the system microphone permission prompt. Select **Allow**. If it was denied, open System Settings > Privacy & Security > Microphone, enable OhLab, and try again.

## Español

Selecciona un nodo de terminal o agente, mantén presionadas **Comando-Opción** (`⌘⌥`) y habla. Suelta o vuelve a presionar el atajo para transcribir e insertar el texto sin enviarlo. El modelo multilingüe Whisper `small` viene seleccionado y se descarga con progreso la primera vez. Todos los modelos Whisper disponibles son gratuitos y funcionan localmente; puedes cambiar el modelo y el idioma en Settings > Speech.

En macOS, la primera grabación muestra el permiso del micrófono. Selecciona **Permitir**. Si lo rechazaste, abre Configuración del Sistema > Privacidad y seguridad > Micrófono, activa OhLab e inténtalo de nuevo.

# Voice conversation (hands-free voice mode)

## English

Dictation is one take at a time. **Voice conversation** is a loop you can run without reading or typing, the way a voice assistant works: an agent node keeps listening, sends what you say when you pause, and reads the agent's answer aloud. It works with every agent whose turns OhLab can hear end and whose transcript it can read (Codex, Claude Code, Gemini, opencode, Grok).

### How to start

- Click the **headset** in the header of an agent node, choose **Voice conversation** in the node's right-click menu, or use the same button in the kanban card popup. A remappable shortcut, *Toggle voice conversation* (Settings > Keyboard Shortcuts), does the same on the focused or selected node; it ships unbound.
- The first time, the Whisper model downloads with the usual progress, and macOS asks for the microphone once.
- Only one node listens at a time. Turning it on somewhere else moves the conversation there. Turning it off (the headset again, **Stop** on the overlay, **Escape**, closing the node, hibernating or pausing its session, switching projects, or losing the input device) stops everything and releases the microphone.

### The voice-mode overlay

While the conversation is on, a panel covers the node's terminal (and the card popup on the board) with an **orb** whose motion is the state: breathing blue = **Listening**, green ripples = **Hearing you**, a spinning arc in clay = **Transcribing / Thinking**, purple pulses = **Speaking**, still grey = **Paused**. Under it you see the sentence that was heard and the sentence being spoken, so you can check the loop without ever having to read it. Three controls: **Pause** (mutes the loop until Resume), **Stop**, and **Show on screen** (the panel steps aside so you see the terminal; the small chip beside the node's status badges stays, and clicking it brings the panel back). **Escape** ends the conversation.

### What happens in a turn

- You speak; after about 0.7 s of silence the utterance is transcribed with your dictation model and language and **sent to the agent as a prompt**. Fragments under two words are ignored.
- With **Answer for speech** on (Settings > Speech > Voice conversation, default on), the prompt is wrapped in a short instruction the agent follows: reply in 1 to 3 short sentences in your language, no code, lists or markdown; if the answer needs code or is long, summarize it aloud and ask whether you want to see it on screen. The rules behind that tag (`[Modo voz]` / `[Voice mode]`) are installed once into each agent's global instructions (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, opencode's `AGENTS.md`, and a `~/.claude/skills/ohlab-voice-mode` skill for Claude) with a marker-delimited block that leaves everything else in those files alone.
- When the agent's turn ends, OhLab reads the **last assistant message from the agent's own transcript on disk**, cleans it up for speech and reads it **sentence by sentence** with a system voice — the first sentence starts while the rest is still queued. Then it is listening again: if the agent asked a question, just answer.
- If the agent stops on a permission prompt instead, you hear that it needs you on screen.
- Speaking while the app talks (**barge-in**) cuts the reply within a fraction of a second and goes back to listening.

### What is spoken and what is skipped

Prose, headings, list items, link text and inline code are read. Fenced code blocks are replaced by "code omitted", URLs by "link", tables by "table omitted". A long reply is cut near 1500 characters and ends with "…and it continues on screen". Markdown syntax and HTML are dropped. With **Speak replies** off, the loop still listens and submits and the reply is only shown.

### Voices

Settings > Speech > **Voice conversation** lists the system voices for your reply language (the dictation language, or the system language under Auto-detect). **Default** picks the best one: Premium and Enhanced voices first, then — for Spanish — es-CL, es-MX, es-ES. macOS ships compact voices; the much better **Enhanced** and **Premium** tiers are free downloads: System Settings > Accessibility > Spoken Content > System voice > **Manage Voices…**, pick a language, download the voices marked Enhanced or Premium, and they appear in the picker (or as the new Default) on the next conversation. *Rate* and *Test voice* are there too.

### Latency

Measured on an Apple M5 Max (Metal), a 5.8 s Spanish sentence transcribes in about 0.3 s with `small` (0.2 s with `base`, 0.1 s with `tiny`); the first transcription after launch adds the model load (about 0.7 s for `small`). `small` is also the only tier that spells "muéstrame" correctly, so voice mode uses your dictation model as is. Replies start speaking as soon as the transcript is on disk.

### Headphones recommended

The reply comes out of your speakers while the microphone is open. While the app speaks, the listener raises its threshold so speaker output does not re-trigger it, but it is an energy gate, not echo cancellation: with laptop speakers turned up, a loud reply can still be heard as you talking (and cut itself off). Headphones remove the problem entirely.

### Privacy

Nothing leaves your machine. Speech recognition is whisper.cpp running locally, the voice is the operating system's speech synthesizer, and the reply is read from the transcript file the agent already writes on your disk. The microphone is open only while the overlay or chip is visible and not paused.

## Español

El dictado es una toma a la vez. La **conversación por voz** es un ciclo que puedes usar sin leer ni escribir, como un asistente de voz: un nodo de agente se queda escuchando, envía lo que dices cuando haces una pausa y lee en voz alta la respuesta del agente. Funciona con todos los agentes cuyos turnos OhLab puede detectar y cuya transcripción puede leer (Codex, Claude Code, Gemini, opencode, Grok).

### Cómo empezar

- Pulsa el **auricular** en la cabecera de un nodo de agente, elige **Voice conversation** en el menú contextual del nodo o usa el mismo botón en la tarjeta del kanban. El atajo remapeable *Toggle voice conversation* (Settings > Keyboard Shortcuts) hace lo mismo sobre el nodo enfocado o seleccionado; viene sin asignar.
- La primera vez se descarga el modelo Whisper con el progreso habitual y macOS pide el micrófono una sola vez.
- Solo un nodo escucha a la vez. Activarlo en otro nodo mueve la conversación allí. Desactivarlo (el auricular de nuevo, **Stop** en el panel, **Escape**, cerrar el nodo, hibernar o pausar su sesión, cambiar de proyecto o perder el dispositivo de entrada) detiene todo y libera el micrófono.

### El panel de modo voz

Mientras la conversación está activa, un panel cubre la terminal del nodo (y la tarjeta en el tablero) con una **esfera** cuyo movimiento es el estado: azul respirando = **escuchando**, ondas verdes = **te oigo**, arco girando en color arcilla = **transcribiendo / pensando**, pulsos morados = **hablando**, gris quieta = **en pausa**. Debajo ves la frase que se oyó y la que se está diciendo, para comprobar el ciclo sin tener que leer nunca. Tres controles: **Pause** (silencia el ciclo hasta reanudar), **Stop** y **Show on screen** (el panel se aparta para que veas la terminal; queda el pequeño indicador junto a las insignias del nodo, y al pulsarlo vuelve el panel). **Escape** termina la conversación.

### Qué pasa en un turno

- Hablas; tras unos 0,7 s de silencio la frase se transcribe con tu modelo e idioma de dictado y **se envía al agente como prompt**. Los fragmentos de menos de dos palabras se ignoran.
- Con **Answer for speech** activado (Settings > Speech > Voice conversation, activado por defecto), el prompt va envuelto en una instrucción corta que el agente sigue: responder en 1 a 3 frases cortas en tu idioma, sin código, listas ni markdown; si la respuesta necesita código o es larga, resumirla en voz y preguntar si quieres verla en pantalla. Las reglas detrás de esa etiqueta (`[Modo voz]` / `[Voice mode]`) se instalan una vez en las instrucciones globales de cada agente (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, el `AGENTS.md` de opencode y una skill `~/.claude/skills/ohlab-voice-mode` para Claude) como un bloque delimitado por marcadores que no toca el resto del archivo.
- Cuando termina el turno del agente, OhLab lee el **último mensaje del asistente en la transcripción del propio agente en disco**, lo limpia para poder leerlo y lo dice **frase por frase** con una voz del sistema: la primera frase empieza mientras el resto espera. Luego vuelve a escuchar: si el agente hizo una pregunta, simplemente responde.
- Si el agente se detiene en un permiso, escucharás que te necesita en pantalla.
- Hablar mientras la app habla (**interrupción**) corta la respuesta en una fracción de segundo y vuelve a escuchar.

### Qué se lee y qué se omite

Se lee la prosa, los títulos, las viñetas, el texto de los enlaces y el código en línea. Los bloques de código se sustituyen por "código omitido", las URLs por "enlace" y las tablas por "tabla omitida". Una respuesta larga se corta cerca de los 1500 caracteres y termina con "…y sigue en pantalla". La sintaxis markdown y el HTML se eliminan. Con **Speak replies** apagado, el ciclo sigue escuchando y enviando y la respuesta solo se muestra.

### Voces

Settings > Speech > **Voice conversation** lista las voces del sistema para tu idioma de respuesta (el idioma de dictado, o el del sistema con Auto-detect). **Default** elige la mejor: primero las voces Premium y Enhanced, y para español es-CL, es-MX, es-ES. macOS trae voces compactas; las voces **Enhanced** y **Premium**, mucho mejores, son descargas gratuitas: Configuración del Sistema > Accesibilidad > Contenido hablado > Voz del sistema > **Gestionar voces…**, elige el idioma, descarga las marcadas como Mejorada o Premium y aparecerán en el selector (o como nuevo Default) en la siguiente conversación. Ahí están también *Rate* (velocidad) y *Test voice* (probar la voz).

### Latencia

Medido en un Apple M5 Max (Metal), una frase en español de 5,8 s se transcribe en unos 0,3 s con `small` (0,2 s con `base`, 0,1 s con `tiny`); la primera transcripción tras abrir la app suma la carga del modelo (unos 0,7 s con `small`). `small` es además el único nivel que escribe "muéstrame" correctamente, así que el modo voz usa tu modelo de dictado tal cual. Las respuestas empiezan a hablarse en cuanto la transcripción está en disco.

### Se recomiendan audífonos

La respuesta sale por los altavoces mientras el micrófono está abierto. Mientras la app habla, el detector sube su umbral para que el sonido de los altavoces no lo vuelva a activar, pero es una puerta de energía, no cancelación de eco: con los altavoces del portátil a volumen alto, una respuesta fuerte todavía puede tomarse como tu voz (y cortarse a sí misma). Los audífonos eliminan el problema por completo.

### Privacidad

Nada sale de tu equipo. El reconocimiento de voz es whisper.cpp ejecutándose localmente, la voz es el sintetizador del sistema operativo y la respuesta se lee del archivo de transcripción que el agente ya escribe en tu disco. El micrófono está abierto solo mientras el panel o el indicador están visibles y no en pausa.
