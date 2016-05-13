var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var bodyParser = require("body-parser");
var debug = require('debug')('p3api-server:dataroute');
var httpParams = require("../middleware/http-params");
var authMiddleware = require("../middleware/auth");
var querystring = require("querystring");
var archiver = require('archiver');

router.use(httpParams);
router.use(authMiddleware);


router.get("*", [
	function(req,res,next){
		var url = req.url;
		if (url.match(/^\/\?/)){
			url = url.replace(/^\/\?/,"");
		}
		var query = querystring.parse(url);
		console.log("QUERY PARSE: ", query);
		if (query.types){
			req.bundleTypes = query.types.split(",")||[]

		}else{
			req.bundleTypes = [];
		}

		if (query.query || query.q){
			req.query = query.query || query.q;
		}

		req.sourceDataType = req.params.dataType;

		next();
	}
]);

router.post("*", [
	bodyParser.urlencoded(),
	function(req,res,next){
		console.log("req.body: ", req.body);

		if (req.body.types){
			req.bundleTypes = req.body.types.split(",")||[]

		}else{
			req.bundleTypes = [];
		}

		if (req.body.query || req.body.q){
			req.query = req.body.query || req.body.q;
		}

		req.sourceDataType = req.params.dataType;
		next();
	}
])

router.use(function(req,res,next){
	debug("req content-type", req.get("content-type"));
	debug("req.query", req.query);
	debug("req.bundleTypes", req.bundleTypes);
	debug("req.sourceDataType: ", req.sourceDataType);
	next();
});

router.use([
	function(req,res,next){
		if (!req.sourceDataType){
			return next(new Error("Source Data Type Missing"));
		}

		if (!req.query){
			return next (new Error("Missing Source Query"));
		}


		if (!req.bundleTypes || req.bundleTypes.length<1){
			return next (new Error("Missing Bundled Types"));
		}
		next();
	},
	function(req,res,next){
		console.log("Load Bundler for: ", req.sourceDataType);
		var bundler;
		try {
			bundler = require("../bundler/" + req.sourceDataType)
			console.log("Bundler: ", bundler)
			bundler(req,res,next);
		} catch(err){
			return next(new Error("Invalid Source Data Type" + err))			
		}

	},
	function(req,res,next){
		console.log("Bundler Map: ", req.bulkMap)
		if (!req.bulkMap){
			console.log("No Bulk Map Found");
			next("route");
		}

		var archOpts = {}
		var type;

		switch(req.headers.accept){
			case "application/x-tar":
				type="tar";
				archOpts.gzip=true;
				res.attachment('PATRIC_Export.tgz');
				break;
			case "application/x-zip":
			default: 
				type="zip"
   			    res.attachment('PATRIC_Export.zip');

		}

		archive = archiver.create(type,archOpts);
		archive.pipe(res);
		archive.bulk(req.bulkMap);
		archive.finalize();
	}
])

module.exports = router;
