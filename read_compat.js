'use strict'

var fs = require('fs')
var path = require('path')
var quickTemp = require('quick-temp')
var mapSeries = require('promise-map-series')
var rimraf = require('rimraf')
var symlinkOrCopy = require('symlink-or-copy')
var symlinkOrCopySync = symlinkOrCopy.sync
const FSTree = require('fs-tree-diff');
const FSMergeTree = require('fs-tree-diff/lib/fs-merge-tree');
const RSVP = require('rsvp');

// Mimic how a Broccoli builder would call a plugin, using quickTemp to create
// directories
module.exports = ReadCompat
function ReadCompat(plugin) {
  this.pluginInterface = plugin.__broccoliGetInfo__()

  quickTemp.makeOrReuse(this, 'outputPath', this.pluginInterface.name)

  if (this.pluginInterface.needsCache) {
    quickTemp.makeOrReuse(this, 'cachePath', this.pluginInterface.name)
  } else {
    this.cachePath = undefined
  }

  quickTemp.makeOrReuse(this, 'inputBasePath', this.pluginInterface.name)

  this.inputPaths = []
  this._priorBuildInputNodeOutputPaths = [];

  if (this.pluginInterface.inputNodes.length === 1) {
    this.inputPaths.push(this.inputBasePath)
    this._priorBuildInputNodeOutputPaths.push(this.inputBasePath);
  } else {
    for (var i = 0; i < this.pluginInterface.inputNodes.length; i++) {
      this.inputPaths.push(path.join(this.inputBasePath, i + ''))
    }
  }

  if (plugin.description == null) {
    plugin.description = this.pluginInterface.name
    if (this.pluginInterface.annotation != null) {
      plugin.description += ': ' + this.pluginInterface.annotation
    }
  }

  this._hasSetup = false;
}

ReadCompat.prototype.setupFS = function () {
  if (this._hasSetup) { return; }

  this.inTree = new FSMergeTree({
    inputs: this.pluginInterface.inputNodes.map(n => n.out || n.outputPath || path.resolve(n))
  });
  this.outTree = new FSTree({
    root: this.outputPath,
    srcTree: !this.fsFacade,
  });

  this.pluginInterface.setup(null, {
    inTree: this.inTree,
    outTree: this.outTree,
    inputPaths: this.inputPaths,
    outputPath: this.outputPath,
    cachePath: this.cachePath
  })

  this.callbackObject = this.pluginInterface.getCallbackObject()

  this._hasSetup = true;
}

ReadCompat.prototype.read = function(readTree) {
  var self = this

  if (!this.pluginInterface.persistentOutput) {
    rimraf.sync(this.outputPath)
    fs.mkdirSync(this.outputPath)
  }

  return mapSeries(this.pluginInterface.inputNodes, readTree)
    .then(function(outputPaths) {
      self.setupFS();

      var priorBuildInputNodeOutputPaths = self._priorBuildInputNodeOutputPaths;
      // In old .read-based Broccoli, the inputNodes's outputPaths can change
      // on each rebuild. But the new API requires that our plugin sees fixed
      // input paths. Therefore, we symlink the inputNodes' outputPaths to our
      // (fixed) inputPaths on each .read.
      for (var i = 0; i < outputPaths.length; i++) {
        var priorPath = priorBuildInputNodeOutputPaths[i]
        var currentPath = outputPaths[i]

        // if this output path is different from last builds or
        // if we cannot symlink then clear and symlink/copy manually
        var hasDifferentPath = priorPath !== currentPath
        var forceReSymlinking = !symlinkOrCopy.canSymlink || hasDifferentPath

        if (forceReSymlinking) {

          // avoid `rimraf.sync` for initial build
          if (priorPath) {
            rimraf.sync(self.inputPaths[i])
          }

          symlinkOrCopySync(currentPath, self.inputPaths[i])
        }
      }

      // save for next builds comparison
      self._priorBuildInputNodeOutputPaths = outputPaths;

      self.inTree.reread();
      self.outTree.start();
      return RSVP.resolve(self.callbackObject.build()).finally(() => self.outTree.stop());
    })
    .then(function() {
      return self.outputPath
    })
}

ReadCompat.prototype.cleanup = function() {
  quickTemp.remove(this, 'outputPath')
  quickTemp.remove(this, 'cachePath')
  quickTemp.remove(this, 'inputBasePath')
}
