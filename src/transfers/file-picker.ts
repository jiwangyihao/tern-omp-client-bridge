// SPDX-License-Identifier: MPL-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "../protocol.ts";

const run = promisify(execFile);
const macPicker = `ObjC.import('AppKit');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  var panel = $.NSOpenPanel.openPanel;
  panel.title = 'Upload file to remote OMP';
  panel.message = 'Choose a file from this device. It will be attached to the original remote OMP draft.';
  panel.prompt = 'Upload';
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.allowsMultipleSelection = false;
  app.activateIgnoringOtherApps(true);
  return Number(panel.runModal) === 1 ? JSON.stringify([ObjC.unwrap(panel.URL.path)]) : '[]';
}`;
const windowsPicker = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Upload file to remote OMP'
$d.Multiselect = $false
$d.CheckFileExists = $true
try {
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($d.FileName)))
  } else { [Console]::Out.Write('[]') }
} finally { $d.Dispose() }`;

/** Human-only OS dialog. Never exposed as an agent tool or supplied a remote script. */
export async function chooseUploadFile(signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  let command: string;
  let args: string[];
  let json = true;
  if (process.platform === "darwin") {
    command = "/usr/bin/osascript";
    args = ["-l", "JavaScript", "-e", macPicker];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsPicker];
  } else if (process.platform === "linux" && Bun.which("zenity")) {
    command = "zenity";
    args = ["--file-selection", "--title=Upload file to remote OMP"];
    json = false;
  } else if (process.platform === "linux" && Bun.which("kdialog")) {
    command = "kdialog";
    args = ["--getopenfilename", ".", "--title", "Upload file to remote OMP"];
    json = false;
  } else {
    throw new BridgeError("FILE_PICKER_UNAVAILABLE", "A native file chooser is unavailable. Linux requires zenity or kdialog and a graphical desktop.");
  }
  let stdout: string;
  try {
    ({ stdout } = await run(command, args, { signal, timeout: 120000, maxBuffer: 128 * 1024, windowsHide: true }));
  } catch (error) {
    signal.throwIfAborted();
    if (!json && typeof error === "object" && error !== null && "code" in error && error.code === 1) return undefined;
    throw new BridgeError("FILE_PICKER_FAILED", "The system file chooser failed or timed out; nothing was uploaded.");
  }
  signal.throwIfAborted();
  if (!json) return stdout.replace(/\r?\n$/, "") || undefined;
  const paths: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(paths) || paths.length > 1 || paths.some(value => typeof value !== "string" || !value)) {
    throw new BridgeError("FILE_PICKER_FAILED", "The system file chooser returned an invalid selection.");
  }
  return paths[0];
}
