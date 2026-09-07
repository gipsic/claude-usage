' Start claude-usage with no console window.
'
' A scheduled task whose action is node.exe flashes a console at every logon, and
' Task Scheduler's own "Run whether user is logged on or not" hides the window at
' the price of running without a desktop session. Handing the command to wscript
' keeps it in the user's session and invisible.
'
'   wscript //nologo run-hidden.vbs <node.exe> <script> [args...]
Option Explicit
Dim shell, parts, i, cmd
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """"
  If i < WScript.Arguments.Count - 1 Then cmd = cmd & " "
Next
' 0 = hidden window, False = do not wait for it to exit.
shell.Run cmd, 0, False
