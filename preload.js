const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
  testSmartShell: (settings) => ipcRenderer.invoke("testSmartShell", settings),
  getSmartShellStatus: () => ipcRenderer.invoke("getSmartShellStatus"),
  testBot: (settings) => ipcRenderer.invoke("testBot", settings),
  botStart: (settings) => ipcRenderer.invoke("botStart", settings),
  botStop: () => ipcRenderer.invoke("botStop"),
  getBotStatus: () => ipcRenderer.invoke("getBotStatus"),
  createInvite: (payload) => ipcRenderer.invoke("invite:create", payload),
  getLogs: () => ipcRenderer.invoke("getLogs"),
  clearLogs: () => ipcRenderer.invoke("clearLogs"),
  copyToClipboard: (text) => ipcRenderer.invoke("copyToClipboard", text),
  botConsoleRunCommand: (payload) => ipcRenderer.invoke("botConsole:runCommand", payload),
  botConsoleGetMessages: () => ipcRenderer.invoke("botConsole:getMessages"),
  botConsoleClear: () => ipcRenderer.invoke("botConsole:clear"),
  discountJobsList: (payload) => ipcRenderer.invoke("discountJobs:list", payload),
  discountJobsCancel: (payload) => ipcRenderer.invoke("discountJobs:cancel", payload),
  onBotConsoleMessage: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("botConsole:message", listener);
    return () => {
      ipcRenderer.removeListener("botConsole:message", listener);
    };
  },
});
