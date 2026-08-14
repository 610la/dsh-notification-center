// Build the web plugin bundle:
//   src/client.js  -> lib/client.js  (window.__ModuleLoader__.load wrapper)
//   src/index.js   -> lib/index.js   (host plugin, copied as-is)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'lib'), { recursive: true })

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const client = readFileSync(join(root, 'src', 'client.js'), 'utf8')

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tconst React = require("react");
${client}
\t\texports.inject = ["slots", "timer"];
\t\texports.apply = apply;
\t\treturn module.exports;
\t}
});
`

writeFileSync(join(root, 'lib', 'client.js'), bundle)
copyFileSync(join(root, 'src', 'index.js'), join(root, 'lib', 'index.js'))
console.log('built lib/client.js + lib/index.js')
