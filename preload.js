const { contextBridge, ipcRenderer } = require('electron');

// Безопасный API для renderer (index.html)
// Добавляй сюда методы, которые реально используешь в UI.
contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),

  // Bot control
  botStart: () => ipcRenderer.invoke('bot:start'),
  botStop: () => ipcRenderer.invoke('bot:stop'),
  botStatus: () => ipcRenderer.invoke('bot:status'),

  // Bot console (run commands)
  runCommand: (payload) => ipcRenderer.invoke('botConsole:runCommand', payload),

  // Events
  onBotConsoleMessage: (cb) => ipcRenderer.on('botConsole:message', (_, msg) => cb(msg)),
});
