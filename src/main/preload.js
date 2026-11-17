const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitApp', {
  // Repo management
  clone: (url, targetDir) => ipcRenderer.invoke('git:clone', { url, targetDir }),
  openRepo: () => ipcRenderer.invoke('dialog:openRepo'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),

  // Git operations
  log: (repoPath) => ipcRenderer.invoke('git:log', { repoPath }),
  commitDiff: (repoPath, sha) => ipcRenderer.invoke('git:commitDiff', { repoPath, sha }),
  commitFileDiff: (repoPath, sha, file, oldFile, context) => ipcRenderer.invoke('git:commitFileDiff', { repoPath, sha, file, oldFile, context }),
  checkout:(repoPath, ref) => ipcRenderer.invoke('git:checkout', { repoPath, ref }),
  checkoutRemote: (repoPath, remoteBranch) => ipcRenderer.invoke('git:checkoutRemote', { repoPath, remoteBranch }),
  createBranch: (repoPath, name) => ipcRenderer.invoke('git:createBranch', { repoPath, name }),
  deleteBranch: (repoPath, name) => ipcRenderer.invoke('git:deleteBranch', { repoPath, name }),
  renameBranch: (repoPath, oldName, newName) => ipcRenderer.invoke('git:renameBranch', { repoPath, oldName, newName }),
  status: (repoPath) => ipcRenderer.invoke('git:status', { repoPath }),
  fileDiff: (repoPath, file, staged, untracked, context) => ipcRenderer.invoke('git:fileDiff', { repoPath, file, staged, untracked, context }),
  discard: (repoPath, file, untracked) => ipcRenderer.invoke('git:discard', { repoPath, file, untracked }),
  stage: (repoPath, paths) => ipcRenderer.invoke('git:stage', { repoPath, paths }),
  unstage: (repoPath, paths) => ipcRenderer.invoke('git:unstage', { repoPath, paths }),
  stageAll: (repoPath) => ipcRenderer.invoke('git:stageAll', { repoPath }),
  unstageAll: (repoPath) => ipcRenderer.invoke('git:unstageAll', { repoPath }),
  commit:      (repoPath, message) => ipcRenderer.invoke('git:commit',      { repoPath, message }),
  commitAmend: (repoPath, message) => ipcRenderer.invoke('git:commitAmend', { repoPath, message }),
  squash: (repoPath, shas, message) => ipcRenderer.invoke('git:squash', { repoPath, shas, message }),
  commitMessage:(repoPath, sha) => ipcRenderer.invoke('git:commitMessage', { repoPath, sha }),
  suggestCommit: (repoPath, sha) => ipcRenderer.invoke('git:suggestCommit', { repoPath, sha }),
  push:       (repoPath) => ipcRenderer.invoke('git:push',      { repoPath }),
  pushForce:  (repoPath) => ipcRenderer.invoke('git:pushForce', { repoPath }),
  pull:        (repoPath) => ipcRenderer.invoke('git:pull',       { repoPath }),
  pullBranch:  (repoPath, branch) => ipcRenderer.invoke('git:pullBranch', { repoPath, branch }),
  pullRebase:(repoPath) => ipcRenderer.invoke('git:pullRebase', { repoPath }),
  rebaseOnto:  (repoPath, branch) => ipcRenderer.invoke('git:rebaseOnto', { repoPath, branch }),
  setIcon: (dataUrl) => ipcRenderer.invoke('window:setIcon', { dataUrl }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  openInVscode: (repoPath) => ipcRenderer.invoke('shell:openInVscode', { repoPath }),
  fetch: (repoPath) => ipcRenderer.invoke('git:fetch', { repoPath }),
  refs: (repoPath, fetch) => ipcRenderer.invoke('git:refs', { repoPath, fetch: !!fetch }),

  // Events
  onCloneProgress: (callback) => {
    ipcRenderer.on('git:clone-progress', (event, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
