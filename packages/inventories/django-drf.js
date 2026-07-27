import { definePlugin } from '../plugins/index.js'

const DRF_BASES = new Set([
  'APIView', 'GenericAPIView',
  'ViewSet', 'GenericViewSet', 'ModelViewSet', 'ReadOnlyModelViewSet',
  'CreateAPIView', 'ListAPIView', 'RetrieveAPIView', 'DestroyAPIView', 'UpdateAPIView',
  'ListCreateAPIView', 'RetrieveUpdateAPIView', 'RetrieveDestroyAPIView',
  'RetrieveUpdateDestroyAPIView',
])
const VIEWSET_BASES = new Set(['ViewSet', 'GenericViewSet', 'ModelViewSet', 'ReadOnlyModelViewSet'])
const SIMPLE_JWT_VIEWS = new Set(['TokenObtainPairView', 'TokenRefreshView', 'TokenVerifyView'])
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head'])
const GENERIC_METHODS = Object.freeze({
  CreateAPIView: ['POST'],
  ListAPIView: ['GET'],
  RetrieveAPIView: ['GET'],
  DestroyAPIView: ['DELETE'],
  UpdateAPIView: ['PUT', 'PATCH'],
  ListCreateAPIView: ['GET', 'POST'],
  RetrieveUpdateAPIView: ['GET', 'PUT', 'PATCH'],
  RetrieveDestroyAPIView: ['GET', 'DELETE'],
  RetrieveUpdateDestroyAPIView: ['GET', 'PUT', 'PATCH', 'DELETE'],
})
const VIEWSET_ACTIONS = Object.freeze({
  list: { method: 'GET', detail: false },
  create: { method: 'POST', detail: false },
  retrieve: { method: 'GET', detail: true },
  update: { method: 'PUT', detail: true },
  partial_update: { method: 'PATCH', detail: true },
  destroy: { method: 'DELETE', detail: true },
})

const emptyInventories = () => ({
  routes_endpoints: [], rest_api: [], graphql: [], workers_jobs: [],
  services_finders_policies: [], response_shaping: [], tokens_actors: [],
  downloads_uploads_exports: [], search_aggregation: [], processes_ipc: [],
  datastores_integrations: [],
})

function lineFor(text, offset) {
  return text.slice(0, Math.max(0, offset)).split(/\r?\n/).length
}

function shortSymbol(value) {
  return String(value || '').trim().split('.').pop().replace(/[^\w]/g, '')
}

function normalizePath(value) {
  const raw = String(value || '').trim()
    .replace(/\(\?P<(\w+)>[^)]+\)/g, '{$1}')
    .replace(/<(?:(?:\w+):)?(\w+)>/g, '{$1}')
    .replace(/^\^/, '').replace(/\$$/, '')
  return (`/${raw}`).replace(/\/{2,}/g, '/') || '/'
}

function literalValue(value) {
  return String(value || '').trim().match(/^[rub]*(['"])([\s\S]*?)\1/i)?.[2] ?? null
}

function splitTopLevel(value) {
  const parts = []
  let start = 0
  let quote = ''
  let escaped = false
  let round = 0
  let square = 0
  let curly = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') round++
    else if (char === ')') round--
    else if (char === '[') square++
    else if (char === ']') square--
    else if (char === '{') curly++
    else if (char === '}') curly--
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function calls(text, names) {
  const out = []
  const re = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g')
  let match
  while ((match = re.exec(text))) {
    const open = text.indexOf('(', match.index)
    let quote = ''
    let escaped = false
    let depth = 1
    let end = open + 1
    for (; end < text.length && depth > 0; end++) {
      const char = text[end]
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '(') depth++
      else if (char === ')') depth--
    }
    if (depth === 0) out.push({ name: match[1], body: text.slice(open + 1, end - 1), offset: match.index })
    re.lastIndex = Math.max(re.lastIndex, end)
  }
  return out
}

function importedAliases(text) {
  const aliases = new Map()
  for (const match of text.matchAll(/^\s*from\s+[\w.]+\s+import\s+([^\n#]+)/gm)) {
    for (const item of match[1].replace(/[()]/g, '').split(',')) {
      const pair = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/)
      if (pair) aliases.set(pair[2] || pair[1], pair[1])
    }
  }
  return aliases
}

function parseClasses(ctx) {
  const classes = new Map()
  for (const file of ctx.files.filter(row => row.ext === '.py')) {
    const text = ctx.read(file.path)
    const aliases = importedAliases(text)
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const hit = lines[index].match(/^(\s*)class\s+(\w+)\s*\(([^)]+)\)\s*:/)
      if (!hit) continue
      const indent = hit[1].length
      let end = index + 1
      while (end < lines.length) {
        if (lines[end].trim() && (lines[end].match(/^\s*/)?.[0].length || 0) <= indent) break
        end++
      }
      const bases = hit[3].split(',').map(value => aliases.get(shortSymbol(value)) || shortSymbol(value)).filter(Boolean)
      const methods = new Set()
      const standardActions = []
      const customActions = []
      let pendingAction = null
      const declarations = {}
      for (let bodyIndex = index + 1; bodyIndex < end; bodyIndex++) {
        const bodyLine = lines[bodyIndex]
        const action = bodyLine.match(/^\s*@action\s*\(([\s\S]*)\)\s*$/)
        if (action) {
          const declared = action[1].match(/methods\s*=\s*\[([^\]]*)\]/)?.[1] || ''
          pendingAction = {
            detail: /detail\s*=\s*True/.test(action[1]),
            methods: [...declared.matchAll(/['"](\w+)['"]/g)].map(row => row[1].toUpperCase()),
            line: bodyIndex + 1,
          }
          continue
        }
        const method = bodyLine.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/)?.[1]
        if (method) {
          if (HTTP_METHODS.has(method.toLowerCase())) methods.add(method.toUpperCase())
          if (VIEWSET_ACTIONS[method]) standardActions.push({ name: method, ...VIEWSET_ACTIONS[method], line: bodyIndex + 1 })
          if (pendingAction) {
            customActions.push({
              name: method,
              detail: pendingAction.detail,
              methods: pendingAction.methods.length ? pendingAction.methods : ['GET'],
              line: bodyIndex + 1,
            })
            pendingAction = null
          }
        }
        for (const [key, pattern] of [
          ['permissions', /^\s*permission_classes\s*=\s*(.+?)\s*(?:#.*)?$/],
          ['authentication', /^\s*authentication_classes\s*=\s*(.+?)\s*(?:#.*)?$/],
          ['throttles', /^\s*throttle_classes\s*=\s*(.+?)\s*(?:#.*)?$/],
        ]) {
          const declaration = bodyLine.match(pattern)
          if (declaration) declarations[key] = { value: declaration[1].trim(), line: bodyIndex + 1 }
        }
      }
      classes.set(hit[2], {
        name: hit[2], file: file.path, line: index + 1, bases, methods,
        standardActions, customActions, declarations, isDrf: false, isViewSet: false,
      })
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const view of classes.values()) {
      const drf = view.bases.some(base => DRF_BASES.has(base) || classes.get(base)?.isDrf)
      const viewSet = view.bases.some(base => VIEWSET_BASES.has(base) || classes.get(base)?.isViewSet)
      if (drf !== view.isDrf || viewSet !== view.isViewSet) {
        view.isDrf = drf
        view.isViewSet = viewSet
        changed = true
      }
    }
  }
  for (const view of classes.values()) {
    for (const base of view.bases) for (const method of GENERIC_METHODS[base] || []) view.methods.add(method)
    if (view.isViewSet && !view.standardActions.length) {
      const actions = view.bases.includes('ReadOnlyModelViewSet')
        ? ['list', 'retrieve']
        : ['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy']
      for (const action of actions) view.standardActions.push({ name: action, ...VIEWSET_ACTIONS[action], line: view.line })
    }
  }
  return classes
}

function parseFunctions(ctx) {
  const functions = new Map()
  for (const file of ctx.files.filter(row => row.ext === '.py')) {
    const lines = ctx.read(file.path).split(/\r?\n/)
    let apiMethods = null
    const declarations = {}
    for (let index = 0; index < lines.length; index++) {
      const api = lines[index].match(/^\s*@api_view\s*\(\s*\[([^\]]*)\]\s*\)/)
      if (api) {
        apiMethods = [...api[1].matchAll(/['"](\w+)['"]/g)].map(row => row[1].toUpperCase())
        continue
      }
      for (const [key, pattern] of [
        ['permissions', /^\s*@permission_classes\s*\(\s*(.+)\s*\)/],
        ['authentication', /^\s*@authentication_classes\s*\(\s*(.+)\s*\)/],
        ['throttles', /^\s*@throttle_classes\s*\(\s*(.+)\s*\)/],
      ]) {
        const declaration = lines[index].match(pattern)
        if (declaration) {
          declarations[key] = { value: declaration[1].trim(), line: index + 1 }
          continue
        }
      }
      const fn = lines[index].match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/)
      if (fn) {
        if (apiMethods) functions.set(fn[1], {
          name: fn[1], file: file.path, line: index + 1, methods: new Set(apiMethods),
          declarations: { ...declarations }, isDrf: true, isViewSet: false,
        })
        apiMethods = null
        for (const key of Object.keys(declarations)) delete declarations[key]
      } else if (lines[index].trim() && !lines[index].trim().startsWith('@') && !lines[index].trim().startsWith('#')) {
        apiMethods = null
        for (const key of Object.keys(declarations)) delete declarations[key]
      }
    }
  }
  return functions
}

function authNotes(view) {
  return [
    view.declarations?.authentication?.value ? `authentication_classes=${view.declarations.authentication.value}` : '',
    view.declarations?.permissions?.value ? `permission_classes=${view.declarations.permissions.value}` : '',
    view.declarations?.throttles?.value ? `throttle_classes=${view.declarations.throttles.value}` : '',
  ].filter(Boolean).join('; ') || 'DRF defaults inherited'
}

function explicitMethods(asViewBody) {
  return [...String(asViewBody || '').matchAll(/['"](\w+)['"]\s*:\s*['"](\w+)['"]/g)]
    .map(row => row[1].toUpperCase())
}

function restRow({ file, line, method, endpoint, view, symbol, detail, handler = symbol, purpose }) {
  return {
    file, line, entry: `${method} '${endpoint}'`, detail, method, path: endpoint,
    api_class: symbol, handler, handler_file: view.file || '', handler_line: view.line || 0,
    purpose, auth_notes: authNotes(view),
  }
}

function djangoDrfInventory(ctx) {
  const out = emptyInventories()
  const classes = parseClasses(ctx)
  const functions = parseFunctions(ctx)
  const knownViews = new Map([...classes, ...functions])
  for (const name of SIMPLE_JWT_VIEWS) knownViews.set(name, {
    name, file: '', line: 0, methods: new Set(['POST']), declarations: {
      authentication: { value: 'SimpleJWT', line: 0 },
    }, isDrf: true, external: true,
  })

  for (const file of ctx.files.filter(row => /(^|\/)urls\.py$/.test(row.path))) {
    const text = ctx.read(file.path)
    const aliases = importedAliases(text)
    for (const call of calls(text, ['path', 're_path', 'url'])) {
      const args = splitTopLevel(call.body)
      const route = literalValue(args[0])
      if (route == null || !args[1]) continue
      const endpoint = normalizePath(route)
      const asView = args[1].match(/([\w.]+)\.as_view\s*\(([\s\S]*)\)/)
      const localSymbol = shortSymbol(asView ? asView[1] : args[1])
      const symbol = aliases.get(localSymbol) || localSymbol
      const view = knownViews.get(symbol)
      const routeLine = lineFor(text, call.offset)
      out.routes_endpoints.push({
        file: file.path, line: routeLine, entry: `route '${endpoint}'`,
        detail: 'django-route', method: 'ANY', path: endpoint, handler: localSymbol || args[1].trim(),
      })
      if (!view?.isDrf) continue
      const methods = explicitMethods(asView?.[2])
      const inferred = methods.length ? methods : [...(view.methods || [])]
      for (const method of inferred.length ? inferred : ['ANY']) {
        out.rest_api.push(restRow({
          file: file.path, line: routeLine, method, endpoint, view, symbol,
          detail: 'django-drf-route', purpose: `DRF ${symbol} operation`,
        }))
      }
    }
  }

  for (const file of ctx.files.filter(row => row.ext === '.py')) {
    const text = ctx.read(file.path)
    const aliases = importedAliases(text)
    for (const call of calls(text, ['register'])) {
      const before = text.slice(Math.max(0, call.offset - 32), call.offset)
      if (!/\w*router\s*\.\s*$/.test(before)) continue
      const args = splitTopLevel(call.body)
      const prefix = literalValue(args[0])
      const localSymbol = shortSymbol(args[1])
      const symbol = aliases.get(localSymbol) || localSymbol
      const view = classes.get(symbol)
      if (prefix == null || !view?.isViewSet) continue
      const routeLine = lineFor(text, call.offset)
      out.routes_endpoints.push({
        file: file.path, line: routeLine, entry: `router '${normalizePath(`${prefix}/`)}'`,
        detail: 'django-router', method: 'RESOURCE', path: normalizePath(`${prefix}/`), handler: localSymbol,
      })
      for (const action of view.standardActions) {
        const endpoint = normalizePath(`${prefix}/${action.detail ? '{pk}/' : ''}`)
        out.rest_api.push(restRow({
          file: file.path, line: routeLine, method: action.method, endpoint, view, symbol,
          detail: 'django-drf-router', handler: `${symbol}.${action.name}`,
          purpose: `DRF ${symbol} ${action.name} operation`,
        }))
      }
      for (const action of view.customActions) for (const method of action.methods) {
        const endpoint = normalizePath(`${prefix}/${action.detail ? '{pk}/' : ''}${action.name.replaceAll('_', '-')}/`)
        out.rest_api.push(restRow({
          file: file.path, line: routeLine, method, endpoint, view, symbol,
          detail: 'django-drf-action', handler: `${symbol}.${action.name}`,
          purpose: `DRF custom action ${action.name}`,
        }))
      }
    }
  }

  for (const view of [...classes.values(), ...functions.values()]) {
    if (!view.isDrf) continue
    for (const [key, detail] of [
      ['authentication', 'authentication'],
      ['permissions', 'permission'],
      ['throttles', 'throttle'],
    ]) {
      const declaration = view.declarations?.[key]
      if (!declaration) continue
      out.tokens_actors.push({
        file: view.file, line: declaration.line,
        entry: `${view.name} ${key === 'permissions' ? 'permission_classes' : `${key}_classes`}=${declaration.value}`,
        detail,
      })
    }
  }
  for (const file of ctx.files.filter(row => row.ext === '.py')) {
    const lines = ctx.read(file.path).split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*class\s+\w+\s*\([^)]*\bBasePermission\b/.test(lines[index])) {
        out.services_finders_policies.push({
          file: file.path, line: index + 1, entry: lines[index].trim(), detail: 'policy',
        })
      }
    }
  }
  return out
}

export const djangoDrfPlugin = definePlugin({
  id: 'django-drf',
  langs: ['Python'],
  detect(profile) {
    return (profile?.frameworks || []).some(value => /^Django$/i.test(value))
  },
  inventory: djangoDrfInventory,
})

export const _test = {
  calls, splitTopLevel, normalizePath, parseClasses, parseFunctions, djangoDrfInventory,
}
