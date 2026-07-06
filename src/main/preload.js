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
  fetch: (repoPath) => ipcRenderer.invoke('git:fetch', { repoPath }),

  // Events
  onCloneProgress: (callback) => {
    ipcRenderer.on('git:clone-progress', (event, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
