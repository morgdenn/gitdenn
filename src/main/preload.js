const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitApp', {
  // Repo management
  clone: (url, targetDir) => ipcRenderer.invoke('git:clone', { url, targetDir }),
  openRepo: () => ipcRenderer.invoke('dialog:openRepo'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),

  // Git operations
  log: (repoPath) => ipcRenderer.invoke('git:log', { repoPath }),
  commitDiff: (repoPath, sha) => ipcRenderer.invoke('git:commitDiff', { repoPath, sha }),
  checkout: (repoPath, ref) => ipcRenderer.invoke('git:checkout', { repoPath, ref }),
  checkoutRemote: (repoPath, remoteBranch) => ipcRenderer.invoke('git:checkoutRemote', { repoPath, remoteBranch }),
  createBranch: (repoPath, name) => ipcRenderer.invoke('git:createBranch', { repoPath, name }),
  status: (repoPath) => ipcRenderer.invoke('git:status', { repoPath }),
  stage: (repoPath, paths) => ipcRenderer.invoke('git:stage', { repoPath, paths }),
  unstage: (repoPath, paths) => ipcRenderer.invoke('git:unstage', { repoPath, paths }),
  stageAll: (repoPath) => ipcRenderer.invoke('git:stageAll', { repoPath }),
  unstageAll: (repoPath) => ipcRenderer.invoke('git:unstageAll', { repoPath }),
  commit: (repoPath, message) => ipcRenderer.invoke('git:commit', { repoPath, message }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  openInVscode: (repoPath) => ipcRenderer.invoke('shell:openInVscode', { repoPath }),
  fetch: (repoPath) => ipcRenderer.invoke('git:fetch', { repoPath }),

  // Events
  onCloneProgress: (callback) => {
    ipcRenderer.on('git:clone-progress', (event, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
