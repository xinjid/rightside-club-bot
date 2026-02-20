const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
  testSmartShell: (settings) => ipcRenderer.invoke("testSmartShell", settings),
  testBot: (settings) => ipcRenderer.invoke("testBot", settings),
  botStart: (settings) => ipcRenderer.invoke("botStart", settings),
  botStop: () => ipcRenderer.invoke("botStop"),
  getBotStatus: () => ipcRenderer.invoke("getBotStatus"),
  getLogs: () => ipcRenderer.invoke("getLogs"),
  clearLogs: () => ipcRenderer.invoke("clearLogs"),
  copyToClipboard: (text) => ipcRenderer.invoke("copyToClipboard", text),
});
