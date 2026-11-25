# Changelog

## Unreleased

### Changed
- La carpeta temporal del chat ya no pide permiso para guardar o cambiar archivos: es un espacio de la propia app. Si el asistente ejecuta ordenes ahi, te sigue pidiendo permiso segun como tengas configuradas tus carpetas.

### Fixed
- Videos en varios formatos: exportar en horizontal, vertical o cuadrado un video pensado para otro formato ya no da un MP4 con partes cortadas sin avisar. Antes de generar cada formato se comprueba que todo cabe; si alguno saldria cortado, la app te dice cual y te ofrece "Arreglar con el asistente" o "Exportar igualmente". La comprobacion tarda como mucho 20 segundos, muestra que formato esta revisando y se puede cancelar. Los formatos que estan bien se exportan normalmente.
- El asistente disena los videos para que se vean bien en los tres formatos y, al terminar de crear o cambiar uno, la app lo comprueba en los tres. Si algo se corta, le pide que lo arregle automaticamente (como mucho dos veces seguidas).

## 0.2.20 - 2026-11-24 - Actualizar sin cuelgues y mejoras de videos

### Fixed
- Actualizar ya no deja la app colgada: la instalacion y el reinicio se hacen de forma mas directa y, si la app no se ha cerrado a los 20 segundos, se cierra sola y abre la version nueva.
- Videos en vertical y cuadrado: la vista previa ya no corta la parte de abajo del video (pasaba en macOS en todas las plantillas). Tres plantillas se ven mejor en cuadrado.
- "Permitir sin preguntar" tambien vale para la carpeta temporal del chat cuando todas las carpetas seleccionadas estan en ese modo, y el selector de carpetas no se puede cambiar mientras el asistente responde (el cambio vale desde el siguiente mensaje).

### New
- Exportar varios formatos a la vez (horizontal, vertical y cuadrado): se generan uno detras de otro, con el tiempo total que van a usar antes de empezar, y cada uno se puede cancelar.
- Vista previa del video: boton para exportar y boton de pantalla completa. Se actualiza sola cuando el asistente cambia el video.
- Colores en hexadecimal (#0a0a0a, #FFF) junto al selector de color.
- "Pedir al asistente que lo arregle" envia la peticion directamente.

## 0.2.19 - 2026-11-24 - Videos

### New
- Videos: pidele al asistente un video ("hazme un video de 15 segundos presentando mi panaderia") y lo crea con escenas animadas, textos, colores, imagenes generadas y, si quieres, voz en off. Se abre en la vista previa lateral con su reproductor.
- Nueva seccion Videos en la barra lateral: tus videos, una galeria de 12 plantillas (promo de producto, anuncio vertical para redes, datos explicados, intro de logo, testimonio, cuenta atras, evento, tutorial por pasos, antes y despues, resumen del ano, arbol de decision y grafico editorial) en horizontal, vertical o cuadrado, y un editor sencillo: cambia textos, colores, logo e imagenes, ordena y ajusta las escenas, pon musica o voz con su volumen, cambia el formato y usa "Pedir un cambio en esta escena" para que el asistente haga el resto.
- Exportar MP4: el video se genera en nuestros servidores, con el progreso a la vista, la opcion de cancelar y el tiempo de exportacion que te queda este mes. Al terminar se guarda en tu equipo con "Abrir", "Mostrar en carpeta" y "Guardar una copia".
- Los videos se revisan antes de exportar; si hay algun problema, un boton se lo pide al asistente para que lo arregle. La vista previa no se conecta a internet y no puede acceder a la app.

## 0.2.18 - 2026-11-23 - Dependencias al dia

### Changed
- Dependencias actualizadas: cifrado del almacen de claves (aes-gcm 0.11, sha2 0.11, getrandom 0.4), base de datos local (rusqlite 0.43), tauri-plugin-opener 2.7.3, y las herramientas de desarrollo (TypeScript 7, Vite 8.3.8, Vitest 5, jsdom 31). No cambia nada visible; las claves guardadas y los chats se siguen abriendo igual.

## 0.2.17 - 2026-11-23 - Artifacts en el panel y navegador estable en Windows

### Fixed
- Los enlaces de archivos compartidos (artifacts.nan.builders y artifacts.helmcode.com) muestran el archivo en la vista previa lateral, no solo sus datos: las webs se abren aisladas y sin red, y los PDF, imagenes, textos, hojas y documentos con su visor. Si el enlace es privado o no se puede mostrar, ofrece abrirlo en el navegador.
- Windows: cerrar el navegador desde la barra del chat ya no deja la ventana de la app en blanco. El navegador usa ahora un motor separado del de la app, asi que cerrarlo no afecta al chat.

## 0.2.16 - 2026-11-19 - Permitir sin preguntar por defecto

### Changed
- "Permitir sin preguntar" pasa a ser el modo por defecto, a peticion de los primeros testers: preguntar en cada accion resultaba pesado y prefieren activar ellos que les pregunte.
- Carpetas: en Ajustes el selector "Carpetas nuevas" empieza en "Permitir sin preguntar", y una carpeta anadida desde el chat se anade en ese modo. Despues de elegir la carpeta, el sistema pide una confirmacion. Si la cancelas, la carpeta queda en "Preguntar siempre". Volver a elegir una carpeta que ya tenias no cambia su modo. Las carpetas que ya tenias conservan su modo, y "Todo el equipo" sigue empezando en "Preguntar siempre".
- Navegador: el selector "Navegador" pasa a "Permitir sin preguntar" en las instalaciones nuevas y, una sola vez, en las que ya existian. Si lo vuelves a poner en "Preguntar siempre", se respeta.
- En cualquier modo siguen preguntando las direcciones de tu red local, los inicios de sesion, los pagos y compartir enlaces, y el asistente nunca escribe contrasenas, codigos ni datos de tarjeta.

## 0.2.15 - 2026-11-18 - Comparte hablando y navega sin tantas preguntas

### New
- Compartir hablando: pidele al asistente que comparta algo ("comparte la web con ana@acme.com", "dame un enlace publico", "compartelo con mi organizacion") y crea el enlace. Funciona con la web que ha construido, un PDF o cualquier archivo de la conversacion o de tus carpetas.
- Siempre te pregunta antes en el chat: que archivo, con quien (enlace publico, esas personas o toda tu organizacion en Helmcode), cuando caduca y, si es publico o para otras personas, el aviso de riesgo. Al pulsar Permitir aceptas ese aviso. Nunca comparte sin preguntar, aunque tus carpetas esten en "Permitir sin preguntar".
- El enlace aparece bajo la respuesta con "Copiar enlace" y "Abrir", y tambien en Enlaces compartidos.
- Si pides un "artifact" (o una app, un panel, una calculadora, un juego...), el asistente construye siempre una web app completa e interactiva que funciona en la vista previa y se puede compartir.

### Changed
- Las fuentes y los archivos de una respuesta salen plegados ("Fuentes 8", "Archivos 12"); se despliegan al pulsarlos, para que no llenen el chat.
- Ajustes, Carpetas de trabajo: el permiso del navegador es ahora un selector "Navegador" igual que el de "Carpetas nuevas", con "Preguntar siempre" o "Permitir sin preguntar". En "Permitir sin preguntar" el asistente usa webs publicas sin pedir permiso por sitio y, despues de navegar, no vuelve a preguntar en las carpetas con "Permitir sin preguntar". Activarlo pide una confirmacion del sistema. Sustituye al interruptor "Pedir permiso para ordenes y cambios despues de navegar por internet"; si lo tenias desactivado, pasa a "Permitir sin preguntar".
- Si apruebas muchas acciones del navegador en una conversacion (3 seguidas), el chat te pregunta si quieres que deje de preguntar: "Permitir siempre" o "Solo en esta sesion" (hasta que cierres la app). Se muestra una vez por conversacion.
- En "Preguntar siempre", cada web nueva pide permiso una vez por conversacion aunque todas tus carpetas esten en "Permitir sin preguntar" (antes, en ese caso, las webs publicas no preguntaban). Solo el selector "Navegador" decide si el navegador pregunta.
- En cualquier modo siguen preguntando las direcciones de tu red local, los inicios de sesion y los pagos, y el asistente nunca escribe contrasenas, codigos ni datos de tarjeta.

### Security
- Si un archivo parece contener una contrasena o clave, el asistente no lo comparte y te pide que lo hagas tu con el boton Compartir del archivo, donde ves el aviso. Compartir a mano sigue igual.

### Fixed
- Un correo largo ya no se sale del menu de la cuenta: pasa a la linea siguiente.

## 0.2.14 - 2026-11-18 - Adjunta, escribe mientras trabaja y navega

### New
- Ya puedes escribir mientras el asistente responde. Si envias, el mensaje queda en cola encima del cuadro de texto ("Se enviara cuando termine la respuesta.") y sale solo al terminar, uno detras de otro. Cada mensaje en cola se puede editar o quitar. Si pulsas Detener o algo falla, la cola espera hasta que pulses "Enviar ahora". Un mensaje en cola tiene prioridad sobre la continuacion automatica de una respuesta cortada.
- Navegador del asistente: el asistente puede abrir paginas web en una ventana de navegador de la app, leerlas, pulsar botones y escribir en formularios. Ves todo lo que hace, puedes usar la ventana tu tambien y pararlo desde la barra del navegador que aparece encima del chat (atras, adelante, recargar, ver ventana, parar, cerrar).
- Antes de usar cada web, el asistente pide permiso una vez por conversacion (si todas tus carpetas estan en "Permitir sin preguntar", las webs publicas no preguntan). Las direcciones de tu red local preguntan siempre.
- El asistente nunca escribe contrasenas, codigos de verificacion ni datos de tarjeta: te pide que lo hagas tu en la ventana. Enviar un inicio de sesion o pulsar un boton de pago o compra pide permiso cada vez.
- Con modelos que ven imagenes, el asistente puede hacer una captura de la pagina.
- La ventana del navegador se abre al lado del chat sin quitarle el foco, y cuando el asistente pide permiso el chat pasa al frente. Cerrar el navegador detiene al asistente. Si una pagina intenta descargar un archivo, se bloquea y el asistente te dice que lo descargues desde tu navegador habitual.
- Adjuntar archivos al mensaje: boton de clip en el cuadro de texto, arrastrar archivos a la ventana o pegar una captura. Se ven como fichas que puedes quitar antes de enviar (hasta 10 por mensaje; imagenes de hasta 10 MB y documentos de hasta 20 MB).
- Los PDF, Word, hojas de calculo (xlsx, xls, csv) y archivos de texto o codigo se leen en tu equipo y el asistente recibe su texto. Si un documento es muy largo, solo se usa el principio y se indica en la ficha.
- Las imagenes se reducen antes de enviarlas. Si el modelo elegido no puede ver imagenes, esa respuesta la da automaticamente un modelo que si puede; tu eleccion de modelo no cambia y el siguiente mensaje sin imagenes vuelve a tu modelo.
- Los mensajes enviados muestran sus imagenes y documentos, tambien al volver a abrir la conversacion.
- Mientras el asistente responde tambien puedes adjuntar archivos: van con el mensaje en cola.

### Security
- Despues de que el asistente use el navegador, te pide permiso antes de ejecutar ordenes o cambiar archivos hasta tu siguiente mensaje, tambien en carpetas con "Permitir sin preguntar" (leer archivos no pregunta). Se puede desactivar en Ajustes, Carpetas de trabajo.
- El navegador del asistente no puede llamar a ningun comando de la app, usa un almacen de datos privado que se borra al cerrarlo, bloquea las descargas y solo abre paginas http/https. Los comandos de la app ahora solo se aceptan desde la ventana del chat.

### Changed
- Los archivos adjuntos se quedan en este equipo: la memoria de tu cuenta solo guarda una linea con el nombre de cada archivo, nunca su contenido ni la descripcion de las imagenes.
- Telemetria: dos eventos nuevos sin contenido, `attachment_added` (tipo de archivo y cuantos) y `vision_routed` (de que modelo a que modelo se envio una respuesta con imagenes). Detalle en SECURITY.md.

## 0.2.13 - 2026-11-17 - El asistente termina lo que empieza

### Fixes
- Las tareas largas ya no se quedan a medias en silencio: el asistente puede dar hasta 60 pasos por respuesta (antes 24) y, cuando le quedan pocos, cierra lo que esta haciendo en lugar de cortarse a mitad.
- Si una respuesta se detiene antes de terminar (demasiados pasos, conexion cortada o respuesta demasiado larga), aparece "Me he detenido antes de terminar." con el motivo y un boton Continuar. Ya no hace falta escribir "sigue" una y otra vez.
- Si se corta la conexion o la respuesta es demasiado larga, el asistente retoma solo una vez a los 2 segundos (se puede cancelar); si vuelve a pasar, queda el boton Continuar.
- Al continuar, el asistente recuerda lo que hizo en las ultimas respuestas (archivos leidos, comandos ejecutados) y no vuelve a comprobarlo todo. Ese registro se queda solo en este equipo y no se sincroniza con tu cuenta.
- Una conexion cortada a mitad de respuesta conserva el texto recibido en lugar de borrarlo.
- Si algo falla a mitad de una tarea (por ejemplo, la conversacion se hizo demasiado larga), se conserva lo hecho y aparece Continuar en lugar de perderlo todo.
- Los comandos pueden durar hasta 2 minutos (antes 30 segundos): descargas e instalaciones ya no se cortan. Al agotar el tiempo, o al pulsar Detener, se cierra el comando con todo lo que haya lanzado. Limite por respuesta: 60 pasos de hasta 2 minutos cada uno.
- Windows: los comandos ya no abren una ventana de consola que roba el foco.
- El registro de herramientas que se guarda en el equipo se limita a las 2 ultimas respuestas de cada conversacion.
- Escape cierra siempre el menu o dialogo abierto, incluso si se pulsa justo al abrirlo (antes podia salir de Ajustes).

### Changed
- Para corregir errores y entender el uso, la app envia datos tecnicos (inicio de la app, como termino una respuesta, que herramienta se uso y si funciono, que tipo de error se mostro y donde fallo la app) a la API de tu propia plataforma, sin terceros. Nunca envia tus conversaciones, archivos, rutas, enlaces, comandos ni nada que escribas. Siempre esta activo; el detalle completo esta en SECURITY.md.

## 0.2.12 - 2026-11-16 - Todo se ve como debe

### New
- Los HTML se previsualizan como webs reales en un marco aislado (scripts separados de la app y sin red), tambien los tuyos; hasta 8 MB.
- La Cuenta incluye enlaces para dar una estrella al repositorio y reportar incidencias.
- El acceso a todo el equipo admite "Permitir sin preguntar"; en las carpetas marcadas como "Preguntar siempre" se sigue preguntando, y la pagina de carpetas avisa de esa mezcla.

## 0.2.11 - 2026-11-16 - Quien comparte tambien abre su enlace

### Changed
- Al crear un enlace compartido, el aviso dice que quien comparte y las personas destinatarias pueden abrirlo con su cuenta, con botones para Abrir y Copiar.
- Tus propios enlaces en "Enlaces compartidos" ofrecen abrirlos en el navegador.

## 0.2.10 - 2026-11-16 - Compartir por fin sin codigos

### Changed
- Compartir con miembros de Helmcode: solo miembros de la organizacion o toda la organizacion; las direcciones externas desaparecen del dialogo.
- Compartir con usuarios de NaN: los destinatarios tienen que tener cuenta en NaN y abriran el enlace iniciando sesion. Si un correo no es usuario de NaN, el dialogo lo dice y lo marca.

## 0.2.9 - 2026-11-16 - Enlaces, sitios y avisos que funcionan a la primera

### Fixes
- Abrir "Enlaces compartidos" tras ver un PDF ya no rompe la seccion: los PDF se liberan a traves de la tarea de carga de pdf.js al desmontar la vista previa.
- El aviso de actualizacion ya no desaparece cuando una comprobacion falla (por ejemplo al despertar sin red) y el reintento por `online` es inmediato. Un aviso cerrado permanece cerrado.

### New
- Nueva herramienta `write_website`: el agente construye pequenos sitios estaticos en un unico HTML autocontenido, se previsualizan en un marco aislado (scripts separados de la app y sin red) y se pueden compartir como artifacts.
- La accion Compartir se ofrece para todo lo que muestra la vista previa (json, yaml, logs y codigo se suben como texto); los selectores de miembros ya no te ofrecen a ti mismo como destinatario.

### Updates
- Las comprobaciones de actualizacion pasan de cada 6 horas a cada 2, y ademas se lanzan al recuperar el foco tras estar fuera (el aviso 0.2.8 nunca llego por los intervalos largos y el sueno del Mac).

## 0.2.8 - 2026-11-15 - The app recovers instead of going dark

### Reliability
- If anything unexpected breaks inside the app, it now shows a calm recovery
  screen ("Algo no ha ido bien") with two actions: try again (remount) or
  close and reopen the app; conversations are never lost. A renderer fault
  can no longer leave a black, empty window.
- Errors reaching the recovery screen are logged with tokens redacted
  (sk-, hke_, nan_, Bearer, JWT), including errors caught by error
  boundaries (React 19 onCaughtError), so no credential ever reaches logs.

### Interface
- Removed the "este es tu espacio" notice shown when an account with no
  data signs in (owner call: isolation is self-evident).
## 0.2.7 - 2026-11-14 - Your data is yours alone on a shared computer

### Privacy (critical fix)
- Local data is now kept per signed-in account, not per platform. Before,
  a second account of the same platform signing in on the same computer saw
  the first account's conversations, skills, team skills cache and folder
  grants. Each account now has its own private space on the device; another
  account sees none of it.
- At sign-in the app asks the platform which account signed in (with the new
  session) and opens that account's space. If the platform cannot confirm
  it, the sign-in stops and nothing changes.
- Signing out keeps your data on the device; signing back in with the same
  account brings it back. An account signing in for the first time on the
  computer starts with an empty space and the chat says so.
- The account chip names the account whose space is open.

### Upgrading (one-time)
- You are asked to sign in once after the update.
- Everything stored before this version has no owner on record. It is given
  to the FIRST account that signs in to each platform after the update (the
  data so far belonged to whoever used the app). Local skills, which were
  shared by both platforms, go to the first sign-in on the computer. Any
  other account starts empty.

### Reading previews
- PDF previews now render every page stacked in a continuous vertical
  scroll at the pane width (up to 1100px), replacing the previous/next
  pager. A small page indicator follows the scroll, each page is
  announced to screen readers, and pages render lazily while you scroll.
- A "Mostrar en la carpeta" button sits next to close for local files:
  it reveals the file in Finder/Explorer without opening it, reusing
  the same folder-grant checks as the preview reader.

### Sharing artifacts
- Share a produced file as a link (Artifacts): from the chat file chips,
  the preview header, the user menu and Settings. Pick recipients by
  email (with consent for external people), org members, the whole org
  or a public link; the risk warning must be accepted with an explicit
  checkbox for anything leaving the org, and a detected secret needs its
  own confirmation.
- The success screen shows the link returned by the server with copy and
  open actions; "Mis enlaces" lists your shared links and lets you revoke
  them (admins also see the whole organization).
- "Sin caducidad" now really means no expiry (it previously fell back to
  the platform default in a server contract mismatch).

## 0.2.6 - The preview knows what you asked for

### Chat
- The preview opens the file the tools declared as the deliverable (the PDF
  you asked for, the generated image), not a page render or a scratch file.
  Name-guessing only remains as the last resort.
- A turn clock is always visible while the assistant works ("Escribiendo ...
  12 s"), including while the answer streams, so long steps never look frozen.
- Conversations in the sidebar get a 3-dot menu: rename the chat inline
  (with a visible error if it fails) or delete it with the same two-step
  confirm as before.
- A chat that receives a reply while you are elsewhere shows its name in
  bold until you open it.

### Skills
- Your own shared skills show "Pendiente de aprobacion" while an admin has
  not approved them yet, with a tooltip explaining the wait.

### Escapes
- The preview pane joins the escape-layer stack: closing a popup with Esc no
  longer also closes the preview.

## 0.2.5 - Sharing that works, and says why

### Skills
- Sharing a skill with your team now works: the request carries the name and
  title the library requires (before, every share from the app failed with an
  opaque error).
- Re-sharing after renaming a skill keeps the library identity, so updates
  land on the same team skill instead of failing.
- The share dialog now explains each failure in plain words: which file holds
  the problem, size limits, library full vs too many pending, a changed team
  library, an expired session, or being offline.
- Very long names are checked when the share dialog opens, with a clear limit
  message and the button disabled.

### Chat
- The activity line ("Pensando...") sits inside the conversation under the
  last message with a running elapsed time; the detached corner indicator is
  gone.
- The preview opens the document you asked for: page-render images (p1.png,
  slide-2.png, probe files) no longer win over the requested deliverable, and
  the file type you named (PDF, Excel, slides) is preferred.

## 0.2.4 - Team skills that work, distilled skills

### Skills
- Team skills now download reliably: the library loads without the red
  banner, "Usar" works, and the chat picker lists team skills. The sharing
  switch is read from the server correctly (it was silently ignored before).
- "Guardar como skill" asks the model to distill the whole conversation into
  a quality skill (decisions, working order, gotchas) instead of copying the
  first message; you review and edit the draft before saving. If the summary
  fails, the app says so and copies the chat start instead.
- A new skill whose name is taken is saved as "Nombre 2" instead of creating
  a silent duplicate.
- Share with your team from "Mias": the share action is visible on your own
  skills when your organization has skills sharing on.
- Escape and Stop behave: stopping a turn never opens the save-as-skill form,
  and the assistant only proposes a skill draft with a clear hint.
- Team rows show who shared each skill (the sharer's account email).

### Chat and preview
- The preview opens the document you asked for (the final deliverable), not
  the last intermediate file a tool touched.
- While the assistant works you always see a live "En curso" indicator with
  elapsed seconds, so long tool turns never look frozen.

## 0.2.3 - Settings window, team skills, honest updates

### Platform
- The account menu's account section and the Settings > Account section both
  offer Update while a newer version exists, so closing the banner does not
  hide it. One install runs at a time across the banner, the menu and
  Settings, and a failure shows an alert where you started it.
- Update copy is clearer: "Hay una versión nueva: {version}" instead of a
  headline-style line.
- Escape behaves predictably: it closes only the innermost open thing (the
  account menu, a dialog, the skills form), closing a popup no longer also
  exits Settings, and Escape while an IME composition is active never counts
  as a dismissal. A half-filled skill draft can no longer be wiped by Escape:
  only its Cancel button closes it.
- Settings headings now match the section names (the section title is the
  page heading), and the Account section labels the plan as "Tipo de cuenta".
- Team skills: approved skills still downloading show "Preparando…" with a
  tooltip explaining the wait, and badges no longer glue to the skill name
  for screen readers.
- Save as skill: the description field has a short example placeholder and a
  persistent guide ("Describe qué hace y cuándo usarlo: empieza con «Úsala
  cuando…»") that stays visible while you type.
- Settings: opening Settings from the user menu now switches the whole window
  to a section layout (Account, Working folders, Memory, Language) with its
  own sidebar; leaving Settings returns to the chat exactly as it was.
- macOS: fixed "Helmcode Desktop is damaged and can't be opened". 0.2.0
  shipped an app that was only linker-signed (bundle resources not sealed).
  Release builds now get a verified bundle signature, and the app inside the
  dmg is checked before upload.
- Release pipeline ready for Developer ID signing + notarization (macOS) and
  Authenticode (Windows). It turns on automatically once the signing secrets
  exist, and every release states its real signing status. See SIGNING.md.
- Auto-update: the app checks for a new signed release on startup and every
  6 hours and shows a small banner at the top of the chat with an Update
  button (download, verify, install, relaunch). It never installs by itself.
  Releases publish a signed `latest.json` once the updater key secrets exist.
- Windows icon: icon.ico carries every frame size (16 to 256 px).

### Chat
- The model picker is now an editable allowlist: it shows exactly the ids in
  `src-tauri/chat-models.json` (deepseek-v4-flash, glm5.3, glm5.3-flash), in
  file order with the headliner first. Edit that file to change the picker.
- Images in the chat show a download icon in their corner on hover (same
  native Save-as dialog as the "Save as…" button).
- The composer's image button now uses a sparkle icon and the tooltip
  "Create image"; when image mode is on, the placeholder asks for the image
  to create and the button shows the accent state.
- Image editing (NaN community): edits happen in the new **Image Studio**,
  a view of its own. Open it from the Edit action on any chat image, from
  the visible "Edit image" button in the preview pane (chat images and
  PNG/JPEG/WebP files from your working folders), or from "Image Studio" in
  the sidebar to start from a file you pick. The Studio shows the image on
  a canvas (fit to view or actual size), pins it as the locked base, takes
  up to 2 more reference images, an instruction (up to 2000 characters,
  with a counter) and one Apply button with progress and Cancel. Every
  result joins a history strip (original, then each edit); click any step
  to keep editing from it, and download the current image. Esc goes
  back, Cmd/Ctrl + Enter applies. Results also appear in the chat as a new
  image with an "Edited" badge and a link to its original. Sent from the
  Rust core to `POST /v1/images/edits` with the desktop session; images are
  read from disk by the core and checked (PNG/JPEG/WebP, 20 MB each).
  Picked or previewed files go through the folder grants and the
  sensitive-path deny-list (new core command `image_edit_stage` for files
  already shown in the preview pane). While an edit runs, switching to
  another conversation is paused (the sidebar explains why) so the result
  and any error land in the open Studio.
- Image Studio region tools: the **Brush** and the **Rectangle** in the
  Studio toolbar now work. Pick one (one at a time; click again to turn it
  off), paint over or drag a box around the part to change, and "Clear
  marks" starts over. Marks are drawn in magenta on a layer above the image,
  never into it, and reset when the base image changes. Applying with marks
  sends the untouched base plus a marked copy and tells the model to change
  only the magenta area (the marked copy takes one reference slot and never
  joins the history). Without marks an edit works exactly as before. Needs
  an edit model that takes two images (NaN community); on the enterprise
  FLUX editor the tools show as unavailable. Core: new command
  `image_edit_stage_annotation`, and `edit_images` takes an optional
  `annotationPath` (older callers are unaffected).
- Image Studio: the pinned base image has an X ("Remove base image ... and
  start over"). It closes the current session and starts a fresh one, like
  "New chat": the canvas shows "Get started: add an image or choose a file"
  with the file picker (focused) and a pointer to the sidebar chats, the
  tray and the history strip empty, the tools reset, and the next edit
  creates its own conversation. Earlier results stay in their chat. The X
  is disabled while an edit runs.
- Preview pane: an image (a chat image or an image file) shows a
  small X on its corner, "Remove from preview". It takes the image out of
  the pane (no reopen toggle is left behind) so another one can be opened;
  the file itself is never touched. Other previews keep only the pane's
  close button.
- The "Only images inside your working folders can be used..." refusal in
  the Image Studio is now a card with an **Open Settings** button that
  opens Settings on the working folders. Settings' Back then reads "Back to
  the Image Studio" and returns to the same Studio session.

### Skills
- A team bundle round stopped by a rate limit or an expired session retries in
  60 seconds, then 5 minutes, instead of waiting the 15-minute refresh; Team
  rows whose bundle is not cached yet show "Preparing" instead of looking
  ready.
- The "Save as skill" scaffold follows the skill-creator method: the body is
  the conversation instructions under a "~ Working order" heading (byte-
  identical when regenerated), the description guide asks for what it does
  plus trigger phrases, and a blocking secret detector refuses to generate,
  validate or publish a bundle carrying credentials.
- New **Skills** section in the sidebar: save instructions you reuse and
  turn them on in any conversation. A skill is three fields (name, what it
  is for, instructions) plus up to 5 optional reference files (.md, .txt,
  .json, .yaml, .yml; UTF-8 text, 64 KB each). The app generates the
  agentskills bundle (`SKILL.md` + `references/`) from them; the 64 KB
  `SKILL.md` and 256 KB bundle caps and the bundle path rules (NFC, no
  dotfiles, no `..`, no NUL) are checked in the Rust core on every save.
  Skills are stored locally only (`app_data/skills/`, one JSON per skill,
  atomic writes); there is no sharing yet.
- In the chat, the composer's bolt button ("Use skill") or typing `/` at the
  start of a message opens a picker (arrows, Enter, Esc). The active skill
  shows as a pill above the composer with an X to turn it off; it is
  remembered per conversation. "Save as skill" in the chat header opens the
  form preloaded from the conversation for review. Skills can be edited and
  deleted (two-step confirm); deleting one turns it off everywhere.
- Security: only the skill id is sent with `chat_send`; the core reads the
  skill from its store and adds it as its own delimited, labeled system
  block (tags inside the text are neutralized). A skill is text only: it
  never changes the offered tools, the folder grants, the approval modes or
  the model (pinned by
  `chat::tests::activating_a_skill_cannot_change_tools_permissions_or_model`).
- Shared skills (Helmcode organizations, S4). When the org has
  `skills_sharing` on (read from `GET /api/auth/me`, default off), each of
  your skills offers **Share with my team**: a confirmation shows exactly
  what teammates will see (title, description, rendered instructions, file
  names) and warns that your name appears as the author and an
  administrator reviews it first. The core builds the bundle with the same
  generator as every save (`SKILL.md` first, then `references/` sorted) and
  sends `POST /api/skills`. Cards show Local / In review / Shared / Not
  approved (with the reason); editing a shared skill offers **Share again**
  (`PUT`, back to review). Hidden on NaN (no orgs) and without the flag.
- New **Team** tab next to **Mine**: the org's approved skills (featured
  first) with author and date. **View** opens a read-only, sanitized render
  with "Shared by <author> (team)"; **Use** turns it on in the chat exactly
  like a local skill (pill, `/` picker); **Duplicate in my skills** copies
  it into a new local skill you can edit (no link back).
- Sync: on startup, when the Skills view opens and every 15 minutes, with
  `If-None-Match` (a 304 keeps the cache). Approved bundles are cached in
  `app_data/skills-cache/<profile>/` (`<id>/<sha>.json`) so **Use** works
  offline; a skill no longer listed as approved is purged from the cache
  (revocation is effective) and a 404 (sharing turned off) clears it. 429
  shows "Wait a moment", 401 the session-expired flow.
- Security: the session JWT stays in the core; the renderer reaches the
  library only through a closed route allowlist (`/api/auth/me`,
  `/api/skills[/{id}]`), uploads must pass the bundle validator, and cached
  bundles are re-validated and hash-checked on every read. A team skill is
  the same delimited text block plus a provenance line and cannot change
  tools, grants, approvals or the model (pinned by
  `chat::tests::activating_an_org_skill_cannot_change_tools_permissions_or_model`).

## 0.2.0 — First public beta

The first publicly announced build of Helmcode Desktop: a focused AI
workspace for the NaN and Helmcode inference platforms, locked to
`api.nan.builders` and `api.helmcode.com`.

### Agent
- Tool approvals redesigned: per-folder modes (ask always / allow
  always), approval cards inline in the chat, and a suggestion to
  switch a busy folder to allow-always after repeated approvals.
- Full file surface: read, write, move, delete (to the OS trash where
  available) and command execution, always core-mediated with a
  sensitive-path deny-list that no mode bypasses.
- The model's native tool-call markup (including the fullwidth DSML
  variant observed in the wild) is parsed into real tool calls and
  never shown as chat text.
- Intrinsic web search through the platform's private wrapper, with a
  page reader for the preview pane. The search routes are private to
  the app: member API keys receive a bare 404.

### Product
- Brand: the official Helmcode mark everywhere, app name
  "Helmcode Desktop".
- Language chosen first (English or Spanish), before tenant selection;
  full i18n for every surface.
- Per-conversation working folders (multi-select, none by default;
  with none selected the agent works in a session temp folder and asks
  where to save).
- Preview pane: images, PDF, Markdown, HTML, Excel and Word files, and
  fetched web pages. The latest produced artifact opens automatically.
- Image generation through the tenant's images API (verified against
  the live endpoint).
- Conversations stream in the sidebar the moment they start, and keep
  streaming across switches.
- Credentials live in an encrypted local vault (single master key; no
  repeated OS keychain prompts).

### Platform
- Device-flow login (RFC 8628) against both tenants with per-device
  credentials.
- Release builds for macOS (Apple silicon + Intel), Windows and
  Linux (not code-signed; see SIGNING.md); CI runs unit, wire-acceptance and E2E checks on every pull
  request.
