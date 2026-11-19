!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "${BUILD_RESOURCES_DIR}\..\installer\context-menu.nsh"

!ifndef BUILD_UNINSTALLER
Var MZAssociations
Var MZContext
Var MZDefaults
Var MZAssociationControl
Var MZContextControl
Var MZDefaultsControl
!endif

!macro customInit
  StrCpy $MZAssociations ${BST_CHECKED}
  StrCpy $MZContext ${BST_CHECKED}
  StrCpy $MZDefaults ${BST_UNCHECKED}
  ReadRegDWORD $0 HKCU "Software\MiniZip\Installer" "Associations"
  ${IfNot} ${Errors}
    StrCpy $MZAssociations $0
  ${EndIf}
  ReadRegDWORD $0 HKCU "Software\MiniZip\Installer" "ContextMenu"
  ${IfNot} ${Errors}
    StrCpy $MZContext $0
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom MZIntegrationPage MZIntegrationLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function MZIntegrationPage
  !insertmacro MUI_HEADER_TEXT "MiniZip 系统集成" "选择文件关联和资源管理器菜单"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "安装后可通过压缩包双击或右键菜单使用 MiniZip。原有文件及其他程序的设置不会被删除。"
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 14u "注册常用压缩包格式（ZIP、RAR、7Z、LZ4 等）"
  Pop $MZAssociationControl
  ${NSD_SetState} $MZAssociationControl $MZAssociations
  ${NSD_CreateCheckbox} 0 64u 100% 14u "添加 MiniZip 右键菜单"
  Pop $MZContextControl
  ${NSD_SetState} $MZContextControl $MZContext
  ${NSD_CreateCheckbox} 0 88u 100% 14u "安装后打开 Windows 默认应用设置"
  Pop $MZDefaultsControl
  ${NSD_SetState} $MZDefaultsControl $MZDefaults
  ${NSD_CreateLabel} 0 116u 100% 38u "Windows 10/11 的默认打开方式需要你在系统设置中确认。Windows 11 可能将传统右键选项放在“显示更多选项”中。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function MZIntegrationLeave
  ${NSD_GetState} $MZAssociationControl $MZAssociations
  ${NSD_GetState} $MZContextControl $MZContext
  ${NSD_GetState} $MZDefaultsControl $MZDefaults
FunctionEnd
!endif

!macro MZExtension EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "MiniZip.Archive" ""
  WriteRegStr HKCU "Software\MiniZip\Capabilities\FileAssociations" ".${EXT}" "MiniZip.Archive"
!macroend
!macro MZRemoveExtension EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "MiniZip.Archive"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
!macroend
!macro MZEachExtension ACTION
  !insertmacro ${ACTION} "zip"
  !insertmacro ${ACTION} "rar"
  !insertmacro ${ACTION} "7z"
  !insertmacro ${ACTION} "lz4"
  !insertmacro ${ACTION} "tar"
  !insertmacro ${ACTION} "gz"
  !insertmacro ${ACTION} "tgz"
  !insertmacro ${ACTION} "bz2"
  !insertmacro ${ACTION} "xz"
  !insertmacro ${ACTION} "zst"
  !insertmacro ${ACTION} "zstd"
  !insertmacro ${ACTION} "cab"
  !insertmacro ${ACTION} "iso"
  !insertmacro ${ACTION} "arj"
  !insertmacro ${ACTION} "lzh"
  !insertmacro ${ACTION} "lzma"
  !insertmacro ${ACTION} "zipx"
  !insertmacro ${ACTION} "001"
!macroend
!macro MZRemoveAssociations
  !insertmacro MZEachExtension MZRemoveExtension
  DeleteRegKey HKCU "Software\Classes\MiniZip.Archive"
  DeleteRegValue HKCU "Software\RegisteredApplications" "MiniZip"
  DeleteRegKey HKCU "Software\MiniZip\Capabilities"
!macroend
!macro MZRemoveContext
  DeleteRegKey HKCU "Software\Classes\*\shell\MiniZip.Open"
  DeleteRegKey HKCU "Software\Classes\*\shell\MiniZip.Compress"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\MiniZip.Compress"
  DeleteRegKey HKCU "Software\Classes\*\shell\MiniZip"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\MiniZip"
!macroend

!macro customInstall
  WriteRegDWORD HKCU "Software\MiniZip\Installer" "Associations" $MZAssociations
  WriteRegDWORD HKCU "Software\MiniZip\Installer" "ContextMenu" $MZContext
  ${If} $MZAssociations == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\MiniZip.Archive" "" "MiniZip 压缩文件"
    WriteRegStr HKCU "Software\Classes\MiniZip.Archive\DefaultIcon" "" '$\"$INSTDIR\resources\app\assets\archive.ico$\",0'
    WriteRegStr HKCU "Software\Classes\MiniZip.Archive\shell\open\command" "" '$\"$INSTDIR\MiniZip.exe$\" --open -- $\"%1$\"'
    WriteRegStr HKCU "Software\MiniZip\Capabilities" "ApplicationName" "MiniZip"
    WriteRegStr HKCU "Software\MiniZip\Capabilities" "ApplicationDescription" "MiniZip 压缩包管理工具"
    WriteRegStr HKCU "Software\MiniZip\Capabilities" "ApplicationIcon" '$\"$INSTDIR\MiniZip.exe$\",0'
    WriteRegStr HKCU "Software\RegisteredApplications" "MiniZip" "Software\MiniZip\Capabilities"
    !insertmacro MZEachExtension MZExtension
  ${Else}
    !insertmacro MZRemoveAssociations
  ${EndIf}
  !insertmacro MZInstallSubmenus
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${If} $MZDefaults == ${BST_CHECKED}
    ExecShell "open" "ms-settings:defaultapps"
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro MZRemoveAssociations
  !insertmacro MZRemoveContext
  DeleteRegKey HKCU "Software\MiniZip\Installer"
  DeleteRegKey /ifempty HKCU "Software\MiniZip"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
