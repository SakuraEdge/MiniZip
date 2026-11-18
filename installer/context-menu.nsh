!define MZ_ARCHIVE_FILTER 'System.FileExtension:=".zip" OR System.FileExtension:=".rar" OR System.FileExtension:=".7z" OR System.FileExtension:=".lz4" OR System.FileExtension:=".tar" OR System.FileExtension:=".gz" OR System.FileExtension:=".tgz" OR System.FileExtension:=".bz2" OR System.FileExtension:=".xz" OR System.FileExtension:=".zst" OR System.FileExtension:=".zstd" OR System.FileExtension:=".iso" OR System.FileExtension:=".cab" OR System.FileExtension:=".arj" OR System.FileExtension:=".lzh" OR System.FileExtension:=".lzma" OR System.FileExtension:=".zipx" OR System.FileExtension:=".001"'

!macro MZCommand TYPE ID LABEL FLAG
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip\shell\${ID}" "MUIVerb" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip\shell\${ID}" "Icon" '"$INSTDIR\MiniZip.exe",0'
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip\shell\${ID}" "MultiSelectModel" "Document"
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip\shell\${ID}\command" "" '"$INSTDIR\MiniZip.exe" ${FLAG} -- "%1"'
!macroend

!macro MZSubmenu TYPE
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip" "MUIVerb" "MiniZip"
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip" "Icon" '"$INSTDIR\MiniZip.exe",0'
  WriteRegStr HKCU "Software\Classes\${TYPE}\shell\MiniZip" "SubCommands" ""
  !insertmacro MZCommand "${TYPE}" "20Compress" "添加到压缩文件…" "--compress"
  !insertmacro MZCommand "${TYPE}" "21Zip" "添加到 ZIP 压缩文件…" "--compress-zip"
  !insertmacro MZCommand "${TYPE}" "22SevenZip" "添加到高压缩比 7Z 文件…" "--compress-7z"
!macroend

!macro MZArchiveCommand ID LABEL FLAG
  !insertmacro MZCommand "*" "${ID}" "${LABEL}" "${FLAG}"
  WriteRegStr HKCU "Software\Classes\*\shell\MiniZip\shell\${ID}" "AppliesTo" '${MZ_ARCHIVE_FILTER}'
!macroend

!macro MZInstallSubmenus
  !insertmacro MZRemoveContext
  ${If} $MZContext == ${BST_CHECKED}
    !insertmacro MZSubmenu "*"
    !insertmacro MZSubmenu "Directory"
    !insertmacro MZArchiveCommand "01Open" "用 MiniZip 打开" "--open"
    !insertmacro MZArchiveCommand "02ExtractTo" "解压到…" "--extract-to"
    !insertmacro MZArchiveCommand "03ExtractHere" "解压到当前文件夹" "--extract-here"
    !insertmacro MZArchiveCommand "04ExtractFolder" "解压到同名文件夹" "--extract-folder"
  ${EndIf}
!macroend
