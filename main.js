const { app, BrowserWindow, Menu } = require('electron');

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1000, minHeight: 700,
    title: '홀덤', autoHideMenuBar: true, backgroundColor: '#0B0E0D',
    webPreferences: { contextIsolation: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile('index.html');
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
