const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

function build({ entryFile, outputFolder }) {
  // build dependency graph
  const graph = createDependencyGraph(entryFile);
  // bundle the asset
  const outputFiles = bundle(graph);
  // write to output folder
  for (const outputFile of outputFiles) {
    fs.writeFileSync(
      path.join(outputFolder, outputFile.name),
      outputFile.content,
      'utf-8'
    );
  }
}

function createDependencyGraph(entryFile) {
  const rootModule = createModule(entryFile);
  return rootModule;
}

function createModule(filePath) {
  return new Module(filePath);
}

class Module {
  constructor(filePath) {
    this.filePath = filePath;
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.ast = babel.parseSync(this.content);
    this.dependencies = this.findDependencies();
  }
  findDependencies() {
    return this.ast.program.body
      .filter(node => node.type === 'ImportDeclaration')
      .map(node => node.source.value)
      .map(relativePath => resolveRequest(this.filePath, relativePath))
      .map(absolutePath => createModule(absolutePath));
  }
}

// resolving
function resolveRequest(requester, requestPath) {
  return path.join(path.dirname(requester), requestPath);
}

// bundling
function bundle(graph) {
  return [];
}

build({
  entryFile: path.join(__dirname, '../fixture/index.js'),
  outputFolder: path.join(__dirname, '../output'),
});
