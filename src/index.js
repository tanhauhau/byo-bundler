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

const MODULE_CACHE = new Map();

function createModule(filePath) {
  if (!MODULE_CACHE.has(filePath)) {
    const module = new Module(filePath);
    MODULE_CACHE.set(filePath, module);
    module.initDependencies();
  }
  return MODULE_CACHE.get(filePath);
}

class Module {
  constructor(filePath) {
    this.filePath = filePath;
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.ast = babel.parseSync(this.content);
  }
  initDependencies() {
    this.dependencies = this.findDependencies();
  }
  findDependencies() {
    return this.ast.program.body
      .filter(node => node.type === 'ImportDeclaration')
      .map(node => node.source.value)
      .map(relativePath => resolveRequest(this.filePath, relativePath))
      .map(absolutePath => createModule(absolutePath));
  }
  transformModuleInterface() {
    const { types: t } = babel;
    const { filePath } = this;
    const { ast, code } = babel.transformFromAstSync(this.ast, this.content, {
      ast: true,
      plugins: [
        function() {
          return {
            visitor: {
              ImportDeclaration(path) {
                const properties = path.get('specifiers').map(specifier => {
                  const imported = specifier.isImportDefaultSpecifier()
                    ? t.identifier('default')
                    : specifier.get('imported').node;
                  const local = specifier.get('local').node;

                  return t.objectProperty(imported, local, false, false);
                });
                path.replaceWith(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(
                      t.objectPattern(properties),
                      t.callExpression(t.identifier('require'), [
                        t.stringLiteral(
                          resolveRequest(
                            filePath,
                            path.get('source.value').node
                          )
                        ),
                      ])
                    ),
                  ])
                );
              },
              ExportDefaultDeclaration(path) {
                path.replaceWith(
                  t.expressionStatement(
                    t.assignmentExpression(
                      '=',
                      t.memberExpression(
                        t.identifier('exports'),
                        t.identifier('default'),
                        false
                      ),
                      t.toExpression(path.get('declaration').node)
                    )
                  )
                );
              },
              ExportNamedDeclaration(path) {
                const declarations = [];
                if (path.has('declaration')) {
                  if (path.get('declaration').isFunctionDeclaration()) {
                    declarations.push({
                      name: path.get('declaration.id').node,
                      value: t.toExpression(path.get('declaration').node),
                    });
                  } else {
                    path
                      .get('declaration.declarations')
                      .forEach(declaration => {
                        declarations.push({
                          name: declaration.get('id').node,
                          value: declaration.get('init').node,
                        });
                      });
                  }
                } else {
                  path.get('specifiers').forEach(specifier => {
                    declarations.push({
                      name: specifier.get('exported').node,
                      value: specifier.get('local').node,
                    });
                  });
                }
                path.replaceWithMultiple(
                  declarations.map(decl =>
                    t.expressionStatement(
                      t.assignmentExpression(
                        '=',
                        t.memberExpression(
                          t.identifier('exports'),
                          decl.name,
                          false
                        ),
                        decl.value
                      )
                    )
                  )
                );
              },
            },
          };
        },
      ],
    });
    this.ast = ast;
    this.content = code;
  }
}

// resolving
function resolveRequest(requester, requestPath) {
  return path.join(path.dirname(requester), requestPath);
}

// bundling
function bundle(graph) {
  const modules = collectModules(graph);
  const moduleMap = toModuleMap(modules);
  const moduleCode = addRuntime(moduleMap, modules[0].filePath);
  return [{ name: 'bundle.js', content: moduleCode }];
}

function collectModules(graph) {
  const modules = new Set();
  collect(graph, modules);
  return Array.from(modules);

  function collect(module, modules) {
    if (!modules.has(module)) {
      modules.add(module);
      module.dependencies.forEach(dependency => collect(dependency, modules));
    }
  }
}

function toModuleMap(modules) {
  let moduleMap = '';
  moduleMap += '{';

  for (const module of modules) {
    module.transformModuleInterface();
    moduleMap += `"${module.filePath}": function(exports, require) { ${module.content} },`;
  }

  moduleMap += '}';
  return moduleMap;
}

function addRuntime(moduleMap, entryPoint) {
  return trim(`
    const modules = ${moduleMap};
    const entry = "${entryPoint}";
    function webpackStart({ modules, entry }) {
      const moduleCache = {};
      const require = moduleName => {
        // if in cache, return the cached version
        if (moduleCache[moduleName]) {
          return moduleCache[moduleName];
        }
        const exports = {};
        // this will prevent infinite "require" loop
        // from circular dependencies
        moduleCache[moduleName] = exports;
    
        // "require"-ing the module,
        // exported stuff will assigned to "exports"
        modules[moduleName](exports, require);
        return moduleCache[moduleName];
      };
    
      // start the program
      require(entry);
    }

    webpackStart({ modules, entry });
    `);
}

function trim(str) {
  const lines = str.split('\n').filter(Boolean);
  const padLength = lines[0].length - lines[0].trimLeft().length;
  const regex = new RegExp(`^\\s{${padLength}}`);
  return lines.map(line => line.replace(regex, '')).join('\n');
}

build({
  entryFile: path.join(__dirname, '../fixture/index.js'),
  outputFolder: path.join(__dirname, '../output'),
});
