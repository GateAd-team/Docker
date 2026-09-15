' Lance Docker sans fenêtre noire. Journal : %LOCALAPPDATA%\docker-app.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\docker-app.log"
cmdLine = "cmd /c cd /d """ & appDir & """ && (if not exist node_modules npm install --no-audit --no-fund) && npm run dev >> """ & logFile & """ 2>&1"
sh.Run cmdLine, 0, False
