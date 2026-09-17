const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onProxyPort: (callback) =>
    ipcRenderer.on("proxy-port", (event, port) => callback(port)),
  onSyncStatus: (callback) =>
    ipcRenderer.on("sync-status", (event, data) => callback(data)),

  checkAuth: () => ipcRenderer.invoke("auth:check"),
  login: () => ipcRenderer.invoke("auth:login"),
  cancelLogin: () => ipcRenderer.invoke("auth:cancel"),
  logout: () => ipcRenderer.invoke("auth:logout"),

  // Drive API
  getDriveInfo: () => ipcRenderer.invoke("drive:get-info"),
  getFolders: () => ipcRenderer.invoke("drive:get-folders"), // ADD THIS
  getFiles: (folderId) => ipcRenderer.invoke("drive:get-files", folderId), // UPDATE THIS
  createSubFolder: (data) => ipcRenderer.invoke("drive:create-folder", data),
  uploadManual: () => ipcRenderer.invoke("drive:upload-manual"),
  deleteFile: (data) => ipcRenderer.invoke("drive:delete-file", data),

  getWatchFolders: () => ipcRenderer.invoke("settings:get-watch-folders"),
  addWatchFolder: () => ipcRenderer.invoke("settings:add-watch-folder"),
  removeWatchFolder: (folderPath) =>
    ipcRenderer.invoke("settings:remove-watch-folder", folderPath),
});
