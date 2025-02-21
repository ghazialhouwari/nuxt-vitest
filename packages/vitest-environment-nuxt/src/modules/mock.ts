import type { Import } from 'unimport'
import { addVitePlugin, defineNuxtModule } from '@nuxt/kit'
import { walk } from 'estree-walker'
import type { CallExpression } from 'estree'
import { AcornNode } from 'rollup'
import MagicString from 'magic-string'
import { Component } from '@nuxt/schema'

const PLUGIN_NAME = 'nuxt:vitest:mock-transform'

const HELPER_MOCK_IMPORT = 'mockNuxtImport'
const HELPER_MOCK_COMPONENT = 'mockComponent'

const HELPERS_NAME = [HELPER_MOCK_IMPORT, HELPER_MOCK_COMPONENT]

export interface MockImportInfo {
  name: string
  import: Import
  factory: string
}

export interface MockComponentInfo {
  path: string
  factory: string
}

/**
 * This module is a macro that transforms `mockNuxtImport()` to `vi.mock()`,
 * which make it possible to mock Nuxt imports.
 */
export default defineNuxtModule({
  meta: {
    name: PLUGIN_NAME,
  },
  setup(_, nuxt) {
    let imports: Import[] = []
    let components: Component[] = []

    nuxt.hook('imports:extend', _ => {
      imports = imports.concat(_)
    })
    nuxt.hook('imports:sources', _ => {
      // add core nuxt composables to imports
      imports = imports.concat(
        // cast presets to imports
        _.filter(item => item.from === '#app').flatMap(item =>
          item.imports.flatMap(name => {
            return name.toString().startsWith('use')
              ? {
                  name: name,
                  as: name,
                  from: item.from,
                }
              : []
          })
        ) as Import[]
      )
    })
    nuxt.hook('components:extend', _ => {
      components = _
    })

    addVitePlugin({
      name: PLUGIN_NAME,
      enforce: 'post',
      transform: {
        order: 'post',
        handler(code, id) {
          if (!HELPERS_NAME.some(n => code.includes(n))) return
          if (id.includes('/node_modules/')) return

          let ast: AcornNode
          try {
            ast = this.parse(code, {
              sourceType: 'module',
              ecmaVersion: 'latest',
              ranges: true,
            })
          } catch (e) {
            return
          }

          let insertionPoint = 0
          let hasViImport = false

          const s = new MagicString(code)
          const mocksImport: MockImportInfo[] = []
          const mocksComponent: MockComponentInfo[] = []

          walk(ast as any, {
            enter: node => {
              // find existing vi import
              if (
                node.type === 'ImportDeclaration' &&
                node.source.value === 'vitest' &&
                !hasViImport
              ) {
                if (
                  node.specifiers.find(
                    i =>
                      i.type === 'ImportSpecifier' && i.imported.name === 'vi'
                  )
                ) {
                  insertionPoint = node.range![1]
                  hasViImport = true
                }
                return
              }

              if (node.type !== 'CallExpression') return
              const call = node as CallExpression
              // mockNuxtImport
              if (
                call.callee.type === 'Identifier' &&
                call.callee.name === HELPER_MOCK_IMPORT
              ) {
                if (call.arguments.length !== 2) {
                  return this.error(
                    new Error(
                      `${HELPER_MOCK_IMPORT}() should have exactly 2 arguments`
                    ),
                    call.range![0]
                  )
                }
                if (call.arguments[0].type !== 'Literal') {
                  return this.error(
                    new Error(
                      `The first argument of ${HELPER_MOCK_IMPORT}() must be a string literal`
                    ),
                    call.arguments[0].range![0]
                  )
                }
                const name = call.arguments[0].value as string
                const importItem = imports.find(_ => name === (_.as || _.name))
                if (!importItem) {
                  return this.error(`Cannot find import "${name}" to mock`)
                }

                s.overwrite(call.range![0], call.range![1], '')
                mocksImport.push({
                  name,
                  import: importItem,
                  factory: code.slice(
                    call.arguments[1].range![0],
                    call.arguments[1].range![1]
                  ),
                })
              }
              // mockComponent
              if (
                call.callee.type === 'Identifier' &&
                call.callee.name === HELPER_MOCK_COMPONENT
              ) {
                if (call.arguments.length !== 2) {
                  return this.error(
                    new Error(
                      `${HELPER_MOCK_COMPONENT}() should have exactly 2 arguments`
                    ),
                    call.range![0]
                  )
                }
                if (call.arguments[0].type !== 'Literal') {
                  return this.error(
                    new Error(
                      `The first argument of ${HELPER_MOCK_COMPONENT}() must be a string literal`
                    ),
                    call.arguments[0].range![0]
                  )
                }
                const pathOrName = call.arguments[0].value as string
                const component = components.find(
                  _ => _.pascalName === pathOrName || _.kebabName === pathOrName
                )
                const path = component?.filePath || pathOrName

                s.overwrite(call.range![0], call.range![1], '')
                mocksComponent.push({
                  path: path,
                  factory: code.slice(
                    call.arguments[1].range![0],
                    call.arguments[1].range![1]
                  ),
                })
              }
            },
          })

          if (mocksImport.length === 0 && mocksComponent.length === 0) return

          const mockLines = []

          if (mocksImport.length) {
            const mockImportMap = new Map<string, MockImportInfo[]>()
            for (const mock of mocksImport) {
              if (!mockImportMap.has(mock.import.from)) {
                mockImportMap.set(mock.import.from, [])
              }
              mockImportMap.get(mock.import.from)!.push(mock)
            }
            mockLines.push(
              ...Array.from(mockImportMap.entries()).flatMap(
                ([from, mocks]) => {
                  const lines = [
                    `vi.mock(${JSON.stringify(
                      from
                    )}, async (importOriginal) => {`,
                    `  const mod = { ...await importOriginal() }`,
                  ]
                  for (const mock of mocks) {
                    lines.push(
                      `  mod[${JSON.stringify(mock.name)}] = await (${
                        mock.factory
                      })()`
                    )
                  }
                  lines.push(`  return mod`)
                  lines.push(`})`)
                  return lines
                }
              )
            )
          }

          if (mocksComponent.length) {
            mockLines.push(
              ...mocksComponent.flatMap(mock => {
                return [
                  `vi.mock(${JSON.stringify(mock.path)}, async () => {`,
                  `  const factory = (${mock.factory});`,
                  `  const result = typeof factory === 'function' ? await factory() : await factory`,
                  `  return 'default' in result ? result : { default: result }`,
                  '})',
                ]
              })
            )
          }

          if (!mockLines.length) return

          if (!hasViImport) mockLines.unshift(`import {vi} from "vitest";`)

          s.appendLeft(insertionPoint, '\n' + mockLines.join('\n') + ';\n')

          return {
            code: s.toString(),
            map: s.generateMap(),
          }
        },
      },
    })
  },
})
