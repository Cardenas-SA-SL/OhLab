# Installing OhLab on macOS

OhLab supports macOS 12 or later on Apple Silicon and Intel processors. These instructions apply
to macOS 15 and macOS 26. Download the DMG whose name matches your processor from the
[OhLab GitHub Releases](https://github.com/Cardenas-SA-SL/OhLab/releases) page:

- Apple Silicon (M1 or newer): `OhLab-<version>-arm64.dmg`
- Intel: `OhLab-<version>-x64.dmg`

Open the DMG and drag **OhLab** to **Applications**. OhLab is currently distributed without an
Apple Developer ID signature, so macOS will block the usual double-click on first launch. Use one
of these methods once:

1. In Finder, open **Applications**, Control-click or right-click **OhLab**, choose **Open**, then
   confirm **Open**.
2. Or remove the downloaded-file quarantine attribute in Terminal and launch normally:

   ```sh
   xattr -dr com.apple.quarantine /Applications/OhLab.app
   ```

Only use the quarantine command for a DMG you downloaded from the official OhLab repository.

macOS may ask for access as features are used:

- **Microphone** lets dictation capture your voice. Denying it disables dictation until you enable
  OhLab in System Settings > Privacy & Security > Microphone.
- **Local Network** lets terminals and agents connect to services and machines on your network.
- **Notifications** are optional and report when a background agent finishes or an update is ready.

OhLab checks the GitHub Releases update feed in the app. When a newer release appears, follow the
update card in OhLab. Because releases are unsigned, macOS may require you to download the new DMG,
replace the copy in Applications, and approve its first launch again. Your projects and settings
remain in the OhLab application-support directory and are not removed when the app is replaced.

## Instalación

OhLab funciona en macOS 12 o posterior, tanto en Apple Silicon como en Intel. Estas instrucciones
se aplican a macOS 15 y macOS 26. Descarga desde la
[página de Releases de OhLab](https://github.com/Cardenas-SA-SL/OhLab/releases) el DMG que corresponda:

- Apple Silicon (M1 o más reciente): `OhLab-<version>-arm64.dmg`
- Intel: `OhLab-<version>-x64.dmg`

Abre el DMG y arrastra **OhLab** a **Aplicaciones**. Como OhLab todavía se distribuye sin firma de
Apple Developer ID, macOS bloqueará el primer inicio con doble clic. Autorízalo una sola vez con
uno de estos métodos:

1. En Finder, abre **Aplicaciones**, haz Control-clic o clic derecho en **OhLab**, elige **Abrir** y
   confirma **Abrir**.
2. O elimina en Terminal el atributo de cuarentena del archivo descargado y abre la app normalmente:

   ```sh
   xattr -dr com.apple.quarantine /Applications/OhLab.app
   ```

Usa el comando de cuarentena solamente con un DMG descargado del repositorio oficial de OhLab.

macOS puede solicitar permisos cuando uses determinadas funciones:

- **Micrófono** permite el dictado por voz. Si lo rechazas, puedes activarlo después en Ajustes del
  Sistema > Privacidad y seguridad > Micrófono.
- **Red local** permite que terminales y agentes se conecten con servicios y equipos de tu red.
- **Notificaciones** es opcional y avisa cuando un agente termina en segundo plano o hay una
  actualización lista.

OhLab consulta desde la app el canal de actualizaciones de GitHub Releases. Cuando aparezca una
versión nueva, sigue la tarjeta de actualización de OhLab. Debido a que las versiones no están
firmadas, macOS puede pedirte que descargues el DMG nuevo, reemplaces la copia de Aplicaciones y
autorices otra vez el primer inicio. Tus proyectos y ajustes permanecen en el directorio de soporte
de OhLab y no se eliminan al reemplazar la aplicación.
