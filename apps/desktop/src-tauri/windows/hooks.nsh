; Uninstall: when the person ticks "Delete the application data", also delete the identity keys the app keeps in Windows
; Credential Manager. Without this, a reinstall silently comes back as the same identity (the keys outlive the app folder).
; Never during an update (the updater runs the uninstaller too). Names: the keyring crate's "<key>.<service>" targets.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    nsExec::Exec 'cmdkey /delete:"engine-identity-v1.com.duochat.desktop"'
    Pop $0
    nsExec::Exec 'cmdkey /delete:"ec-private-local.com.duochat.desktop"'
    Pop $0
    nsExec::Exec 'cmdkey /delete:"ec-dh-private-local.com.duochat.desktop"'
    Pop $0
    nsExec::Exec 'cmdkey /delete:"ec-proof-local.com.duochat.desktop"'
    Pop $0
    nsExec::Exec 'cmdkey /delete:"aes-key-local.com.duochat.desktop"'
    Pop $0
  ${EndIf}
!macroend
