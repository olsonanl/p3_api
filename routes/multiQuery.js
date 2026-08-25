const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const BodyParser = require('body-parser')
const debug = require('debug')('p3api-server:route/multiQuery')
const HttpParamsMiddleware = require('../middleware/http-params')
const AuthMiddleware = require('../middleware/auth')
const { httpRequestWithStatus } = require('../util/http')
const Config = require('../config')

// Run one sub-query and return its parsed rows.
//
// Throws on any non-2xx status or unparsable body. That matters: the previous
// implementation used a helper that discards res.statusCode and resolves the body
// string regardless, then JSON.parse'd it straight into the caller's result slot. A
// sub-query that 500'd therefore produced
//
//   { "query1": { "result": { "status": 500, "message": "A Database Error Occured" } } }
//
// inside an outer HTTP 200 — the website rendered a partial or empty panel with no
// indication anything had failed. Measured at 3,274 500s over a 36h window, with the
// slow log showing outer 200s paired with inner 500s at the same millisecond.
async function subQuery (dataType, query, opts) {
  const { statusCode, body } = await httpRequestWithStatus({
    port: Config.get('http_port'),
    headers: {
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      Accept: opts.accept || 'application/json',
      Authorization: opts.authorization || ''
    },
    method: 'POST',
    path: `/${dataType}`
  }, query)

  if (statusCode < 200 || statusCode >= 300) {
    // Prefer the API's own {status, message} error body when present; fall back to a
    // truncated snippet so an HTML error page does not end up in the response.
    let detail = ''
    try {
      const parsed = JSON.parse(body)
      detail = (parsed && parsed.message) ? `: ${parsed.message}` : ''
    } catch (e) {
      detail = body ? `: ${String(body).slice(0, 200)}` : ''
    }
    const err = new Error(`sub-query on ${dataType} failed with HTTP ${statusCode}${detail}`)
    err.statusCode = statusCode
    throw err
  }

  try {
    return JSON.parse(body)
  } catch (e) {
    throw new Error(`sub-query on ${dataType} returned an unparsable response`)
  }
}

Router.use(HttpParamsMiddleware)
Router.use(AuthMiddleware)

Router.post('*', [
  BodyParser.json({ extended: true }),
  function (req, res, next) {
    debug('req.body: ', req.body)
    const defs = []
    res.results = {}

    Object.keys(req.body).forEach(function (qlabel) {
      var qobj = req.body[qlabel]
      res.results[qlabel] = {}

      defs.push(subQuery(qobj.dataType, qobj.query, {
        accept: qobj.accept,
        authorization: (req.headers && req.headers['authorization']) ? req.headers['authorization'] : ''
      }).then(function (result) {
        debug('RES: ', qlabel, Array.isArray(result) ? result.length : typeof result)
        res.results[qlabel].result = result
      }, function (err) {
        // Report the failure on that label instead of rejecting the whole batch.
        //
        // Promise.all would be wrong here now that subQuery rejects on non-2xx: one
        // failing panel would take down every other panel in the same request, which
        // is a worse regression than the bug being fixed. Each label is independent,
        // so each reports independently — successful sub-queries still return their
        // rows, and a failed one carries an explicit `error` instead of an error
        // object sitting where the caller expects rows.
        console.error(`[${(new Date()).toISOString()}] multiQuery ${qlabel} (${qobj.dataType}) failed: ${err.message} rid=${req.requestId || '-'}`)
        res.results[qlabel].error = err.message
        if (err.statusCode) {
          res.results[qlabel].status = err.statusCode
        }
      }))
    })

    // Every promise above settles (the rejection handler above absorbs failures), so
    // this resolves once all sub-queries have finished either way.
    Promise.all(defs).then(() => {
      next()
    }, (err) => {
      next(err)
    })
  },

  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = Router
