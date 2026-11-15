Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Tools\gemini-proxy"
WshShell.Run "node proxy.js", 0, False