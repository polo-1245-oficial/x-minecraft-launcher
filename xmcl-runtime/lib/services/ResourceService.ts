import { AnyPersistedResource, AnyResource, ImportResourceOptions, ImportResourcesOptions, isPersistedResource, ParseResourceOptions, ParseResourcesOptions, PersistedResource, Resource, ResourceDomain, ResourceException, ResourceService as IResourceService, ResourceServiceKey, ResourceSources, ResourceState, ResourceType, UpdateResourceOptions } from '@xmcl/runtime-api'
import { task } from '@xmcl/task'
import { ClassicLevel } from 'classic-level'
import { createHash } from 'crypto'
import { existsSync, FSWatcher } from 'fs'
import { ensureDir, ensureFile, unlink, writeFile } from 'fs-extra'
import watch from 'node-watch'
import { join } from 'path'
import LauncherApp from '../app/LauncherApp'
import { FileStat, persistResource, readFileStat, ResourceCache } from '../entities/resource'
import { migrateToDatabase } from '../util/dataFix'
import { checksum, copyPassively, FileType, linkOrCopy, readdirEnsured } from '../util/fs'
import { requireString } from '../util/object'
import { createPromiseSignal } from '../util/promiseSignal'
import { Singleton, StatefulService } from './Service'

export interface ParseResourceContext {
  stat?: FileStat
  sha1?: string
  fileType?: FileType
}

export interface Query {
  hash?: string
  url?: string | string[]
  ino?: number
}

/**
 * Watch the related resource directory changes.
 *
 * Import resource process.
 *
 * 1. Parse resource file and get metadata, and push the pending metadata queue.
 * 2. Copy or link or rename the resource file to domain directory.
 *    1. If rename, it will emit a remove event to watcher, which will be ignore if the original file path is not in cache.
 * 3. The watcher find a new resource file enter the domain
 *    1. If the new file is in pending queue, it will use the metadata in pending queue
 *    2. If the new file has no pending metadata, it will re-parse the metadata, which returns step 1
 * 4. The watcher write the parsed the resource metadata
 * 5. The watcher get the metadata json update event, and validate & update the metadata cache & state
 */
export class ResourceService extends StatefulService<ResourceState> implements IResourceService {
  private cache = new ResourceCache()

  readonly storage: ClassicLevel<string, PersistedResource> = new ClassicLevel(join(this.app.appDataPath, 'resources'), { keyEncoding: 'hex', valueEncoding: 'json' })
  /**
   * The array to store the pending to import resource file path, which is the absolute file path of the resource file under the domain directory
   */
  private pending = new Set<string>()

  private pendingSource: Record<string, ResourceSources> = {}

  private loadPromises = {
    [ResourceDomain.Mods]: createPromiseSignal(),
    [ResourceDomain.Saves]: createPromiseSignal(),
    [ResourceDomain.ResourcePacks]: createPromiseSignal(),
    [ResourceDomain.Modpacks]: createPromiseSignal(),
    [ResourceDomain.ShaderPacks]: createPromiseSignal(),
    [ResourceDomain.Unknown]: createPromiseSignal(),
  }

  private watchers: Record<ResourceDomain, FSWatcher | undefined> = {
    [ResourceDomain.Mods]: undefined,
    [ResourceDomain.Saves]: undefined,
    [ResourceDomain.ResourcePacks]: undefined,
    [ResourceDomain.Modpacks]: undefined,
    [ResourceDomain.ShaderPacks]: undefined,
    [ResourceDomain.Unknown]: undefined,
  }

  protected normalizeResource(resource: string | AnyPersistedResource | AnyResource): AnyPersistedResource | undefined {
    if (typeof resource === 'string') {
      return this.cache.get(resource)
    }
    if (isPersistedResource(resource)) {
      return resource
    }
    return this.cache.get(resource.hash)
  }

  constructor(app: LauncherApp) {
    super(app, ResourceServiceKey, () => new ResourceState(), async () => {
      for (const domain of [
        ResourceDomain.Mods,
        ResourceDomain.ResourcePacks,
        ResourceDomain.Saves,
        ResourceDomain.Modpacks,
        ResourceDomain.ShaderPacks,
        ResourceDomain.Unknown,
      ]) {
        this.loadPromises[domain].accept(this.load(domain))
      }
      const result = await this.storage.values().all()
      this.log(`Load ${result.length} resources from database.`)
      this.commitResources(result)
      await ensureDir(this.getAppDataPath('resource-images'))
    })
  }

  /**
   * Query in memory resource by key.
   * The key can be `hash`, `url` or `ino` of the file.
   */
  getResourceByKey(key: string | number): AnyPersistedResource | undefined {
    return this.cache.get(key)
  }

  isResourceInCache(key: string | number) {
    return !!this.cache.get(key)
  }

  /**
   * Query resource in memory by the resource query
   * @param query The resource query.
   */
  getResource(query: Query) {
    let res: PersistedResource | undefined
    if (query.hash) {
      res = this.cache.get(query.hash)
      if (res) return res
    }
    if (query.url) {
      if (typeof query.url === 'string') {
        res = this.cache.get(query.url)
        if (res) return res
      } else {
        for (const u of query.url) {
          res = this.cache.get(u)
          if (res) return res
        }
      }
    }
    if (query.ino) {
      res = this.cache.get(query.ino)
      if (res) return res
    }
    return undefined
  }

  @Singleton(d => d)
  async load(domain: ResourceDomain) {
    const path = this.getPath(domain)
    const files = await readdirEnsured(path)
    await migrateToDatabase.call(this, domain, files.map(f => join(path, f)))

    this.watchers[domain] = watch(path, async (event, name) => {
      if (event === 'remove') {
        if (name.endsWith('.json') || name.endsWith('.png') || name.endsWith('.pending')) {
          // json removed means the resource is totally removed
        } else {
          // this will remove
          const resource = this.cache.get(name)
          if (resource) {
            this.removeResourceInternal(resource)
            this.log(`Remove resource ${resource.path} with its metadata`)
          } else {
            this.log(`Skip to remove untracked resource ${name} & its metadata`)
          }
        }
      } else {
        if (name.endsWith('.png') || name.endsWith('.pending')) {
          return
        }
        // new file found, try to resolve & import it
        if (this.pending.has(name)) {
          // just ignore pending file. It will handle once the json metadata file is updated
          this.pending.delete(name)
          this.log(`Ignore re-import a manually importing file ${name}`)
          return
        }
        try {
          this.log(`Try to import new file ${name}`)
          await this.importResource({ restrictToDomain: domain, path: name, optional: true })
        } catch (e) {
          this.emit('error', e)
        }
      }
    })
  }

  whenReady(resourceDomain: ResourceDomain) {
    return this.loadPromises[resourceDomain].promise
  }

  /**
   * Remove a resource from the launcher
   * @param resourceOrKey
   */
  async removeResource(resourceOrKey: string | AnyPersistedResource) {
    const resource = this.normalizeResource(resourceOrKey)
    if (!resource) {
      throw new ResourceException({
        type: 'resourceNotFoundException',
        resource: resourceOrKey as string,
      })
    }
    await this.removeResourceInternal(resource)
  }

  async updateResource(options: UpdateResourceOptions): Promise<void> {
    const resource = this.normalizeResource(options.resource)
    if (!resource) {
      throw new ResourceException({
        type: 'resourceNotFoundException',
        resource: options.resource as string,
      })
    }
    const newResource: PersistedResource<any> = { ...resource }
    if (options.name) {
      newResource.name = options.name
    }
    if (options.tags) {
      const tags = options.tags
      newResource.tags = tags
    }
    if (options.uri) {
      newResource.uri = options.uri
    }
    if (options.source) {
      newResource.curseforge = options.source.curseforge ?? newResource.curseforge
      newResource.modrinth = options.source.modrinth ?? newResource.modrinth
      newResource.github = options.source.github ?? newResource.github
    }
    if (options.iconUrl) {
      newResource.iconUrl = options.iconUrl
    }
    this.state.resource(newResource)
    await this.storage.put(newResource.hash, newResource)
  }

  /**
   * Parse a single file as a resource and return the resource object
   * @param options The parse file option
   */
  async resolveResource(options: ParseResourceOptions): Promise<[AnyResource, Uint8Array | undefined]> {
    const { path } = options
    const context: ParseResourceContext = {}
    const existed = await this.queryExistedResourceByPath(path, context)
    if (existed && existed.domain !== ResourceDomain.Unknown) {
      return [{ ...existed, path }, undefined]
    }
    const [resource, icon] = await this.parseResource(options, context)
    return [resource as AnyResource, icon]
  }

  /**
   * Parse multiple files and return corresponding resources
   * @param options The parse multiple files options
   */
  async resolveResources(options: ParseResourcesOptions) {
    return Promise.all(options.files.map((f) => this.resolveResource({
      path: f.path,
      source: f.source,
      type: f.type ?? options.type,
      url: f.url,
    })))
  }

  markResourceSource(sha1: string, source: ResourceSources) {
    this.pendingSource[sha1] = source
  }

  /**
   * Import the resource into the launcher.
   * @returns The resource resolved. If the resource cannot be resolved, it will goes to unknown domain.
   */
  async importResource(options: ImportResourceOptions & { optional?: boolean }): Promise<AnyPersistedResource> {
    requireString(options.path)
    const context: ParseResourceContext = {}
    const existed = await this.queryExistedResourceByPath(options.path, context)
    if (existed) {
      this.log(`Skip to import ${options.path} as resource existed in ${existed.path}`)
      const update: UpdateResourceOptions = {
        resource: existed,
      }
      if (options.source) {
        update.source = {
          curseforge: options.source.curseforge ?? existed.curseforge,
          modrinth: options.source.modrinth ?? existed.modrinth,
        }
      }
      if (options.url) {
        const urls = new Set(existed.uri)
        for (const u of options.url) {
          urls.add(u)
        }
        update.uri = [...urls]
      }
      if (options.iconUrl) {
        update.iconUrl = options.iconUrl
      }
      await this.updateResource(update)
      return existed
    }
    if (context.sha1) {
      const source = this.pendingSource[context.sha1]
      if (options.source) {
        options.source = { ...source, ...options.source }
      } else {
        options.source = source
      }
      delete this.pendingSource[context.sha1]
    }

    if (options.restrictToDomain && (context.fileType === 'unknown' || context.fileType === 'directory') && options.optional) {
      return undefined as any
    }

    const task = this.importFileTask(options, context)
    const resource = await (options.background ? task.startAndWait() : this.submit(task))

    if (resource.domain === ResourceDomain.Modpacks) {
      this.emit('modpackImport', { path: resource.path, name: resource.name })
    }

    this.log(`Persist newly added resource ${resource.path} -> ${resource.domain}`)
    return resource
  }

  /**
  * Import the resource from the same disk. This will parse the file and import it into our db by hard link.
  * If the file already existed, it will not re-import it again
  *
  * The original file will not be modified.
  *
  * @param options The options to import the resources
  *
  * @returns All import file in resource form. If the file cannot be parsed, it will be UNKNOWN_RESOURCE.
  */
  async importResources(options: ImportResourcesOptions) {
    const existedResources: AnyPersistedResource[] = []
    const newResources: AnyPersistedResource[] = []
    const errors: any[] = []
    await Promise.all(options.files.map(async (f) => {
      const context: ParseResourceContext = {}
      const existed = await this.queryExistedResourceByPath(f.path, context)
      if (existed) {
        this.log(`Skip to import ${f.path} as resource existed in ${existed.path}`)
        const update: UpdateResourceOptions = {
          resource: existed,
        }
        if (f.source) {
          update.source = {
            curseforge: f.source.curseforge ?? existed.curseforge,
            modrinth: f.source.modrinth ?? existed.modrinth,
          }
        }
        if (f.url) {
          const urls = new Set(existed.uri)
          for (const u of f.url) {
            urls.add(u)
          }
          update.uri = [...urls]
        }
        if (f.iconUrl) {
          update.iconUrl = f.iconUrl
        }
        await this.updateResource(update)
        existedResources.push(existed)
      } else {
        try {
          const task = this.importFileTask({
            path: f.path,
            url: f.url,
            source: f.source,
            type: f.type ?? options.type,
            background: options.background,
            restrictToDomain: options.restrictToDomain,
          }, context)
          const result = await (options.background ? task.startAndWait() : this.submit(task))
          this.log(`Import and cache newly added resource ${result.path} -> ${result.domain}`)
          newResources.push(result)
        } catch (e) {
          errors.push(e)
        }
      }
    }))

    const existedCount = existedResources.length
    const unknownCount = newResources.filter(r => r.type === ResourceType.Unknown).length
    const newCount = newResources.length

    if (options.restrictToDomain) {
      this.log(`Resolve ${existedResources.length} resources from /${options.restrictToDomain}. Imported ${newCount} new resources, ${existedCount} resources existed, and ${unknownCount} unknown resource.`)
    } else {
      this.log(`Resolve ${existedResources.length} resources. Imported ${newCount} new resources, ${existedCount} resources existed, and ${unknownCount} unknown resource.`)
    }

    return newResources
  }

  /**
   * Export the resources into target directory. This will simply copy the resource out.
   * If a resource is not found, the export process will be abort. This is not a transaction process.
   */
  async exportResource(payload: { resources: (string | AnyResource)[]; targetDirectory: string }) {
    const { resources, targetDirectory } = payload

    const promises = [] as Array<Promise<any>>
    for (const r of resources) {
      const resource = this.normalizeResource(r)
      if (!resource) {
        throw new ResourceException({
          type: 'resourceNotFoundException',
          resource: r,
        })
      }
      promises.push(copyPassively(resource.path, join(targetDirectory, resource.fileName)))
    }
    await Promise.all(promises)
  }

  async dispose(): Promise<void> {
    for (const watcher of Object.values(this.watchers)) {
      watcher?.close()
    }
  }

  // helper methods

  getExistedCurseforgeResource(projectId: number, fileId: number) {
    const mod = this.state.mods.find(m => m.curseforge && m.curseforge.fileId === fileId && m.curseforge.projectId === projectId)
    if (mod) return mod
    const res = this.state.resourcepacks.find(m => m.curseforge && m.curseforge.fileId === fileId && m.curseforge.projectId === projectId)
    if (res) return res
  }

  getExistedModrinthResource(projId: string, verId: string) {
    const mod = this.state.mods.find(m => m.modrinth && m.modrinth.projectId === projId && m.modrinth.versionId === verId)
    if (mod) return mod
  }

  async queryExistedResourceByPath(path: string, context: ParseResourceContext) {
    let result: AnyPersistedResource | undefined

    let stats = context?.stat
    if (!stats) {
      stats = await readFileStat(path)
      if (context) {
        context.stat = stats
      }
    }

    if (!stats.isDirectory) {
      result = this.getResourceByKey(stats.ino)

      if (!result) {
        if (context?.sha1) {
          result = this.getResourceByKey(context.sha1)
        } else {
          const [sha1, fileType] = await this.worker().checksumAndFileType(path, 'sha1')
          if (context) {
            context.sha1 = sha1
            context.fileType = fileType
          }
          result = this.getResourceByKey(sha1)
        }
      }
    } else {
      context.sha1 = ''
      context.fileType = 'directory'
    }

    return result
  }

  /**
   * Parse a file into resource
   * @param options The parse option
   * @param context The resource context
   * @returns The resolved resource and icon
   */
  async parseResource(options: ParseResourceOptions, context: ParseResourceContext) {
    const { path, type } = options
    const [resolved, icon] = await this.worker().parseResource({
      path,
      context,
      hint: type ?? '*',
    })
    if (options.url) {
      resolved.uri.unshift(...options.url)
    }
    return [resolved, icon] as const
  }

  /**
  * The internal method which should be called in-services. You should first call {@link parseResource} to get resolved resource and icon
  * @see {queryExistedResourceByPath}
  */
  async importParsedResource(options: ImportResourceOptions, resolved: Resource, icon: Uint8Array | undefined) {
    if (options.restrictToDomain && resolved.domain !== options.restrictToDomain && resolved.domain !== ResourceDomain.Unknown) {
      throw new ResourceException({
        type: 'resourceDomainMismatched',
        path: options.path,
        expectedDomain: options.restrictToDomain,
        actualDomain: resolved.domain,
        actualType: resolved.type,
      }, `Non-${options.restrictToDomain} resource at ${options.path} type=${resolved.type}`)
    }
    if (resolved.domain === ResourceDomain.Unknown && options.restrictToDomain) {
      // enforced unknown resource domain
      resolved.domain = options.restrictToDomain
    }

    if (options.iconUrl) {
      resolved.iconUrl = options.iconUrl
    } else if (icon) {
      // persist image
      resolved.iconUrl = await this.addImage(icon)
    }

    Object.assign(resolved, options.source ?? {})

    const result = await persistResource(resolved, this.getPath(), this.pending)

    await this.storage.put(result.hash, result)
    this.commitResources([result])

    return result as AnyPersistedResource
  }

  async addImage(pathOrData: string | Uint8Array) {
    const sha1 = typeof pathOrData === 'string' ? await checksum(pathOrData, 'sha1') : createHash('sha1').update(pathOrData).digest('hex')
    const imagePath = join(this.app.appDataPath, 'resource-images', sha1)
    if (!existsSync(imagePath)) {
      await ensureFile(imagePath)
      if (typeof pathOrData === 'string') {
        await linkOrCopy(pathOrData, imagePath)
      } else {
        await writeFile(imagePath, pathOrData)
      }
    }
    return `image://${sha1}`
  }

  /**
   * Resolve resource task. This will not write the resource to the cache, but it will persist the resource to disk.
   * @throws DomainMissMatchedError
   */
  private importFileTask(options: ImportResourceOptions, context: ParseResourceContext) {
    return task('importResource', async () => {
      if (!context.stat) {
        context.stat = await readFileStat(options.path)
      }
      if (context.stat.isDirectory) {
        throw new ResourceException({
          type: 'resourceImportDirectoryException',
          path: options.path,
        })
      }
      const [resolved, icon] = await this.parseResource(options, context)
      return this.importParsedResource(options, resolved, icon)
    })
  }

  private commitResources(resources: PersistedResource[]) {
    for (const resource of resources) {
      this.cache.put(resource as any)
    }
    this.state.resources(resources as any)
  }

  protected async removeResourceInternal(resource: PersistedResource<any>) {
    if (resource.path !== resource.storedPath) {
      this.warn(`Removing a stored resource from external reference: ${resource.path}. ${resource.storedPath}`)
    }
    this.state.resourcesRemove([resource])
    this.cache.discard(resource)
    this.storage.del(resource.hash)
    await unlink(resource.storedPath).catch(() => { })
  }
}
