const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

function build({ entryFile, outputFolder, htmlTemplatePath }) {
  // build dependency graph
  const graph = createDependencyGraph(entryFile);
  // bundle the asset
  const outputFiles = bundle(graph);
  outputFiles.push(generateHTMLTemplate(htmlTemplatePath, outputFiles));
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
    const fileExtension = path.extname(filePath);
    const ModuleCls = MODULE_LOADERS[fileExtension];
    if (!ModuleCls) {
      throw new Error(`Unsupported extension "${fileExtension}".`);
    }
    const module = new ModuleCls(filePath);
    MODULE_CACHE.set(filePath, module);
    module.initDependencies();
  }
  return MODULE_CACHE.get(filePath);
}

class Module {
  constructor(filePath) {
    this.filePath = filePath;
    this.content = fs.readFileSync(filePath, 'utf-8');
    this.transform();
  }
  initDependencies() {
    this.dependencies = [];
  }
  transform() {}
  transformModuleInterface() {}
}

class JSModule extends Module {
  constructor(filePath) {
    super(filePath);
    this.ast = babel.parseSync(this.content);
  }
  initDependencies() {
    this.dependencies = this.findDependencies();
  }
  findDependencies() {
    const importDeclarations = this.ast.program.body.filter(
      node => node.type === 'ImportDeclaration'
    );
    const dependencies = [];
    for (const importDeclaration of importDeclarations) {
      const requestPath = importDeclaration.source.value;
      const resolvedPath = resolveRequest(this.filePath, requestPath);
      dependencies.push(createModule(resolvedPath));

      //replace the request path to the resolved path
      importDeclaration.source.value = resolvedPath;
    }
    return dependencies;
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
                const newIdentifier = path.scope.generateUidIdentifier(
                  'imported'
                );

                for (const specifier of path.get('specifiers')) {
                  const binding = specifier.scope.getBinding(
                    specifier.node.local.name
                  );
                  const importedKey = specifier.isImportDefaultSpecifier()
                    ? 'default'
                    : specifier.get('imported.name').node;

                  for (const referencePath of binding.referencePaths) {
                    referencePath.replaceWith(
                      t.memberExpression(
                        newIdentifier,
                        t.stringLiteral(importedKey),
                        true
                      )
                    );
                  }
                }

                path.replaceWith(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(
                      newIdentifier,
                      t.callExpression(t.identifier('require'), [
                        path.get('source').node,
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

class CSSModule extends Module {
  transform() {
    this.content = trim(`
      const content = '${this.content.replace(/\n/g, '')}';
      const style = document.createElement('style');
      style.type = 'text/css';
      if (style.styleSheet) style.styleSheet.cssText = content;
      else style.appendChild(document.createTextNode(content));
      document.head.appendChild(style);
    `);
  }
}

const MODULE_LOADERS = {
  '.css': CSSModule,
  '.js': JSModule,
};

// resolving
function resolveRequest(requester, requestPath) {
  if (requestPath[0] === '.') {
    // relative import
    return path.join(path.dirname(requester), requestPath);
  } else {
    const requesterParts = requester.split('/');
    const requestPaths = [];
    for (let i = requesterParts.length - 1; i > 0; i--) {
      requestPaths.push(requesterParts.slice(0, i).join('/') + '/node_modules');
    }
    // absolute import
    return require.resolve(requestPath, { paths: requestPaths });
  }
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
    moduleMap += `"${module.filePath}": function(exports, require) { ${module.content}\n },`;
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

function generateHTMLTemplate(htmlTemplatePath, outputFiles) {
  let htmlTemplate = fs.readFileSync(htmlTemplatePath, 'utf-8');
  htmlTemplate = htmlTemplate.replace(
    '</body>',
    outputFiles.map(({ name }) => `<script src="/${name}"></script>`).join('') +
      '</body>'
  );
  return { name: 'index.html', content: htmlTemplate };
}

build({
  entryFile: path.join(__dirname, '../fixture/index.js'),
  outputFolder: path.join(__dirname, '../output'),
  htmlTemplatePath: path.join(__dirname, '../fixture/index.html'),
});
