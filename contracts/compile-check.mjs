// Arnes de compilacion de contratos.
//
// POR QUE EXISTE, Y POR QUE NO SUSTITUYE A FOUNDRY
//
// `contracts/` no se ejecutaba en ningun sitio: no hay `forge`, no hay `anvil`, y
// `tsc` no mira un unico `.sol`. Un contrato que no compila se puede commitear
// sin que nada se entere, y un contrato que compila tampoco demuestra que
// fonctionne. Lo unico que esto da es el primer escalon: que el fuente sea
// Solidity valido para la version y las opciones de EVM con las que se despliega.
//
// NO es un test de contrato. No hay invariantes en ejecucion, no hay fuzzing y
// no hay despliegue. Lo que falta para eso sigue pendiente y esta en AGENTS.md.
//
// USO:  node contracts/compile-check.mjs     (o `pnpm compile:contracts`)
//
// REQUIERE RED en la primera ejecucion, porque solc se baja por `npx`. Sin red el
// script falla con un mensaje claro y no se lo salta: un "todo bien" sin
// compilar seria peor que no tener el arnes.
//
// OPCIONES DE COMPILACION, Y POR QUE SON ESTAS
//
//   evmVersion: cancun. No es una preferencia estetica. OpenZeppelin 5.6.1 usa
//   `mcopy` en `Bytes.sol`, y `mcopy` es un builtin de Cancun. Con el `paris`
//   o el `shanghai` que trae por defecto 0.8.24, el compilador falla con
//   `DeclarationError: Function "mcopy" not found` en un fichero del que este
//   repositorio no es responsable. Sin esto el arnes no arranca.
//
//   optimizer runs 200. Es el mismo valor que documentan los ABI en
//   `lib/*-abi.ts`, para que el binario que se despliega corresponda al ABI que
//   se leyo del artefacto.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOLC_VERSION = '0.8.24'

/** Los `.sol` de este directorio. Los fixtures de test, si algun dia los hay, se excluyen aqui. */
const sources = {}
for (const file of readdirSync(HERE).filter((f) => f.endsWith('.sol') && !f.startsWith('Test')).sort()) {
  sources[`contracts/${file}`] = { urls: [`contracts/${file}`] }
}

if (Object.keys(sources).length === 0) {
  console.error('no hay contratos en contracts/')
  process.exit(1)
}

const input = JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})

// En Windows `npx` a secas es un shim de PowerShell (`npx.ps1`) que `spawnSync`
// no puede ejecutar, y el fallo es `ENOENT` sin ninguna pista de que existe. La
// variante `.cmd` es la que si resuelve.
// En Windows `npx` a secas es un shim de PowerShell (`npx.ps1`) que `spawnSync`
// no puede ejecutar, y el fallo es `ENOENT` sin ninguna pista de que existe. La
// variante `.cmd` es la que si resuelve, pero desde Node 20 los `.cmd` no se
// pueden lanzar sin `shell`, y sin ella el error pasa a ser `EINVAL`. Ninguno de
// los dos mensajes dice "el problema es Windows", asi que los dos casos estan aqui
// escritos y comentados.
const NPMX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const run = spawnSync(NPMX, ['--yes', `solc@${SOLC_VERSION}`, '--standard-json', '--base-path', '.', '--include-path', 'node_modules'], {
  cwd: ROOT,
  input,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
})

if (run.error) {
  console.error('no se pudo ejecutar solc. hace falta red para bajarlo por npx la primera vez.')
  console.error(String(run.error))
  process.exit(1)
}

// solc escribe avisos en stdout antes del JSON, asi que se recorta desde la
// primera llave. Sin esto el parseo falla con un error que no dice nada del
// contrato que se estaba compilando.
const stdout = run.stdout ?? ''
const start = stdout.indexOf('{')
if (start < 0) {
  console.error(stdout.trim() || 'solc no devolvio nada')
  process.exit(1)
}

let output
try {
  output = JSON.parse(stdout.slice(start))
} catch {
  console.error('la salida de solc no es JSON legible')
  process.exit(1)
}

const diagnostics = output.errors ?? []
const errors = diagnostics.filter((d) => d.severity === 'error')
const warnings = diagnostics.filter((d) => d.severity === 'warning')

for (const diagnostic of warnings) console.log(`  aviso  ${diagnostic.formattedMessage.split('\n')[0]}`)
for (const diagnostic of errors) console.error(`  ERROR  ${diagnostic.formattedMessage.trim()}`)

if (errors.length > 0) {
  console.error(`\n${errors.length} errores de compilacion`)
  process.exit(1)
}

// `output.contracts` viene como un objeto indexado por fichero, no como un array,
// y dentro de el hay interfaces junto a contratos. Un contrato se distingue por
// tener bytecode: una interfaz compila igual y no se despliega, asi que listarla
// como "contrato que compila" seria un dato falso. Filtrar por el prefijo `I`
// funciona hoy y dejaria de funcionar el dia que un contrato se llamara `Impulse`.
const compiled = Object.entries(output.contracts ?? {})
  .filter(([file]) => file.startsWith('contracts/'))
  .flatMap(([file, contracts]) =>
    Object.entries(contracts)
      .filter(([, artifact]) => (artifact.evm?.bytecode?.object ?? '').length > 0)
      .map(([name]) => `${file} -> ${name}`),
  )
  .sort()

for (const entry of compiled) console.log(`  OK   ${entry}`)

const empty = Object.entries(output.contracts ?? {})
  .filter(([file]) => file.startsWith('contracts/'))
  .map(([file]) => file)
  .filter((file) => !compiled.some((entry) => entry.startsWith(`${file} ->`)))
if (empty.length > 0) console.log(`  aviso  sin bytecode desplegable: ${empty.join(', ')}`)

console.log(`\n${compiled.length} contratos compilan con solc ${SOLC_VERSION} (cancun, optimizer 200)${warnings.length ? `, ${warnings.length} avisos` : ''}`)