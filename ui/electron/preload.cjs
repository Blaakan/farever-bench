// ---------------------------------------------------------------------------
// Preload for the setup window only (the sheet itself is plain http and needs
// nothing from Electron). Three calls across the bridge, no node in the page:
// the renderer can ask for a folder picker, hear why the last answer was
// refused, and give up. Everything that touches the filesystem - the picker,
// the hlboot.dat/Farever.exe check, remembering the answer - stays in
// main.cjs.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  // -> {ok:true, dir} | {ok:false, why}  ('' = the user cancelled the picker)
  browse: () => ipcRenderer.invoke('setup:browse'),
  quit: () => ipcRenderer.send('setup:quit'),
  onProblem: (fn) => ipcRenderer.on('setup:problem', (_e, text) => fn(text)),
});
