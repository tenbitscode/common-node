import EventEmitter from 'events'
import merge from 'lodash/merge'
import flatten from 'flat'
import filterQuery from './filterQuery'

/**
 * queries: $in, $nin, $gt, $gte, $lt, $lte, $ne etc.,
 *
 * @typedef {object} FilterOptions
 * @property {string} FilterOptions.$select comma separated fields ex: name,city,address.state
 * @property {number} FilterOptions.$limit
 * @property {number} FilterOptions.$offset
 * @property {string} FilterOptions.$startCursor
 * @property {string} FilterOptions.$endCursor
 * @property {string} FilterOptions.$sort comman separated fields example: -name for descending or -name,city
 */

/**
 * @typedef {object} Update
 * @property {object} $set
 * @property {object} $inc
 */

/**
 * Created Event
 *
 * @event Datastore#{name}.created
 * @type {object}
 * @property {array} entities
 */

/**
 * Updated Event
 *
 * @event Datastore#{name}.updated
 * @type {object}
 * @property {array} entities
 */

/**
 * Deleted Event
 *
 * @event Datastore#{name}.deleted
 * @type {object}
 * @property {array} ids
 */

/**
  * Transaction callback
  *
  * @callback Datastore~transactionCallback
  * @param {object} transaction
  */

export default class Datastore extends EventEmitter {
  /**
   * @example
   *
   * // entity schema is similar to json schema
   * // can provide validators for create and update, by default entity is validated on create
   * const schema = new Schema({
   *   name: 'user',
   *   entity: {
   *     type: 'object',
   *     properties: {
   *       name: { type: 'string' }
   *     }
   *   }
   * })
   *
   * const adapter = new MongoDatastoreAdapter({
   *   url: 'mongodb://mongodb:27017',
   *   dbName: 'test'
   * })
   *
   * Or, adapter as function so as to return adapter specific to tenant
   *
   * const adapter = (options) => {
   *   return new MongoDatastoreAdapter({
   *     url: 'mongodb://mongodb:27017',
   *     dbName: `test-${options.tenantId}`
   *   })
   * }
   *
   * const datastore = new Datastore({
   *   schema,
   *   adapter
   * })
   *
   * // will create entity
   * const entity = await datastore.insertOne({ name: 'name' })
   *
   * // will fail because name is of type string
   * const entity = await datastore.insertOne({ name: 1 })
   *
   * datastore.on('*', (eventName, data) => {})
   * datastore.on('user.created', ({ entities, insertedCount }) => {})
   * datastore.on('user.updated', ({ entities, updatedCount, filter }) => {})
   * datastore.on('user.deleted', ({ ids, deletedCount, filter }) => {})
   *
   * @param {object} config
   * @param {object} config.schema
   * @param {object|function} config.adapter
   */
  constructor (config) {
    super()
    this.adapter = config.adapter
    this.schema = config.schema
  }

  /**
   * Converts user given update into adatper update data structure
   * @example
   *
   * Given:
   * { name: 'name', state: 'state' }
   *
   * Output:
   * {
   *   update: { $set: { name: 'name', state: 'state' } },
   *   validate: { name: 'name', state: 'state' }
   * }
   *
   * Given:
   * { name: 'name', state: 'state', $set: { suburb: 'suburb' } }
   *
   * Output:
   * {
   *   update: { $set: { name: 'name', state: 'state', suburb: 'suburb' } },
   *   validate: { name: 'name', state: 'state', suburb: 'suburb' }
   * }
   *
   * Given:
   * { name: 'name', state: 'state', $inc: { total: 10 } }
   *
   * Output:
   * {
   *   update: { $set: { name: 'name', state: 'state' }, $inc: { total: 10 } },
   *   validate: { name: 'name', state: 'state', total: 10 }
   * }
   *
   * @private
   * @param {object} update
   */
  convertUpdate (update) {
    if (!update) {
      throw new Error('update is empty. You must specify at least one field')
    }

    const updateKeys = Object.keys(update)
    const convertedUpdate = {}

    updateKeys.forEach((updateKey) => {
      switch (updateKey) {
        case '$set':
          convertedUpdate.$set = merge({},
            convertedUpdate.$set,
            update.$set
          )
          break
        case '$inc':
          convertedUpdate.$inc = update.$inc
          break
        default:
          if (updateKey.charAt(0) !== '$') {
            if (!convertedUpdate.$set) {
              convertedUpdate.$set = {}
            }

            convertedUpdate.$set[updateKey] = update[updateKey]
          }
      }
    })

    if (Object.keys(convertedUpdate).length === 0) {
      throw new Error('update is empty. You must specify at least one field')
    }

    const returnValue = {
      // we need unflatten version for json schema to validate properly
      validate: flatten.unflatten({
        ...convertedUpdate.$set,
        ...convertedUpdate.$inc
      }),
      update: {}
    }

    if (convertedUpdate.$set) {
      returnValue.update.$set = flatten(convertedUpdate.$set)
    }

    if (convertedUpdate.$inc) {
      returnValue.update.$inc = flatten(convertedUpdate.$inc)
    }

    return returnValue
  }

  /**
   * Get adapter based on options given
   *
   * @private
   * @param {object} [options]
   */
  async getAdapter (options = {}) {
    const adapter = typeof this.adapter === 'function' ? this.adapter(options) : this.adapter

    // initialize adapter
    if (!adapter.__initialized) {
      adapter.__initialized = true
      await adapter.init({ schema: this.schema })
    }

    return adapter
  }

  /**
   * Emit event using EventEmitter
   *
   * @private
   * @param {string} eventName
   * @param {object} [data]
   */
  async notify (eventName, data) {
    return new Promise((resolve) => {
      this.emit('*', eventName, data)
      this.emit(eventName, data)
      resolve()
    })
  }

  /**
   * Invokes adapter method
   *
   * @private
   * @param {string} method
   * @param {*} rest
   */
  async invokeAdapterMethod (method, ...rest) {
    // last argument for adapter method is options
    const options = rest.pop()
    const adapter = await this.getAdapter(options)
    if (!adapter[method]) {
      throw new Error(`Adapter provided did not implement ${method}`)
    }

    return adapter[method](...rest, options)
  }

  /**
   * Insert entity
   *
   * @fires Datastore#{name}.created
   * @param {object} entity
   * @param {object} [options]
   * @returns Promise<object>
   */
  async insertOne (entity, options = {}) {
    await this.schema.validate(entity)

    const insertedEntity = await this.invokeAdapterMethod('insertOne',
      entity,
      options
    )

    // adapters return false if not inserted
    if (!insertedEntity) {
      return false
    }

    this.notify(`${this.schema.name}.created`, {
      entities: [insertedEntity]
    })

    return insertedEntity
  }

  /**
   * Insert many entities
   *
   * @fires Datastore#{name}.created
   * @param {array} entities
   * @param {object} [options]
   * @returns Promise<array>
   */
  async insertMany (entities, options = {}) {
    for (let entity of entities) {
      await this.schema.validate(entity)
    }

    const insertedEntities = await this.invokeAdapterMethod('insertMany',
      entities,
      options
    )

    if (!insertedEntities || insertedEntities.length === 0) {
      return false
    }

    this.notify(`${this.schema.name}.created`, {
      entities: insertedEntities
    })

    return insertedEntities
  }

  /**
   * Update entity by id
   *
   * @fires Datastore#{name}.updated
   * @param {String} id
   * @param {Update} update
   * @param {object} [options]
   * @returns Promise<object>
   */
  async updateById (id, update, options = {}) {
    const convertedUpdate = this.convertUpdate(update)
    await this.schema.validate(convertedUpdate.validate, true)

    const updatedEntity = await this.invokeAdapterMethod('updateById',
      id,
      convertedUpdate.update,
      options
    )

    if (!updatedEntity) {
      return false
    }

    this.notify(`${this.schema.name}.updated`, {
      entities: [updatedEntity]
    })

    return updatedEntity
  }

  /**
   * Delete entity by id
   *
   * @fires Datastore#{name}.deleted
   * @param {string} id
   * @param {object} [options]
   * @returns Promise<string>
   */
  async deleteById (id, options = {}) {
    const deletedId = await this.invokeAdapterMethod('deleteById', id, options)

    if (!deletedId) {
      return false
    }

    this.notify(`${this.schema.name}.deleted`, {
      ids: [deletedId]
    })

    return deletedId
  }

  /**
   * Delete entities by ids
   *
   * @fires Datastore#{name}.deleted
   * @param {array} ids
   * @param {object} [options]
   * @returns Promise<array>
   */
  async deleteByIds (ids, options = {}) {
    // deletedIds !== ids because some might not exist
    const deletedIds = await this.invokeAdapterMethod('deleteByIds',
      ids,
      options
    )

    if (!deletedIds || deletedIds.length === 0) {
      return false
    }

    this.notify(`${this.schema.name}.deleted`, {
      ids: deletedIds
    })

    return deletedIds
  }

  /**
   * Find entity by id
   *
   * @param {string} id
   * @param {object} [options]
   * @returns Promise<object>
   */
  async findById (id, options = {}) {
    return this.invokeAdapterMethod('findById', id, options)
  }

  /**
   * Find entities by ids
   *
   * @param {array} ids
   * @param {object} [options]
   * @returns Promise<array>
   */
  async findByIds (ids, options = {}) {
    return this.invokeAdapterMethod('findByIds', ids, options)
  }

  /**
   * Find one entity by filter
   *
   * @param {FilterOptions} filter
   * @param {*} [options]
   * @returns Promise<object>
   */
  async findOne (filter, options = {}) {
    return this.invokeAdapterMethod('findOne', filterQuery(filter), options)
  }

  /**
   * Find all entities by filter
   *
   * @param {FilterOptions} filter
   * @param {object} [options]
   * @returns Promise<array>
   */
  async find (filter, options = {}) {
    return this.invokeAdapterMethod('find', filterQuery(filter), options)
  }

  /**
   * Count entities by filter
   *
   * @param {object} filter
   * @param {object} [options]
   * @returns Promise<number>
   */
  async count (filter, options = {}) {
    return this.invokeAdapterMethod('count', filterQuery(filter), options)
  }

  /**
   * @param {Datastore~transactionCallback} cb
   */
  async transaction (cb) {
    return this.invokeAdapterMethod('transaction', cb)
  }

  async raw () {
    return this.invokeAdapterMethod('raw')
  }
}
