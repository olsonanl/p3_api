var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var SolrQueryParser = require("../middleware/SolrQueryParser");
var RQLQueryParser = require("../middleware/RQLQueryParser");
var authMiddleware = require("../middleware/auth");
var solrjs = require("solrjs");
var media = require("../middleware/media");
var httpParams = require("../middleware/http-params");
var SOLR_URL=config.get("solr").url;
var bodyParser = require("body-parser");
var rql = require("solrjs/rql");
var debug = require('debug')('p3api-server:dataroute');
var Expander= require("../ExpandingQuery");

var rqlToSolr = function(req, res, next) {
	debug("RQLQueryParser", req.queryType);
	if (req.queryType=="rql"){
		req.call_params[0] = req.call_params[0] || "";
		when(Expander.ResolveQuery(req.call_params[0],{req:req,res:res}), function(q){
			console.log("Resolved Query: ", q);
			if (q=="()") { q = ""; }
			req.call_params[0] = rql(q).toSolr({maxRequestLimit: 250}) 
			console.log("Converted Solr Query: ", req.call_params[0]);
			req.queryType="solr";
			next();
		});
	}else{
		next();
	}
}

var querySOLR = function(req, res, next) {
		if (req.call_method!="query"){ next(); }

		var query = req.call_params[0];
		console.log("querySOLR req.params", req.call_params[0]);
		var solr = new solrjs(SOLR_URL + "/" + req.call_collection);

		when(solr.query(query), function(results) {
			console.log("querySOLR results", results);
			if (!results || !results.response){
				res.results=[];
				res.set("Content-Range", "items 0-0/0");
			}else{
				res.results = results;

				res.set("Content-Range", "items " + (results.response.start || 0) + "-" + ((results.response.start||0)+results.response.docs.length) + "/" + results.response.numFound);
			}

				next();
		})
}
var getSOLR = function(req, res, next) {
		var solr = new solrjs(SOLR_URL + "/" + req.call_collection);
		when(solr.get(req.call_params[0]), function(results) {
			res.results = results;
			next();
		});
}

var decorateQuery = function(req, res, next) {
	if (req.call_method !="query"){ return next(); }

	debug("decorateQuery", req.solr_query);
	req.call_params[0] = req.call_params[0] || "&q=*:*";

	if (!req.user) {
		req.call_params[0] = req.call_params[0] + "&fq=public:true"
	}
	else {
		req.call_params[0]= req.call_params[0] + ("&fq=(public:true OR owner:" + req.user + " OR user_read:" + req.user + ")");
	}

	next();
}

var methodHandler  = function(req, res, next) {
	debug("MethodHandler", req.call_method, req.call_params);
	switch(req.call_method) {
		case "query": 
			return querySOLR(req,res,next);
			break;
		case "get":
			return getSOLR(req,res,next)
	}
}

router.use(httpParams);

router.use(authMiddleware);

router.use(function(req,res,next){
	debug("req.path", req.path);
	debug("req content-type", req.get("content-type"));
	debug("accept", req.get("accept"));
	debug("req.url", req.url);
	debug('req.path', req.path);
	debug('req.params:', JSON.stringify(req.params));
	next();
});


router.get("*", function(req,res,next){
	if (req.path=="/"){
		req.call_method = "query";
		var ctype = req.get('content-type');

		debug("ctype: ", ctype);

		if (!ctype){ ctype = req.headers['content-type'] = "applicaton/x-www-form-urlencoded"}

		if (ctype == "application/solrquery+x-www-form-urlencoded"){
			req.queryType = "solr";
		}else{
			req.queryType = "rql";
		}
		debug('req.queryType: ', req.queryType)
		req.call_params = [req._parsedUrl.query||""];
		req.call_collection = req.params.dataType;
	}else{
		if (req.params[0]){
			req.params[0] = req.params[0].substr(1);
			var ids = decodeURIComponent(req.params[0]).split(",");
			if (ids.length == 1) { ids=ids[0]}
		}
		req.call_method = "get";
		req.call_params = [ids];
		req.call_collection = req.params.dataType;
	}

	next();
})


router.post("*", [
	bodyParser.json({type:["application/jsonrpc+json"]}),
	bodyParser.json({type:["application/json"]}),
	function(req,res,next){
		debug("json req._body", req._body);
		if (!req._body || !req.body) { next(); return }
		var ctype=req.get("content-type");
		if (req.body.jsonrpc || (ctype=="application/jsonrpc+json")){
			debug("JSON RPC Request", JSON.stringify(req.body,null,4));	
			if (!req.body.method){
				throw Error("Invalid Method");
			}
			req.call_method=req.body.method;
			req.call_params = req.body.params;
			req.call_collection = req.params.dataType;
		}else{
			debug("JSON POST Request", JSON.stringify(req.body,null,4));
			req.call_method="post";
			req.call_params = [req.body];
			req.call_collection = req.params.dataType;
		}
		next("route");
	},
	bodyParser.text({type:"application/rqlquery+x-www-form-urlencoded"}),
	bodyParser.text({type:"application/solrquery+x-www-form-urlencoded"}),
	bodyParser.urlencoded(),
	function(req,res,next){
		console.log("POST: ", req.body,req);
		if (!req._body || !req.body) { next("route"); return }
		var ctype=req.get("content-type");	
		req.call_method="query";
		req.call_params = req.body;
		req.call_collection = req.params.dataType;
		req.queryType = (ctype=="application/solrquery+x-www-form-urlencoded")?"solr":"rql";
		next();
	}
])

var maxLimit=250;

router.use([
	rqlToSolr,
	decorateQuery,
	function(req,res,next){
		if (req.call_method!="query") { return next(); }
		var limit = maxLimit;
		var q = req.call_params[0];
		var re = /(&rows=)(\d*)/;
		var matches = q.match(re);

		if (matches && matches[2] && (matches[2]>maxLimit)){
			limit=maxLimit
		}else{
			limit=matches[2];
		}
		if (req.headers.range) {
			var range = req.headers.range.match(/^items=(\d+)-(\d+)?$/);
			if (range){
				start = range[1] || 0;
				end = range[2] || maxLimit;
				var l = end - start;
				if (l>maxLimit){
					limit=maxLimit;
				}

				var queryOffset=start;
			}
		}


		if (matches){
			req.call_params[0]= q.replace(matches[0],"&rows="+limit);
		}else{
			req.call_params[0] = req.call_params[0] + "&rows=" + limit;
		}

		if (queryOffset) {
			re = /(&start=)(\d+)/;
			var offsetMatches = q.match(re);
			if (!offsetMatches){
				req.call_params[0] = req.call_params[0] + "&start=" + queryOffset;
			}
		}

		next();
	},
	function(req,res,next){
		if (!req.call_method || !req.call_collection) { return next("route"); }
		debug("req.call_method: ", req.call_method);
		debug('req.call_params: ', req.call_params);
		debug('req.call_collection: ', req.call_collection);

		if (req.call_method=="query"){
			debug('req.queryType: ', req.queryType);
		}
		next();
	},
	methodHandler,
	media
	// function(req,res,next){
	// 	res.write(JSON.stringify(res.results,null,4));
	// 	res.end();
	// }
])




// router.post("/:dataType/rpc", function(req,res,next){ 
// 	debug("Handle RPC Calls");
// 	next()
// } );

// router.use("/:dataType/query*", function(req,res,next){ req.action="query"; next(); } );

// router.use("/:dataType/query/rql",RQLQueryParser)
// router.use("/:dataType/query/rql",RQLQueryParser)

// router.use("/:dataType/query*",[SolrQueryParser, decorateQuery]);
// router.use("/:dataType/query*",[SolrQueryParser, decorateQuery]);

// router.param(":ids", function(req, res, next, ids) {
// 	req.params.ids = ids.split(",");
// 	debug("router.params :ids", req.params.ids);
// 	next();
// })

// router.get('/:dataType/get/:ids', function(req, res, next) {req.action="get"; debug("req.params: ", req.params); next()});

// router.use(methodHandler);

// router.get("/:dataType/query/rql",function(req,res,next){
// 	debug("Transform RQL Queried Results Here");
// 	next()
// })
// router.post("/:dataType/query/rql",function(req,res,next){
// 	debug("Transform RQL Queried Results Here");
// 	next()
// })

// router.use("/:dataType/*", [
// 	function(req,res,next){
// 		res.type("json");
// 		res.write(JSON.stringify(res.results,null,4))
// 		res.end();
// 	}
// ])

module.exports = router;