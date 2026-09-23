'use strict';
const path = require('node:path');

function workspaceRelativeFile(workspacePath, uri) {
  if (!uri || uri.scheme !== 'file' || !uri.fsPath) return null;
  const relative = path.relative(workspacePath, uri.fsPath);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative;
}

module.exports = { workspaceRelativeFile };
