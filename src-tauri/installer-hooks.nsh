; OFFERING TO OPEN BOOKS, WITHOUT TAKING THEM.
;
; Installing a program must not change what the reader's other programs do. Someone who installs Sard
; and has always read PDFs in something else should find, the next time they double-click a PDF, that
; the same thing happens as yesterday. Sard becomes AVAILABLE, and nothing more; whether it becomes
; the default is a decision Windows already has a place for, and that place belongs to the reader.
;
; Tauri's own `fileAssociations` bundling is deliberately not used, because what it generates does the
; opposite: `APP_ASSOCIATE` writes `Software\Classes\.pdf` directly, which IS the default handler, and
; the MSI's `Advertise="yes"` extensions take it the same way. Both hand the reader's PDFs to Sard on
; install. What follows is the non-intrusive registration that Windows documents for this exact case.
;
; ── THE THREE PIECES, AND WHY EACH IS NEEDED ──────────────────────────────────────────────────
;
;   1. A ProgID per format — a named description of «how Sard opens this kind of file». It is Sard's
;      own key and touches no other program. Windows needs it before Sard can be chosen at all.
;
;   2. `OpenWithProgids` on the extension — this ADDS Sard to the «Open with» list. It is a value
;      written INSIDE a subkey of `.epub`, never the extension's own default value, so the existing
;      default is untouched. This is the difference between offering and seizing, and it is one
;      registry path apart.
;
;   3. `RegisteredApplications` + `Capabilities` — what makes Sard appear in Settings → Default apps,
;      so the reader can choose it deliberately. Without this Sard could be picked per-file but would
;      not be listed as an application that handles books.
;
; The command is `"…\sard.exe" "%1"`, which is exactly the argv shape the application's own argument
; handling is written and tested against: one argument, the path bare inside it.
;
; SHCTX is the install scope NSIS is already using, so a per-user install writes per-user keys and a
; machine-wide install writes machine-wide ones. Choosing a fixed root here would put the association
; in a place the uninstaller does not clean, or that the installing user cannot write.

!macro SardRegisterFormat EXT PROGID DESCRIPTION
  ; 1. Sard's own description of how it opens this format. Nobody else's key.
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; 2. OFFERED, NOT IMPOSED. A value inside the extension's `OpenWithProgids` subkey — the extension's
  ;    own default value is never written, so whatever already opens this format goes on opening it.
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""

  ; 3. Listed in Settings → Default apps, so the reader can choose Sard on purpose.
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

!macro SardUnregisterFormat EXT PROGID
  ; Only ever Sard's own keys and Sard's own value. The extension key itself is left alone: deleting
  ; it would remove whatever the reader's actual default is, which is precisely the harm this avoids.
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey SHCTX "Software\Classes\${PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SardRegisterFormat "epub" "${PRODUCTNAME}.epub" "Electronic Publication"
  !insertmacro SardRegisterFormat "pdf" "${PRODUCTNAME}.pdf" "Portable Document Format"

  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" "ApplicationDescription" "Read EPUB and PDF books"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "Software\${PRODUCTNAME}\Capabilities"

  ; Tell the shell the list of handlers changed, so «Open with» is right immediately rather than
  ; after the next sign-in.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro SardUnregisterFormat "epub" "${PRODUCTNAME}.epub"
  !insertmacro SardUnregisterFormat "pdf" "${PRODUCTNAME}.pdf"

  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "Software\${PRODUCTNAME}\Capabilities"
  DeleteRegKey /ifempty SHCTX "Software\${PRODUCTNAME}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
