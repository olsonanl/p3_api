const http = require('http')
const https = require('https')
const { withUserAgent } = require('../lib/userAgent')

module.exports = {
  // Like httpRequest, but resolves { statusCode, body } instead of just the body.
  //
  // Every other helper here throws away res.statusCode, so a caller cannot tell a
  // 500 from a 200 — it just gets the response body as a string. Callers that
  // JSON.parse the result then store an error object where rows should be, and the
  // failure is invisible: the outer request returns HTTP 200 with a body that looks
  // structurally plausible. See routes/multiQuery.js for the case this was added for.
  //
  // Added rather than changing httpRequest's resolve shape, because that helper has
  // four other call sites that expect a bare string.
  'httpRequestWithStatus': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: rawData })
        })
        res.on('error', (err) => {
          reject(new Error(`Unable to receive a response. ${err.code || err}`))
        })
      })
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err.code || err}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpGet': async (options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      http.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on('error', (err) => {
          reject(err)
        })
      })
        .on('error', (err) => {
          reject(new Error(`Unable to request the database. ${err.code}`))
        })
    })
  },
  'httpsGet': async (options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      https.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on('error', (err) => {
          reject(err)
        })
      })
        .on('error', (err) => {
          reject(new Error(`Unable to request the database. ${err.code}`))
        })
    })
  },
    'requestUrlForUrl': (url) => {
	const parsed = new URL(url);
	return parsed.protocol === "http:" ? module.exports.httpRequestUrl : module.exports.httpsRequestUrl;
    },
	
  'httpRequest': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpsRequest': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpStreamRequest': async (options, streamableBody) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        reject(err)
      })
    })
  },
  'httpsStreamRequest': async (options, streamableBody) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        reject(err)
      })
    })
  },
  'httpsGetUrl': async (url, options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      https.get(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on('error', (err) => {
          reject(err)
        })
      })
        .on('error', (err) => {
          reject(new Error(`Unable to request the database. ${err.code}`))
        })
    })
  },
  'httpsRequestUrl': async (url, options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.write(body)
	req.end()
    })
  },
  'httpRequestUrl': async (url, options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    return new Promise((resolve, reject) => {
      const req = http.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.write(body)
      req.end()
    })
  }
}
