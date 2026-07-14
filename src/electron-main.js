"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { startIDE } = require("./ide");

let ideHandle;
let mainWindow;
let currentWorkspaceRoot;

function argValue(name, argv = process.argv) {
  const prefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || "");
    if (item === name) {
      return argv[index + 1] ? String(argv[index + 1]) : "";
    }
    if (item.startsWith(prefix)) {
      return item.slice(prefix.length);
    }
  }
  return "";
}

function hasArg(name, argv = process.argv) {
  return argv.some((item) => String(item || "") === name);
}

function defaultWorkspaceRoot() {
  const explicit =
    argValue("--workspace") ||
    process.env.MERGEIDE_WORKSPACE ||
    process.env.MRGMINNER_WORKSPACE ||
    "";
  if (explicit) {
    return path.resolve(explicit);
  }
  if (!app.isPackaged) {
    return process.cwd();
  }
  return path.join(app.getPath("documents"), "MRGMinnerWorkspace");
}

async function ensureWorkspaceRoot(workspaceRoot) {
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createWindow() {
  currentWorkspaceRoot = await ensureWorkspaceRoot(defaultWorkspaceRoot());
  await startIDESession(currentWorkspaceRoot);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: "MRGMinner",
    backgroundColor: "#101215",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalIDEURL(url)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isLocalIDEURL(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  createMenu();
  await mainWindow.loadURL(ideHandle.url);
  if (hasArg("--devtools")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function runSmokeTest() {
  currentWorkspaceRoot = await ensureWorkspaceRoot(defaultWorkspaceRoot());
  await startIDESession(currentWorkspaceRoot);
  console.log(JSON.stringify({
    ok: true,
    url: ideHandle.url,
    workspace_root: currentWorkspaceRoot
  }, null, 2));
  await stopIDESession();
  app.quit();
}

async function startIDESession(workspaceRoot) {
  await stopIDESession();
  ideHandle = await startIDE({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot
  });
}

async function stopIDESession() {
  if (!ideHandle) {
    return;
  }
  const handle = ideHandle;
  ideHandle = undefined;
  await new Promise((resolve) => handle.server.close(() => resolve()));
}

function isLocalIDEURL(value) {
  if (!ideHandle || !value) {
    return false;
  }
  try {
    const url = new URL(value);
    const ideURL = new URL(ideHandle.url);
    return url.origin === ideURL.origin;
  } catch {
    return false;
  }
}

function createMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace...",
          accelerator: "CmdOrCtrl+O",
          click: async () => openWorkspace()
        },
        {
          label: "Open In Browser",
          click: () => ideHandle && shell.openExternal(ideHandle.url)
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit()
        }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "MergeOS",
          click: () => shell.openExternal("https://mergeos.shop")
        },
        {
          label: "MRGMinner Repository",
          click: () => shell.openExternal("https://github.com/mergeos-bounties/MRGMinner")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openWorkspace() {
  if (!mainWindow) {
    return;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open MRGMinner Workspace",
    defaultPath: currentWorkspaceRoot,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths.length) {
    return;
  }
  currentWorkspaceRoot = await ensureWorkspaceRoot(result.filePaths[0]);
  await startIDESession(currentWorkspaceRoot);
  await mainWindow.loadURL(ideHandle.url);
}

function fatalStartup(error) {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
}

app.whenReady()
  .then(() => hasArg("--smoke-test") ? runSmokeTest() : createWindow())
  .catch(fatalStartup);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  stopIDESession().catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

module.exports = {
  argValue,
  defaultWorkspaceRoot,
  hasArg
};
