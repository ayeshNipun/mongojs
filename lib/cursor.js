var util = require('util')
var thunky = require('thunky')
var Readable = require('readable-stream').Readable

try {
  var hooks = require('async_hooks')
} catch (err) {}

var Cursor = function (getCursor) {
  Readable.call(this, {objectMode: true, highWaterMark: 0})

  this._opts = {}

  var self = this

  this._destroyed = false
  this._hook = hooks && new hooks.AsyncResource('mongojs:cursor')
  this._get = thunky(function (cb) {
    getCursor(function (err, cursor) {
      if (err) { return cb(err) }

      // Apply all opts
      for (var key in self._opts) {
        if (self._opts.hasOwnProperty(key)) {
          cursor = cursor[key](self._opts[key])
        }
      }

      cb(null, cursor)
    })
  })
}

util.inherits(Cursor, Readable)

Cursor.prototype.next = function (cb) {
  if (this._hook) cb = wrapHook(this, cb)

  var self = this

  this._get(function (err, cursor) {
    if (err) return cb(err)

    if (cursor.cursorState.dead || cursor.cursorState.killed) {
      destroy(self)
      return cb(null, null)
    } else {
      cursor.next(cb)
    }
  })

  return this
}

Cursor.prototype.rewind = function (cb) {
  if (this._hook) cb = wrapHook(this, cb)

  this._get(function (err, cursor) {
    if (err) return cb(err)
    cursor.rewind(cb)
  })

  return this
}

Cursor.prototype.toArray = function (cb) {
  var array = []
  var self = this

  var loop = function () {
    self.next(function (err, obj) {
      if (err) return cb(err)
      if (!obj) return cb(null, array)
      array.push(obj)

      // Fix for #270 RangeError: Maximum call stack size exceeded using Collection.find
      setImmediate(loop)
    })
  }

  loop()
}

Cursor.prototype.map = function (mapfn, cb) {
  var array = []
  var self = this

  var loop = function () {
    self.next(function (err, obj) {
      if (err) return cb(err)
      if (!obj) return cb(null, array)
      array.push(mapfn(obj))

      // Fix for #270 RangeError: Maximum call stack size exceeded using Collection.find
      setImmediate(loop)
    })
  }

  loop()
}

Cursor.prototype.forEach = function (fn) {
  var self = this

  var loop = function () {
    self.next(function (err, obj) {
      if (err) return fn(err)
      fn(err, obj)

      if (!obj) return

      // Fix for #270 RangeError: Maximum call stack size exceeded using Collection.find
      setImmediate(loop)
    })
  }

  loop()
}

// Missing mongodb cursor methods are addOption, hasNext, itcount, readPref, showDiskLoc
var opts = ['batchSize', 'hint', 'limit', 'maxTimeMS', 'max', 'min', 'skip', 'snapshot', 'sort']

opts.forEach(function (opt) {
  Cursor.prototype[opt] = function (obj, cb) {
    this._opts[opt] = obj
    if (cb) return this.toArray(cb)
    return this
  }
})

Cursor.prototype.count = function (cb) {
  if (this._hook) cb = wrapHook(this, cb)

  var self = this

  this._get(function (err, cursor) {
    if (err) { return cb(err) }
    cursor.count(false, self.opts, cb)
  })
}

Cursor.prototype.size = function (cb) {
  if (this._hook) cb = wrapHook(this, cb)

  var self = this

  this._get(function (err, cursor) {
    if (err) { return cb(err) }
    cursor.count(true, self.opts, cb)
  })
}

Cursor.prototype.explain = function (cb) {
  if (this._hook) cb = wrapHook(this, cb)

  this._get(function (err, cursor) {
    if (err) { return cb(err) }
    cursor.explain(cb)
  })
}

Cursor.prototype.destroy = function () {
  var self = this
  this._get(function (err, cursor) {
    if (err) return done(err)
    if (cursor.close) {
      cursor.close(done)
    }
  })

  function done (err) {
    if (err) { self.emit('error', err) }
    destroy(self)
  }
}

Cursor.prototype._read = function () {
  var self = this
  this.next(function (err, data) {
    if (err) return self.emit('error', err)
    self.push(data)
  })
}

module.exports = Cursor

function destroy (self) {
  if (self._destroyed) return
  self._destroyed = true
  if (self._hook) self._hook.emitDestroy()
}

function runInAsyncScope (self, cb, err, val) {
  if (self._hook.runInAsyncScope) {
    self._hook.runInAsyncScope(cb, null, err, val)
  } else {
    self._hook.emitBefore()
    cb(err, val)
    self._hook.emitAfter()
  }
}

function wrapHook (self, cb) {
  return function (err, val) {
    runInAsyncScope(self, cb, err, val)
  }
}
