@echo off
rem Crée un raccourci « Docker » sur le Bureau, avec l'icône, qui lance l'application sans fenêtre noire.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$d\Docker.lnk\"); $s.TargetPath='wscript.exe'; $s.Arguments='\"' + (Resolve-Path 'Docker.vbs').Path + '\"'; $s.WorkingDirectory=(Get-Location).Path; $s.IconLocation=(Resolve-Path 'build\icon.ico').Path + ',0'; $s.Description='Docker - Import Chine'; $s.Save(); Write-Host 'Raccourci Docker cree sur le Bureau.'"
pause
