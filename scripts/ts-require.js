const fs = require('node:fs');
const ts = require('typescript');

function installTypeScriptRequire() {
  const previous = require.extensions['.ts'];

  require.extensions['.ts'] = function compileTypeScript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true
      },
      fileName: filename
    });

    module._compile(compiled.outputText, filename);
  };

  return function restoreTypeScriptRequire() {
    if (previous) {
      require.extensions['.ts'] = previous;
      return;
    }

    delete require.extensions['.ts'];
  };
}

module.exports = {
  installTypeScriptRequire
};
