import type { DialogBackend, DialogOutcome, DialogRequest } from './types.js';
import { run } from './exec.js';

/**
 * Native Win32 (WinForms) dialog driven by Windows PowerShell, which ships with every
 * Windows 10/11 install. The message is passed through environment variables, never
 * spliced into the script, so prompt content cannot inject PowerShell.
 */
const PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:WDLP_TITLE
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ShowInTaskbar = $true
$f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'; $f.Padding = New-Object System.Windows.Forms.Padding(12)
$f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$icon = New-Object System.Windows.Forms.PictureBox
$icon.Image = [System.Drawing.SystemIcons]::Warning.ToBitmap(); $icon.SizeMode = 'AutoSize'; $icon.Location = New-Object System.Drawing.Point(16,18)
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = $env:WDLP_MESSAGE; $lbl.AutoSize = $true; $lbl.MaximumSize = New-Object System.Drawing.Size(520,0); $lbl.Location = New-Object System.Drawing.Point(64,16)
$f.Controls.Add($icon); $f.Controls.Add($lbl)
$f.PerformLayout()
$y = [Math]::Max($lbl.Bottom, $icon.Bottom) + 18
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'; $cancel.Size = New-Object System.Drawing.Size(110,32)
$cont = New-Object System.Windows.Forms.Button
$cont.Text = 'Continue'; $cont.DialogResult = 'OK'; $cont.Size = New-Object System.Drawing.Size(110,32)
$right = [Math]::Max($lbl.Right, 360)
$cancel.Location = New-Object System.Drawing.Point(($right - 110), $y)
$cont.Location = New-Object System.Drawing.Point(($right - 230), $y)
$f.Controls.Add($cont); $f.Controls.Add($cancel)
$f.CancelButton = $cancel; $f.AcceptButton = $cancel
$f.Add_Shown({ $f.Activate(); $cancel.Focus() })
$script:timedOut = $false
$t = New-Object System.Windows.Forms.Timer
$t.Interval = [int]$env:WDLP_TIMEOUT * 1000
$t.Add_Tick({ $script:timedOut = $true; $t.Stop(); $f.DialogResult = 'Cancel'; $f.Close() })
$t.Start()
$r = $f.ShowDialog()
if ($script:timedOut) { 'timeout' } elseif ($r -eq 'OK') { 'continue' } else { 'cancel' }
`;

export const winforms: DialogBackend = {
  name: 'WinForms dialog (Windows)',
  available: async () => process.platform === 'win32',
  async show(req: DialogRequest): Promise<DialogOutcome> {
    const encoded = Buffer.from(PS, 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, WDLP_TITLE: req.title, WDLP_MESSAGE: req.message, WDLP_TIMEOUT: String(req.timeoutSec) },
      timeoutMs: (req.timeoutSec + 10) * 1000,
    });
    const out = r.stdout.trim().split(/\r?\n/).pop();
    if (out === 'continue') return 'continue';
    if (out === 'timeout') return 'timeout';
    return 'cancel';
  },
};
