var restify = require('restify');
var unirest = require('unirest');
var stats = { 'message' : 'pending' };

var Status = {
  servers: [
    "dallas.api.bukget.org", 
    "paris.api.bukget.org"
  ],

  codes: {
    "pl": "Listing",
    "plb": "Listing (Bukkit)",
    "pd": "Detail (Full)",
    "pdl": "Detail (Latest Only)",
    "pdr": "Detail (Latest Release)",
    "pdb": "Detail (Latest Beta)",
    "pda": "Detail (Latest Alpha)",
    "cl": "Category List",
    "cpl": "Category Plugin List",
    "al": "Author List",
    "apl": "Author Plugin List",
    "se": "Search"
  },

  versions: {
    "v3": {
      "pl": "/3/plugins",
      "plb": "/3/plugins/bukkit",
      "pd": "/3/plugins/bukkit/pvp-arena",
      "pdl": "/3/plugins/bukkit/pvp-arena/latest",
      "pdr": "/3/plugins/bukkit/pvp-arena/release",
      "pdb": "/3/plugins/bukkit/pvp-arena/beta",
      "pda": "/3/plugins/bukkit/pvp-arena/alpha",
      "cl": "/3/categories",
      "cpl": "/3/categories/Admin Tools",
      "al": "/3/authors",
      "apl": "/3/authors/NuclearW",
      "se": "/3/search/versions.type/=/Alpha?sort=-popularity.daily"
    },

    "v2": {
      "plb": "/2/bukkit/plugins",
      "pd": "/2/bukkit/plugin/pvp-arena",
      "pdl": "/2/bukkit/plugin/pvp-arena/latest",
      "cl": "/2/categories",
      "cpl": "/2/bukkit/category/Admin Tools",
      "al": "/2/authors",
      "apl": "/2/bukkit/author/NuclearW",
      "se": "/2/search/version/type/=/Alpha?sort=-popularity.daily"
    },

    "v1": {
      "pl": "/1/plugins",
      "pd": "/1/plugin/pvp-arena",
      "pdl": "/1/plugin/pvp-arena/latest",
      "cl": "/1/categories",
      "cpl": "/1/categories/Admin Tools",
      "al": "/1/authors",
      "apl": "/1/author/NuclearW",
      "se": "/1/search/slug/like/pvp-arena"
    }
  }
};

Status.call = function (server, uri, callback) {
  var url = "http://" + server + uri;

	unirest.get(url).headers({ 'User-Agent': 'BukGet-Monitor' }).timeout(20000).end(function (response) {
		if (response.error) {
			return callback(false, response.error);
		}

		return callback(true);
	});
};

Status.check = function () {
  for (var server in Status.servers) {
  	(function request (server) {
		  for (var version in Status.versions) {
		    (function request (version) {
		      var sections = Status.versions[version];
		      var errors = 0;
		      var called = 0;
		      var length = Object.keys(sections).length;

		      for (var section in sections) {
		        (function request (section) {
		          var code = Status.codes[section];
		          var path = sections[section];

		          return Status.call(server, path, function (status, error) {
		            called++;
		            errors += (error == 'ETIMEDOUT' || !status ? 1 : 0);
		            stats[server][version][section] = (error == 'ETIMEDOUT' ? 'warning' : (status ? 'ok' : 'down'));
		            if (called === length && version === 'v3') {
		              var status = "ok";

		              if (errors > 3) {
		                status = "down";
		              } else if (errors) {
		                status = "warning";
		              }

		              stats.message = status;
		            }

		            return;
		          });
		        })(section);
		      }
		    })(version);
		  }
		})(Status.servers[server]);
	}

  return;
};

for (var server in Status.servers) {
	stats[Status.servers[server]] = {};
	for (var version in Status.versions) {
		stats[Status.servers[server]][version] = {};
	}
}

Status.check();

setInterval(function() {
	Status.check();
}, 1000 * 60);

setInterval(function() {
	unirest.get('http://bukget-monitor.herokuapp.com').end(function (response) {});
}, 1000 * 60 * 20);


var app = restify.createServer();

app.use(restify.jsonp());

app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', function (req, res, next) {
	res.send(stats);
});

app.listen(process.env.PORT || 5000);