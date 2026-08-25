/**
 * multiQuery sub-query error propagation.
 *
 * Guards the fix for a silent-200 bug: `util/http.js`'s `httpRequest` discards
 * `res.statusCode` and resolves the response body regardless, so multiQuery used to
 * `JSON.parse` a 500's error body straight into the caller's result slot, producing
 *
 *   { "query1": { "result": { "status": 500, "message": "A Database Error Occured" } } }
 *
 * inside an outer HTTP 200. The website rendered an empty panel with no sign of failure.
 *
 * This suite is self-contained: it stands up a stub of the inner `/:dataType/` endpoint
 * and points the router at it via the `http_port` env var (nconf's `env()` store is
 * consulted before `file()`, so this overrides p3api.conf). No live API, Solr, or Redis.
 *
 * The load-bearing assertion is the negative one — that a failed sub-query does NOT get
 * an array-shaped `result`. Asserting only on the presence of `error` would still pass
 * if the old parse-into-result behavior came back alongside it.
 */
const assert = require('chai').assert
const express = require('express')
const http = require('http')

describe('multiQuery - sub-query error propagation', function () {
  let innerServer, outerServer, outerPort, savedPort

  before(function (done) {
    savedPort = process.env.http_port

    // Stub the inner endpoint multiQuery self-calls: one success, one JSON 500,
    // one non-JSON 502 (an HTML error page from a proxy).
    const inner = express()
    inner.post('/genome', (req, res) =>
      res.json([{ genome_id: '83332.12', genome_name: 'Mycobacterium tuberculosis H37Rv' }]))
    inner.post('/genome_feature', (req, res) =>
      res.status(500).json({ status: 500, message: 'A Database Error Occured' }))
    inner.post('/pathway', (req, res) => {
      res.status(502)
      res.end('<html>bad gateway</html>')
    })

    innerServer = inner.listen(0, '127.0.0.1', () => {
      process.env.http_port = String(innerServer.address().port)

      // Require AFTER setting the env var: config.js resolves at module load.
      delete require.cache[require.resolve('../../config')]
      delete require.cache[require.resolve('../../routes/multiQuery')]
      const Router = require('../../routes/multiQuery')

      const app = express()
      app.use('/query', Router)
      outerServer = app.listen(0, '127.0.0.1', () => {
        outerPort = outerServer.address().port
        done()
      })
    })
  })

  after(function () {
    if (innerServer) innerServer.close()
    if (outerServer) outerServer.close()
    if (savedPort === undefined) delete process.env.http_port
    else process.env.http_port = savedPort
  })

  function postMulti (payloadObj) {
    const payload = JSON.stringify(payloadObj)
    return new Promise((resolve, reject) => {
      const req = http.request({
        port: outerPort,
        method: 'POST',
        path: '/query/',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) })
          } catch (e) {
            reject(new Error(`unparsable outer response: ${body}`))
          }
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('returns rows for a sub-query that succeeds', async function () {
    const { body } = await postMulti({
      ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)' }
    })
    assert.isArray(body.ok.result)
    assert.lengthOf(body.ok.result, 1)
    assert.equal(body.ok.result[0].genome_id, '83332.12')
    assert.isUndefined(body.ok.error)
  })

  it('reports an error instead of storing the error body as the result', async function () {
    const { body } = await postMulti({
      failing: { dataType: 'genome_feature', query: 'eq(genome_id,83332.12)' }
    })

    // The regression guard: the old code put {status,message} here.
    assert.isUndefined(body.failing.result,
      'a failed sub-query must not produce a `result` (this was the silent-200 bug)')

    assert.isString(body.failing.error)
    assert.include(body.failing.error, 'HTTP 500')
    assert.include(body.failing.error, 'A Database Error Occured',
      'the upstream message should be surfaced, not swallowed')
    assert.equal(body.failing.status, 500)
  })

  it('handles a non-JSON error body without crashing', async function () {
    const { body } = await postMulti({
      html: { dataType: 'pathway', query: 'eq(genome_id,83332.12)' }
    })
    assert.isUndefined(body.html.result)
    assert.include(body.html.error, 'HTTP 502')
    assert.equal(body.html.status, 502)
  })

  it('does not let one failing sub-query take down the others', async function () {
    // Promise.all would reject the whole batch on the first failure, which would be a
    // worse regression than the bug being fixed. Each label must settle independently.
    const { statusCode, body } = await postMulti({
      ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)' },
      failing: { dataType: 'genome_feature', query: 'eq(genome_id,83332.12)' },
      html: { dataType: 'pathway', query: 'eq(genome_id,83332.12)' }
    })

    assert.equal(statusCode, 200)
    assert.isArray(body.ok.result, 'the healthy panel still returns its rows')
    assert.lengthOf(body.ok.result, 1)
    assert.isUndefined(body.failing.result)
    assert.isString(body.failing.error)
    assert.isUndefined(body.html.result)
    assert.isString(body.html.error)
  })
})
