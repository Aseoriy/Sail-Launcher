; Sail 5.x and 6.0.0 betas 1 to 4 download an update to
; %LOCALAPPDATA%\sail-launcher-updater\installer.exe and run it from there. The
; installer keeps a copy of itself at that same path, so it would be copying onto
; its own running file, and the update never finishes. When started from there,
; move to the folder newer versions use and carry on from that copy.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !ifdef APP_INSTALLER_STORE_FILE
      ${If} $EXEPATH == "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
        StrCpy $R8 "$LOCALAPPDATA\sail-launcher-update"
        CreateDirectory "$R8"
        Delete "$R8\installer.exe"
        ClearErrors
        CopyFiles /SILENT "$EXEPATH" "$R8\installer.exe"
        ${If} ${FileExists} "$R8\installer.exe"
          ${GetParameters} $R9
          ClearErrors
          Exec '"$R8\installer.exe" $R9'
          ${IfNot} ${Errors}
            SetErrorLevel 0
            Quit
          ${EndIf}
        ${EndIf}
      ${EndIf}
    !endif
  !endif
!macroend
