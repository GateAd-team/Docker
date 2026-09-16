@echo off
rem Crée un raccourci « Bao » sur le Bureau, avec l'icône, qui lance l'application sans fenêtre noire.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$d\Bao.lnk\"); $s.TargetPath='wscript.exe'; $s.Arguments='\"' + (Resolve-Path 'Bao.vbs').Path + '\"'; $s.WorkingDirectory=(Get-Location).Path; $s.IconLocation=(Resolve-Path 'build\icon.ico').Path + ',0'; $s.Description='Bao - Import Chine'; $s.Save(); Write-Host 'Raccourci Bao cree sur le Bureau.'"
pause
