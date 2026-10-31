const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const Store = require("electron-store");
const chokidar = require("chokidar");
const express = require("express");
const cors = require("cors");
const mime = require("mime-types");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

// --- Configuration ---
const APP_TOKEN =
  "9f7b4ee180d9749553211fb49b770e6893c10d2e54d44a765c2edc49a38edda0";
const SERVER_URL = "https://zvault-oauth-server.onrender.com";
const store = new Store();

// --- State ---
let mainWindow = null;
let tray = null;
let isQuitting = false;
let watcher = null;
let isUploading = false;
let isLoginCancelled = false;
const uploadQueue = [];

// --- Local Streaming Proxy ---
const proxyApp = express();
proxyApp.use(cors());
let proxyServer;
let proxyPort = 0;

proxyApp.get("/stream/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fetchOptions = { method: "GET", headers: {} };

    if (req.headers.range) {
      fetchOptions.headers["Range"] = req.headers.range;
    }

    const response = await fetchWithAutoRefresh(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      fetchOptions,
    );

    if (!response.ok)
      return res.status(response.status).send("Error fetching media");

    res.setHeader(
      "Content-Type",
      response.headers.get("Content-Type") || "application/octet-stream",
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (response.headers.has("Content-Length"))
      res.setHeader("Content-Length", response.headers.get("Content-Length"));
    if (response.headers.has("Content-Range"))
      res.setHeader("Content-Range", response.headers.get("Content-Range"));

    res.status(response.status);

    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
    nodeStream.on("error", (err) => console.error("Stream error:", err));
  } catch (error) {
    if (!res.headersSent) res.status(500).send("Error streaming file");
  }
});

// --- Window & App Lifecycle ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile("index.html");
  mainWindow.setMenu(null);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once("ready-to-show", () => {
    proxyServer = proxyApp.listen(0, () => {
      proxyPort = proxyServer.address().port;
      mainWindow.webContents.send("proxy-port", proxyPort);
    });

    if (!process.argv.includes("--hidden")) {
      mainWindow.show();
    }
    setupAutoSync();
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("before-quit", (event) => {
    if (uploadQueue.length > 0 && !isQuitting) {
      const choice = dialog.showMessageBoxSync({
        type: "warning",
        buttons: ["Quit Anyway", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Upload in Progress",
        message: "Files are currently uploading to Google Drive.",
        detail:
          "If you quit now, the current uploads will be cancelled and will resume next time.",
      });

      if (choice === 1) {
        event.preventDefault();
      } else {
        isQuitting = true;
      }
    }
  });

  app.whenReady().then(() => {
    app.setLoginItemSettings({
      openAtLogin: true,
      args: ["--hidden"],
      path: app.getPath("exe"),
    });

    const trayIconPath = path.join(__dirname, "assets", "icon.png");
    const trayIcon = nativeImage
      .createFromPath(trayIconPath)
      .resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
      { label: "Open Media Sync", click: () => mainWindow.show() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setToolTip("Media Sync");
    tray.setContextMenu(contextMenu);
    tray.on("click", () => mainWindow.show());

    createWindow();
    try {
      autoUpdater.checkForUpdatesAndNotify();
    } catch (e) {
      console.error("Updater error:", e);
    }
  });
}

// Listen for the completed download
autoUpdater.on("update-downloaded", (info) => {
  dialog
    .showMessageBox({
      type: "info",
      title: "Update Ready",
      message: `Version ${info.version} of Media Sync has been downloaded.`,
      detail: "Restart the application to apply the updates.",
      buttons: ["Restart Now", "Later"],
    })
    .then((result) => {
      if (result.response === 0) {
        isQuitting = true; // bypasses the "hide to tray" logic
        autoUpdater.quitAndInstall();
      }
    });
});

// --- Custom Fetch Wrapper with Auto-Refresh ---
async function fetchWithAutoRefresh(url, options = {}) {
  let tokens = store.get("auth_tokens");
  if (!tokens || !tokens.access_token)
    throw new Error("No access token found in store");

  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${tokens.access_token}`,
  };
  let res = await fetch(url, options);

  if (res.status === 401 && tokens.refresh_token) {
    const refreshRes = await fetch(`${SERVER_URL}/auth/google/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zvault-app-token": APP_TOKEN,
      },
      body: JSON.stringify({ refreshToken: tokens.refresh_token }),
    });

    if (!refreshRes.ok) {
      store.delete("auth_tokens");
      throw new Error("Session expired. Please log in again.");
    }

    const newTokens = await refreshRes.json();
    store.set("auth_tokens", {
      ...tokens,
      ...newTokens,
      refresh_token: newTokens.refresh_token || tokens.refresh_token,
    });

    options.headers["Authorization"] = `Bearer ${newTokens.access_token}`;
    res = await fetch(url, options);
  }

  if (!res.ok) {
    console.log(res);

    throw new Error(`API Error: ${res.statusText}`);
  }
  return res;
}

// --- Auth IPC ---
ipcMain.handle("auth:cancel", () => {
  isLoginCancelled = true;
});
ipcMain.handle("auth:check", () => store.has("auth_tokens"));
ipcMain.handle("auth:logout", () => {
  store.delete("auth_tokens");
  return { success: true };
});

ipcMain.handle("auth:login", async () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  isLoginCancelled = false;

  try {
    const res = await fetch(
      `${SERVER_URL}/auth/google/url?code_challenge=${challenge}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-zvault-app-token": APP_TOKEN,
        },
      },
    );
    if (!res.ok) throw new Error("Init failed");
    const { url, sessionId } = await res.json();

    await shell.openExternal(url);
    const pollStartTime = Date.now();

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        if (isLoginCancelled) {
          clearInterval(interval);
          return reject(new Error("CANCELLED"));
        }
        if (Date.now() - pollStartTime > 300000) {
          clearInterval(interval);
          return reject(new Error("Login timed out."));
        }
        try {
          const exchangeRes = await fetch(
            `${SERVER_URL}/auth/google/exchange`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-zvault-app-token": APP_TOKEN,
              },
              body: JSON.stringify({ sessionId, codeVerifier: verifier }),
            },
          );

          if (!exchangeRes.ok) return;
          const data = await exchangeRes.json();
          if (data.tokens) {
            clearInterval(interval);
            store.set("auth_tokens", data.tokens);
            setupAutoSync();
            resolve({ success: true, email: data.tokens.user_email });
          }
        } catch (e) {}
      }, 2000);
    });
  } catch (error) {
    throw new Error("Authentication failed");
  }
});

// --- Drive Folders & Uploads ---
async function getOrCreateMediaFolder() {
  const query = encodeURIComponent(
    "mimeType='application/vnd.google-apps.folder' and name='media' and trashed=false",
  );
  const res = await fetchWithAutoRefresh(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
  );
  const data = await res.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  const createRes = await fetchWithAutoRefresh(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "media",
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
  );
  const createData = await createRes.json();
  return createData.id;
}

async function getOrCreateDriveSubFolder(folderName, parentId) {
  // 1. Escape single quotes and backslashes for the Google Drive query string
  const safeFolderName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${safeFolderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const res = await fetchWithAutoRefresh(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
  );
  const data = await res.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  const createRes = await fetchWithAutoRefresh(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    },
  );
  const createData = await createRes.json();
  return createData.id;
}

async function executeDriveUpload(filePath, targetFolderId) {
  const fileName = path.basename(filePath);
  const mimeType = mime.lookup(filePath) || "application/octet-stream";
  const fileSize = fs.statSync(filePath).size;

  const initRes = await fetchWithAutoRefresh(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": fileSize.toString(),
      },
      body: JSON.stringify({ name: fileName, parents: [targetFolderId] }),
    },
  );

  const uploadUrl = initRes.headers.get("Location");
  const fileStream = fs.createReadStream(filePath);

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": fileSize.toString(),
      Authorization: `Bearer ${store.get("auth_tokens").access_token}`,
    },
    body: fileStream,
    duplex: "half",
  });

  if (!uploadRes.ok) throw new Error("Upload transfer failed");
  return await uploadRes.json();
}

async function processQueue() {
  if (uploadQueue.length === 0 || isUploading) return;
  isUploading = true;
  const rootMediaFolderId = await getOrCreateMediaFolder();

  while (uploadQueue.length > 0) {
    const currentFile = uploadQueue[0];
    const fileName = path.basename(currentFile);
    const parentFolderName = path.basename(path.dirname(currentFile));

    if (mainWindow)
      mainWindow.webContents.send("sync-status", {
        status: `Uploading ${fileName}...`,
        queueLength: uploadQueue.length,
      });

    try {
      const targetDriveFolderId = await getOrCreateDriveSubFolder(
        parentFolderName,
        rootMediaFolderId,
      );
      await executeDriveUpload(currentFile, targetDriveFolderId);

      const history = store.get("upload_history") || [];
      if (!history.includes(currentFile)) {
        history.push(currentFile);
        store.set("upload_history", history);
      }
      // Delete the local file after a successful upload
      try {
        fs.unlinkSync(currentFile);
      } catch (fsError) {
        console.error(`Could not delete local file ${currentFile}:`, fsError);
      }
      uploadQueue.shift();
    } catch (error) {
      console.error(`Failed to upload ${currentFile}`, error);
      uploadQueue.shift();
    }
  }

  isUploading = false;
  if (mainWindow)
    mainWindow.webContents.send("sync-status", {
      status: "Idle",
      queueLength: 0,
    });
}

// --- Watch Folders Logic ---
function setupAutoSync() {
  if (watcher) watcher.close();
  if (!store.has("auth_tokens")) return;

  const folders = store.get("watch_folders") || [];
  if (folders.length === 0) return;

  watcher = chokidar.watch(folders, { persistent: true, ignoreInitial: false });
  watcher.on("add", (filePath) => {
    const mimeType = mime.lookup(filePath);
    if (
      mimeType &&
      (mimeType.startsWith("video/") || mimeType.startsWith("audio/"))
    ) {
      const history = store.get("upload_history") || [];
      if (!history.includes(filePath)) {
        uploadQueue.push(filePath);
        processQueue();
      }
    }
  });
}

// --- Drive IPC Handlers ---
ipcMain.handle("drive:get-info", async () => {
  const res = await fetchWithAutoRefresh(
    "https://www.googleapis.com/drive/v3/about?fields=storageQuota,user",
  );
  return await res.json();
});

// --- Fetch Folders for Sidebar ---
ipcMain.handle("drive:get-folders", async () => {
  try {
    const folderId = await getOrCreateMediaFolder();
    // Only fetch folders inside the root media directory
    const query = encodeURIComponent(
      `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );

    const res = await fetchWithAutoRefresh(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime)&orderBy=name`,
    );

    const data = await res.json();
    return data.files || [];
  } catch (err) {
    console.error("Fetch folders error:", err);
    return [];
  }
});

// --- Fetch Files inside a specific Folder ---
ipcMain.handle("drive:get-files", async (event, targetFolderId) => {
  if (!targetFolderId) return []; // Prevent fetching if no folder is selected
  try {
    const query = encodeURIComponent(
      `'${targetFolderId}' in parents and trashed=false`,
    );

    const res = await fetchWithAutoRefresh(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,size,thumbnailLink,createdTime)&orderBy=createdTime desc`,
    );

    const data = await res.json();
    if (!data.files) return [];

    // Filter only media files
    return data.files.filter(
      (f) => f.mimeType.startsWith("video/") || f.mimeType.startsWith("audio/"),
    );
  } catch (err) {
    console.error("Fetch files error:", err);
    return [];
  }
});

ipcMain.handle(
  "drive:create-folder",
  async (event, { folderName, parentId }) => {
    const rootId = parentId || (await getOrCreateMediaFolder());
    const res = await fetchWithAutoRefresh(
      "https://www.googleapis.com/drive/v3/files",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [rootId],
        }),
      },
    );
    return await res.json();
  },
);

// Delete google drive file AND remove from local history
ipcMain.handle("drive:delete-file", async (event, { fileId, fileName }) => {
  await fetchWithAutoRefresh(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    { method: "DELETE" },
  );

  // Remove from upload_history so it can be re-uploaded in the future
  if (fileName) {
    let history = store.get("upload_history") || [];
    // Filter out any local paths that end with this file name
    history = history.filter(
      (filePath) => path.basename(filePath) !== fileName,
    );
    store.set("upload_history", history);
  }
  return { success: true };
});

ipcMain.handle("drive:upload-manual", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Media", extensions: ["mp4", "mp3", "wav", "mkv", "avi"] },
    ],
  });
  if (!result.canceled) {
    result.filePaths.forEach((filePath) => uploadQueue.push(filePath));
    processQueue();
  }
});

// --- Settings IPC ---
ipcMain.handle("settings:add-watch-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (!result.canceled) {
    const folders = store.get("watch_folders") || [];
    if (!folders.includes(result.filePaths[0])) {
      folders.push(result.filePaths[0]);
      store.set("watch_folders", folders);
      setupAutoSync();
    }
    return folders;
  }
});

ipcMain.handle(
  "settings:get-watch-folders",
  () => store.get("watch_folders") || [],
);
ipcMain.handle("settings:remove-watch-folder", (event, folder) => {
  let folders = store.get("watch_folders") || [];
  folders = folders.filter((f) => f !== folder);
  store.set("watch_folders", folders);
  setupAutoSync();
  return folders;
});
